/**
 * Plan cleanup utilities.
 *
 * The plan execution logic has moved to the WorkflowEngine package.
 * This file retains only the cleanup/housekeeping functionality that
 * runs server-side Docker/git commands directly (not through agents).
 */

import {
  createTaskStore,
  type TaskNode,
} from "@composio/ao-message-bus";
import {
  runHousekeeping,
  type CleanupResult,
  type CleanupConfig,
} from "@composio/ao-planner";
import { getServices } from "./services";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ============================================================================
// CLEANUP PLAN
// ============================================================================

export interface CleanupPlanOptions {
  project?: string;
  containers: boolean;
  worktrees: boolean;
  branches: boolean;
  maxPlanAgeDays: number;
}

export interface CleanupPlanResult {
  planId: string;
  title: string;
  taskCount: number;
}

/**
 * Create a cleanup plan that appears in the dashboard.
 *
 * Unlike implementation plans, this doesn't decompose via AI or spawn
 * agent containers. Instead it creates a task graph with fixed cleanup
 * steps and executes them directly, updating task status as it goes.
 */
export async function createAndExecuteCleanupPlan(
  opts: CleanupPlanOptions,
): Promise<CleanupPlanResult> {
  const { config } = await getServices();
  const projectId = opts.project ?? Object.keys(config.projects)[0];
  if (!projectId) throw new Error("No projects configured");

  const project = config.projects[projectId];
  if (!project) throw new Error(`Project ${projectId} not found`);

  const repoPath = project.path.replace(/^~/, process.env.HOME || "");

  const taskStore = createTaskStore(REDIS_URL);
  const planId = `cleanup-${Date.now().toString(36)}`;

  // Build task nodes for each cleanup step
  const nodes: TaskNode[] = [];
  const taskIds: string[] = [];

  if (opts.containers) {
    taskIds.push("cleanup-containers");
    nodes.push(makeCleanupNode("cleanup-containers", "Remove stopped containers", "Find and remove stopped ao-* Docker containers"));
  }
  if (opts.worktrees) {
    taskIds.push("cleanup-worktrees");
    nodes.push(makeCleanupNode("cleanup-worktrees", "Remove stale worktrees", "Prune broken worktree metadata and remove worktrees from completed plans"));
  }
  if (opts.branches) {
    taskIds.push("cleanup-branches");
    nodes.push(makeCleanupNode("cleanup-branches", "Remove orphan branches", "Delete local and remote plan branches that are no longer active"));
  }
  if (opts.maxPlanAgeDays > 0) {
    taskIds.push("cleanup-old-plans");
    nodes.push(makeCleanupNode("cleanup-old-plans", `Remove plans older than ${opts.maxPlanAgeDays}d`, "Delete completed/failed plans from Redis that are past the retention window"));
  }

  if (nodes.length === 0) {
    throw new Error("No cleanup steps selected");
  }

  // Persist the task graph
  const graph = {
    id: planId,
    featureId: planId,
    title: "Cleanup: containers, worktrees, branches",
    nodes,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await taskStore.createGraph(graph);

  // Execute cleanup steps in the background, updating task status as we go
  const cleanupConfig: Partial<CleanupConfig> = {
    containers: opts.containers,
    worktrees: opts.worktrees,
    branches: opts.branches,
    maxPlanAgeMs: opts.maxPlanAgeDays * 24 * 60 * 60 * 1000,
    dryRun: false,
  };

  // Run async — don't block the API response
  executeCleanupSteps(planId, repoPath, taskStore, taskIds, cleanupConfig).catch(
    (err) => console.error(`[cleanup] Plan ${planId} failed:`, err),
  );

  return {
    planId,
    title: graph.title,
    taskCount: nodes.length,
  };
}

function makeCleanupNode(id: string, title: string, description: string): TaskNode {
  return {
    id,
    title,
    description,
    acceptanceCriteria: [],
    fileBoundary: [],
    status: "pending",
    assignedTo: null,
    model: "system",
    skill: "devops",
    dependsOn: [],
    branch: null,
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function executeCleanupSteps(
  planId: string,
  repoPath: string,
  taskStore: ReturnType<typeof createTaskStore>,
  taskIds: string[],
  cleanupConfig: Partial<CleanupConfig>,
): Promise<void> {
  console.log(`[cleanup] Starting cleanup plan ${planId}`);

  // Mark all tasks as in_progress
  for (const id of taskIds) {
    await taskStore.updateTask(planId, id, { status: "in_progress" });
  }

  // Run the full housekeeping pass
  let result: CleanupResult;
  try {
    result = await runHousekeeping(repoPath, taskStore, cleanupConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const id of taskIds) {
      await taskStore.updateTask(planId, id, {
        status: "failed",
        result: { taskId: id, sessionId: "", status: "failed", branch: "", commits: [], summary: `Cleanup failed: ${msg}`, error: msg },
      });
    }
    return;
  }

  // Update each task with its specific results
  if (taskIds.includes("cleanup-containers")) {
    const count = result.containers.length;
    const errors = result.errors.filter((e) => e.includes("container"));
    await taskStore.updateTask(planId, "cleanup-containers", {
      status: errors.length > 0 ? "failed" : "complete",
      result: {
        taskId: "cleanup-containers",
        sessionId: "",
        status: errors.length > 0 ? "failed" : "complete",
        branch: "",
        commits: [],
        summary: count > 0
          ? `Removed ${count} container(s): ${result.containers.join(", ")}`
          : "No stopped containers found",
        error: errors.length > 0 ? errors.join("; ") : undefined,
      },
    });
  }

  if (taskIds.includes("cleanup-worktrees")) {
    const count = result.worktrees.length;
    const errors = result.errors.filter((e) => e.includes("worktree"));
    await taskStore.updateTask(planId, "cleanup-worktrees", {
      status: errors.length > 0 ? "failed" : "complete",
      result: {
        taskId: "cleanup-worktrees",
        sessionId: "",
        status: errors.length > 0 ? "failed" : "complete",
        branch: "",
        commits: [],
        summary: count > 0
          ? `Removed ${count} worktree(s): ${result.worktrees.map((w) => w.split("/").pop()).join(", ")}`
          : "No stale worktrees found",
        error: errors.length > 0 ? errors.join("; ") : undefined,
      },
    });
  }

  if (taskIds.includes("cleanup-branches")) {
    const localCount = result.branches.local.length;
    const remoteCount = result.branches.remote.length;
    const errors = result.errors.filter((e) => e.includes("branch"));
    await taskStore.updateTask(planId, "cleanup-branches", {
      status: errors.length > 0 ? "failed" : "complete",
      result: {
        taskId: "cleanup-branches",
        sessionId: "",
        status: errors.length > 0 ? "failed" : "complete",
        branch: "",
        commits: [],
        summary: localCount + remoteCount > 0
          ? `Removed ${localCount} local + ${remoteCount} remote branch(es)`
          : "No orphan branches found",
        error: errors.length > 0 ? errors.join("; ") : undefined,
      },
    });
  }

  if (taskIds.includes("cleanup-old-plans")) {
    const count = result.plans.length;
    const errors = result.errors.filter((e) => e.includes("plan"));
    await taskStore.updateTask(planId, "cleanup-old-plans", {
      status: errors.length > 0 ? "failed" : "complete",
      result: {
        taskId: "cleanup-old-plans",
        sessionId: "",
        status: errors.length > 0 ? "failed" : "complete",
        branch: "",
        commits: [],
        summary: count > 0
          ? `Removed ${count} old plan(s): ${result.plans.join(", ")}`
          : "No old plans to remove",
        error: errors.length > 0 ? errors.join("; ") : undefined,
      },
    });
  }

  console.log(
    `[cleanup] Plan ${planId} complete: ` +
    `${result.containers.length} containers, ${result.worktrees.length} worktrees, ` +
    `${result.branches.local.length + result.branches.remote.length} branches, ${result.plans.length} plans`,
  );
}
