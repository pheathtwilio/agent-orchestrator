/**
 * Server-side plan executor — runs plan watch loops in the background.
 *
 * When a plan is created with auto-execute, this spawns agents and
 * handles the message loop (task completion → spawn next tasks).
 * Lives in the Next.js server process alongside the existing services.
 */

import {
  createMessageBus,
  createFileLockRegistry,
  createTaskStore,
  type TaskNode,
} from "@composio/ao-message-bus";
import {
  createPlanner,
  type PlannerEvent,
  runHousekeeping,
  type CleanupResult,
  type CleanupConfig,
} from "@composio/ao-planner";
import { getServices } from "./services";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Check if the Docker daemon is reachable.
 * Throws a user-friendly error if Docker is not running.
 */
async function ensureDockerRunning(): Promise<void> {
  const result = await execShell("docker", ["info"], undefined);
  if (result === null) {
    throw new Error(
      "Docker is not running. Please start Docker Desktop and try again.",
    );
  }
}

// Track running plan watchers — keyed by planId
const activeWatchers = new Map<string, { stop: () => void }>();

// Cache in globalThis for Next.js HMR stability
const globalForExecutor = globalThis as typeof globalThis & {
  _aoActiveWatchers?: Map<string, { stop: () => void }>;
  _aoAutoRestartDone?: boolean;
};
if (globalForExecutor._aoActiveWatchers) {
  // Restore from previous HMR cycle
  for (const [k, v] of globalForExecutor._aoActiveWatchers) {
    activeWatchers.set(k, v);
  }
}
globalForExecutor._aoActiveWatchers = activeWatchers;

// Auto-restart watchers for in-progress plans on server startup.
// Only runs once per process (survives HMR via globalThis flag).
// Uses dynamic import to avoid referencing restartAllWatchers before it's defined.
if (!globalForExecutor._aoAutoRestartDone) {
  globalForExecutor._aoAutoRestartDone = true;
  setTimeout(async () => {
    if (activeWatchers.size === 0) {
      console.log("[plan-executor] Auto-restarting watchers for in-progress plans...");
      try {
        // Re-import self to get the fully initialized module
        const mod = await import("./plan-executor");
        await mod.restartAllWatchers({ skipTesting: false, maxConcurrency: 5 });
      } catch (err) {
        console.error("[plan-executor] Auto-restart failed:", err);
      }
    }
  }, 5000);
}

/**
 * Merge all PRs from completed plan tasks, then clean up branches and containers.
 *
 * Uses `gh` CLI directly to find PRs by branch name — the session manager
 * doesn't track PRs created inside agent containers, so we can't rely on
 * session.pr being populated.
 */
async function mergePlanPRs(
  _planId: string,
  taskNodes: TaskNode[],
): Promise<{ merged: number; failed: string[] }> {
  const { config } = await getServices();
  const projectId = Object.keys(config.projects)[0];
  const project = projectId ? config.projects[projectId] : undefined;
  if (!project) return { merged: 0, failed: [] };

  const repoPath = project.path.replace(/^~/, process.env.HOME || "");
  const repo = project.repo;
  let merged = 0;
  const failed: string[] = [];

  // Collect branches from completed implementation task nodes (not doctor/test/verify)
  const implBranches = taskNodes
    .filter((n) =>
      n.status === "complete" &&
      n.id !== "integration-test" &&
      n.id !== "verify-build" &&
      !n.id.startsWith("doctor-"),
    )
    .map((n) => n.branch)
    .filter((b): b is string => b !== null);

  // All branches (including doctor/test/verify) for cleanup
  const allBranches = taskNodes
    .map((n) => n.branch)
    .filter((b): b is string => b !== null);

  // For each implementation branch, find and merge the corresponding PR via gh CLI
  for (const branch of implBranches) {
    try {
      // Find PR by head branch
      const prJson = await execShell("gh", [
        "pr", "list",
        "--repo", repo,
        "--head", branch,
        "--state", "open",
        "--json", "number",
        "--limit", "1",
      ], repoPath);

      if (!prJson) continue;
      const prs = JSON.parse(prJson) as Array<{ number: number }>;
      if (prs.length === 0) continue;

      const prNumber = prs[0].number;

      // Squash merge with branch deletion
      await execShell("gh", [
        "pr", "merge", String(prNumber),
        "--repo", repo,
        "--squash",
        "--delete-branch",
      ], repoPath);

      merged++;
      console.log(`[plan-executor] Merged PR #${prNumber} from ${branch} (squash)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plan-executor] Failed to merge PR for branch ${branch}: ${msg}`);
      failed.push(branch);
    }
  }

  // Clean up any remaining local and remote branches
  for (const branch of allBranches) {
    try {
      await execShell("git", ["branch", "-D", branch], repoPath);
    } catch {
      // Branch may already be deleted by --delete-branch or never existed locally
    }
    try {
      await execShell("git", ["push", "origin", "--delete", branch], repoPath);
    } catch {
      // Remote branch may already be gone
    }
  }

  // Force-remove agent containers (sessionManager.kill may miss dead containers)
  for (const node of taskNodes) {
    if (!node.assignedTo) continue;
    const containerName = `ao-${node.assignedTo}`;
    try {
      await execShell("docker", ["rm", "-f", containerName], undefined);
    } catch {
      // Container may already be gone
    }
  }

  return { merged, failed };
}

/** Run a shell command and return stdout, or null on failure */
async function execShell(
  cmd: string,
  args: string[],
  cwd: string | undefined,
): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  // Ensure homebrew paths are available
  const env = { ...process.env };
  const path = env.PATH ?? "";
  if (!path.includes("/opt/homebrew/bin")) {
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${path}`;
  }
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: cwd || undefined,
      timeout: 30_000,
      env,
    });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

export interface ExecutePlanOptions {
  project: string;
  description: string;
  skipTesting: boolean;
  maxConcurrency: number;
}

export interface ExecutePlanResult {
  planId: string;
  title: string;
  taskCount: number;
}

/**
 * Create a plan and immediately start executing it in the background.
 * Returns as soon as agents are spawned — the watch loop continues
 * running in the background, handling task completions.
 */
export async function createAndExecutePlan(
  opts: ExecutePlanOptions,
): Promise<ExecutePlanResult> {
  await ensureDockerRunning();
  const { sessionManager } = await getServices();

  const messageBus = createMessageBus(REDIS_URL);
  const fileLocks = createFileLockRegistry(REDIS_URL);
  const taskStore = createTaskStore(REDIS_URL);

  const planner = createPlanner(
    {
      messageBus,
      fileLocks,
      taskStore,
      spawnSession: async (params) => {
        const session = await sessionManager.spawn({
          projectId: params.projectId,
          prompt: params.prompt,
          branch: params.branch,
          runtimeConfig: { image: params.dockerImage },
          environment: {
            ...params.environment,
            AO_SKILL: params.skill,
            AO_MODEL: params.model,
          },
        });
        return session.id;
      },
      killSession: async (sessionId) => {
        await sessionManager.kill(sessionId);
      },
      mergePlanPRs,
    },
    {
      requireApproval: false,
      skipIntegrationTest: opts.skipTesting,
      maxConcurrency: opts.maxConcurrency,
    },
  );

  // Log events server-side
  planner.onEvent((event: PlannerEvent) => {
    console.log(`[plan-executor] ${event.type} plan=${event.planId} ${event.detail}`);
  });

  // Create the plan (this also spawns ready tasks since requireApproval=false)
  const plan = await planner.planFeature(opts.project, opts.description);

  // Start background watch loop for this plan
  startWatchLoop(plan.id, planner, messageBus, taskStore);

  return {
    planId: plan.id,
    title: plan.taskGraph.title,
    taskCount: plan.taskGraph.nodes.length,
  };
}

/**
 * Start a background watch loop that handles agent messages
 * and drives the plan to completion.
 */
function startWatchLoop(
  planId: string,
  planner: ReturnType<typeof createPlanner>,
  messageBus: ReturnType<typeof createMessageBus>,
  taskStore: ReturnType<typeof createTaskStore>,
) {
  // Don't double-watch
  if (activeWatchers.has(planId)) return;

  let stopped = false;

  // Subscribe to orchestrator inbox for messages from agents.
  // Replay from "0" to catch any messages that arrived while no watcher was running
  // (e.g. TASK_COMPLETE sent after a server restart). The planner's handleMessage
  // is idempotent for already-processed tasks (they won't be in activeSessions).
  messageBus.subscribe("orchestrator", async (message) => {
    if (stopped) return;

    const payload = message.payload as Record<string, unknown>;
    if (payload.planId !== planId) return;

    try {
      await planner.handleMessage(message);
    } catch (err) {
      console.error(`[plan-executor] Error handling message for ${planId}:`, err);
    }
  }, "0");

  // Periodic monitor check (stuck agents, deadlocks, orphaned sessions)
  const monitorInterval = setInterval(async () => {
    if (stopped) return;
    try {
      await planner.monitor();

      // Check if plan is done
      const graph = await taskStore.getGraph(planId);
      if (graph) {
        const allDone = graph.nodes.every((n) =>
          ["complete", "failed"].includes(n.status),
        );
        if (allDone) {
          console.log(`[plan-executor] Plan ${planId} finished — stopping watcher`);
          stop();
          return;
        }

        // Detect orphaned sessions: tasks marked in_progress/assigned but
        // the session container no longer exists
        const { sessionManager: sm } = await getServices();
        const activeSessions = await sm.list();
        const aliveIds = new Set(activeSessions.map((s) => s.id));

        for (const node of graph.nodes) {
          if (
            node.assignedTo &&
            ["in_progress", "assigned", "testing"].includes(node.status) &&
            !aliveIds.has(node.assignedTo)
          ) {
            console.log(
              `[plan-executor] Orphaned task ${node.id} — session ${node.assignedTo} no longer exists. Marking failed.`,
            );
            await taskStore.updateTask(planId, node.id, {
              status: "failed",
              assignedTo: null,
            });
          }
        }
      }
    } catch {
      // Non-critical
    }
  }, 30_000);

  function stop() {
    stopped = true;
    clearInterval(monitorInterval);
    messageBus.unsubscribe("orchestrator").catch(() => {});
    // Don't disconnect messageBus/taskStore — they may be shared
    activeWatchers.delete(planId);
  }

  activeWatchers.set(planId, { stop });
}

/** Check if a plan has an active watcher */
export function isPlanWatching(planId: string): boolean {
  return activeWatchers.has(planId);
}

/** Stop watching a plan */
export function stopPlanWatcher(planId: string): void {
  const watcher = activeWatchers.get(planId);
  if (watcher) watcher.stop();
}

/** Get list of currently watched plan IDs */
export function getActiveWatcherIds(): string[] {
  return Array.from(activeWatchers.keys());
}

/**
 * Restart watchers for all in-progress plans.
 * Stops existing watchers and creates fresh planner instances with latest code.
 * Use after deploying code changes to pick up new planner logic.
 */
export async function restartAllWatchers(
  opts: { skipTesting: boolean; maxConcurrency: number },
): Promise<{ restarted: string[]; skipped: string[] }> {
  await ensureDockerRunning();
  const taskStore = createTaskStore(REDIS_URL);
  const restarted: string[] = [];
  const skipped: string[] = [];

  try {
    // Stop all existing watchers
    const currentIds = Array.from(activeWatchers.keys());
    for (const id of currentIds) {
      const watcher = activeWatchers.get(id);
      if (watcher) watcher.stop();
    }

    // Find all plans that are still in progress
    const graphs = await taskStore.listGraphs();
    const archivedSet = await taskStore.listArchivedIds();

    for (const graph of graphs) {
      if (archivedSet.has(graph.id)) continue;

      const hasActive = graph.nodes.some((n) =>
        ["in_progress", "assigned", "testing", "pending"].includes(n.status),
      );
      const allTerminal = graph.nodes.every((n) =>
        ["complete", "failed"].includes(n.status),
      );

      if (allTerminal || !hasActive) {
        skipped.push(graph.id);
        continue;
      }

      // Create fresh planner + watch loop for this plan
      const { sessionManager, config } = await getServices();
      const projectId = Object.keys(config.projects)[0];
      if (!projectId) continue;

      const messageBus = createMessageBus(REDIS_URL);
      const fileLocks = createFileLockRegistry(REDIS_URL);
      const freshTaskStore = createTaskStore(REDIS_URL);

      const planner = createPlanner(
        {
          messageBus,
          fileLocks,
          taskStore: freshTaskStore,
          spawnSession: async (params) => {
            const session = await sessionManager.spawn({
              projectId: params.projectId,
              prompt: params.prompt,
              branch: params.branch,
              runtimeConfig: { image: params.dockerImage },
              environment: {
                ...params.environment,
                AO_SKILL: params.skill,
                AO_MODEL: params.model,
              },
            });
            return session.id;
          },
          killSession: async (sessionId) => {
            await sessionManager.kill(sessionId);
          },
          mergePlanPRs,
        },
        {
          requireApproval: false,
          skipIntegrationTest: opts.skipTesting,
          maxConcurrency: opts.maxConcurrency,
        },
      );

      planner.onEvent((event: PlannerEvent) => {
        console.log(`[plan-executor] ${event.type} plan=${event.planId} ${event.detail}`);
      });

      // Load existing plan state (reconstructs phase, assignments, etc.)
      await planner.loadPlan(graph.id, projectId);

      // Start fresh watch loop with new planner instance
      startWatchLoop(graph.id, planner, messageBus, freshTaskStore);
      restarted.push(graph.id);
    }
  } finally {
    await taskStore.disconnect();
  }

  console.log(
    `[plan-executor] Restarted ${restarted.length} watchers, skipped ${skipped.length} terminal plans`,
  );

  return { restarted, skipped };
}

/**
 * Resume a plan — reset only failed tasks to pending, then spawn ready ones.
 * Preserves completed tasks and their results.
 */
export async function resumePlan(
  planId: string,
  opts: { skipTesting: boolean; maxConcurrency: number; project?: string },
): Promise<{ resumed: string[] }> {
  await ensureDockerRunning();
  const { sessionManager, config } = await getServices();

  const projectId = opts.project ?? Object.keys(config.projects)[0];
  if (!projectId) throw new Error("No projects configured");

  // Stop any existing watcher for this plan
  stopPlanWatcher(planId);

  const messageBus = createMessageBus(REDIS_URL);
  const fileLocks = createFileLockRegistry(REDIS_URL);
  const taskStore = createTaskStore(REDIS_URL);

  const planner = createPlanner(
    {
      messageBus,
      fileLocks,
      taskStore,
      spawnSession: async (params) => {
        const session = await sessionManager.spawn({
          projectId: params.projectId,
          prompt: params.prompt,
          branch: params.branch,
          runtimeConfig: { image: params.dockerImage },
          environment: {
            ...params.environment,
            AO_SKILL: params.skill,
            AO_MODEL: params.model,
          },
        });
        return session.id;
      },
      killSession: async (sessionId) => {
        await sessionManager.kill(sessionId);
      },
      mergePlanPRs,
    },
    {
      requireApproval: false,
      skipIntegrationTest: opts.skipTesting,
      maxConcurrency: opts.maxConcurrency,
    },
  );

  planner.onEvent((event: PlannerEvent) => {
    console.log(`[plan-executor] ${event.type} plan=${event.planId} ${event.detail}`);
  });

  // Load the existing plan state
  await planner.loadPlan(planId, projectId);

  // Resume only the failed tasks
  const result = await planner.resumePlan(planId);

  // Start background watch loop
  startWatchLoop(planId, planner, messageBus, taskStore);

  return result;
}

/**
 * Retry a plan that was cancelled or failed.
 * Expects all tasks to already be reset to "pending".
 * Creates a new planner instance, loads the plan, and spawns agents.
 */
export async function retryPlan(
  planId: string,
  opts: { skipTesting: boolean; maxConcurrency: number; project?: string },
): Promise<void> {
  await ensureDockerRunning();
  const { sessionManager, config } = await getServices();

  // Resolve the project ID — use provided, or fall back to first configured project
  const projectId = opts.project ?? Object.keys(config.projects)[0];
  if (!projectId) throw new Error("No projects configured");

  const messageBus = createMessageBus(REDIS_URL);
  const fileLocks = createFileLockRegistry(REDIS_URL);
  const taskStore = createTaskStore(REDIS_URL);

  const planner = createPlanner(
    {
      messageBus,
      fileLocks,
      taskStore,
      spawnSession: async (params) => {
        const session = await sessionManager.spawn({
          projectId: params.projectId,
          prompt: params.prompt,
          branch: params.branch,
          runtimeConfig: { image: params.dockerImage },
          environment: {
            ...params.environment,
            AO_SKILL: params.skill,
            AO_MODEL: params.model,
          },
        });
        return session.id;
      },
      killSession: async (sessionId) => {
        await sessionManager.kill(sessionId);
      },
      mergePlanPRs,
    },
    {
      requireApproval: false,
      skipIntegrationTest: opts.skipTesting,
      maxConcurrency: opts.maxConcurrency,
    },
  );

  planner.onEvent((event: PlannerEvent) => {
    console.log(`[plan-executor] ${event.type} plan=${event.planId} ${event.detail}`);
  });

  // Load the existing plan from Redis and approve it (spawns ready tasks)
  await planner.loadPlan(planId, projectId);
  await planner.approvePlan(planId);

  // Start background watch loop
  startWatchLoop(planId, planner, messageBus, taskStore);
}

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
    (err) => console.error(`[plan-executor] Cleanup plan ${planId} failed:`, err),
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
  console.log(`[plan-executor] Starting cleanup plan ${planId}`);

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
    `[plan-executor] Cleanup plan ${planId} complete: ` +
    `${result.containers.length} containers, ${result.worktrees.length} worktrees, ` +
    `${result.branches.local.length + result.branches.remote.length} branches, ${result.plans.length} plans`,
  );
}
