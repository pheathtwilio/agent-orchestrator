import type {
  TaskNode,
  TaskStore,
  TaskResult,
} from "@composio/ao-message-bus";
import type {
  ExecutionPlan,
  PlannerEvent,
  WorkflowStepSnapshot,
  AgentSkill,
  ModelTier,
} from "./types.js";
import { modelTierToId } from "./skill-classifier.js";

// ============================================================================
// STEP FAILURE HANDLER
// ============================================================================

/**
 * Parameters required to spawn a new agent session.
 * Mirrors the shape used in PlannerDeps.spawnSession.
 */
export interface SpawnParams {
  projectId: string;
  taskId: string;
  prompt: string;
  branch: string;
  model: string;
  skill: AgentSkill;
  dockerImage: string;
  environment: Record<string, string>;
}

/** Callbacks the failure handler needs from the planner. */
export interface FailureHandlerCallbacks {
  spawnSession: (params: SpawnParams) => Promise<string>;
  killSession: (sessionId: string) => Promise<void>;
  emitEvent: (event: PlannerEvent) => void;
  taskStore: TaskStore;
}

/**
 * Module-level retry counter.
 * Key: `${planId}-${taskId}`, Value: number of retries attempted.
 */
const retryCounts = new Map<string, number>();

/** Reset retry state (exposed for testing). */
export function _resetRetryCounts(): void {
  retryCounts.clear();
}

/**
 * Handle a task failure according to the workflow step's failure policy.
 *
 * This function is called when a task within a workflow step fails. The
 * step's `failure_policy.action` determines the recovery strategy.
 */
export async function handleStepFailure(
  plan: ExecutionPlan,
  taskId: string,
  error: string,
  step: WorkflowStepSnapshot,
  callbacks: FailureHandlerCallbacks,
): Promise<void> {
  const action = step.failure_policy.action;

  switch (action) {
    case "spawn_doctor":
      await spawnDoctor(plan, taskId, error, step, callbacks);
      break;

    case "retry":
      await retryTask(plan, taskId, step, callbacks);
      break;

    case "fail_plan":
      await failPlan(plan, taskId, error, callbacks);
      break;

    case "skip":
      await skipTask(plan, taskId, callbacks);
      break;

    case "notify":
      notifyFailure(plan, taskId, error, callbacks);
      break;

    default: {
      // Unknown action — fall through to fail_plan as a safety net.
      await failPlan(plan, taskId, error, callbacks);
    }
  }
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

async function spawnDoctor(
  plan: ExecutionPlan,
  taskId: string,
  error: string,
  step: WorkflowStepSnapshot,
  callbacks: FailureHandlerCallbacks,
): Promise<void> {
  const failedNode = plan.taskGraph.nodes.find((n: TaskNode) => n.id === taskId);
  if (!failedNode) return;

  // Don't spawn a doctor for another doctor.
  if (taskId.startsWith("doctor-")) return;

  const doctorNodeId = `doctor-${taskId}`;
  const branch = failedNode.branch ?? `feat/${plan.id}/${taskId.replace(/\./g, "-")}`;

  const modelTier = (step.agent_config.model_tier || "sonnet") as ModelTier;
  const modelId = modelTierToId(modelTier);
  const skill: AgentSkill = "doctor";

  const doctorPrompt = [
    "# Doctor Agent — Diagnose and Fix",
    "",
    "## Context",
    `A previous agent working on task "${failedNode.title}" has failed.`,
    "Your job is to investigate why and fix the underlying issue so the task can succeed on retry.",
    "",
    "## Failed Task Details",
    `- Task: ${failedNode.title}`,
    `- Description: ${failedNode.description}`,
    `- Branch: ${branch}`,
    `- Error: ${error}`,
    "",
    "## Instructions",
    `1. Check out branch \`${branch}\` and examine the current state`,
    "2. Investigate the error and identify the root cause",
    "3. Apply fixes to resolve the issue",
    "4. Run tests to verify the fix",
    "5. Commit your fixes and push",
    "6. Report TASK_COMPLETE with a summary of what you found and fixed",
    "7. If the issue is unfixable, report TASK_FAILED explaining why",
    "",
    "## Feature Context",
    `This is part of: ${plan.featureDescription}`,
  ].join("\n");

  // Determine docker image: use step config or fall back to a default.
  const dockerImage = step.agent_config.docker_image ?? "ao-agent-frontend:latest";

  const doctorNode: TaskNode = {
    id: doctorNodeId,
    title: `Doctor: ${failedNode.title}`,
    description: `Diagnosing and fixing failure: ${error}`,
    acceptanceCriteria: [],
    fileBoundary: failedNode.fileBoundary,
    status: "in_progress",
    assignedTo: null,
    model: modelId,
    skill,
    dependsOn: [],
    branch,
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workflowStepIndex: failedNode.workflowStepIndex,
  };

  try {
    const sessionId = await callbacks.spawnSession({
      projectId: plan.projectId,
      taskId: doctorNodeId,
      prompt: doctorPrompt,
      branch,
      model: modelId,
      skill,
      dockerImage,
      environment: {
        AO_PLAN_ID: plan.id,
        AO_TASK_ID: doctorNodeId,
        AO_MODEL: modelId,
        AO_SKILL: skill,
      },
    });

    doctorNode.assignedTo = sessionId;
    await callbacks.taskStore.addNode(plan.taskGraph.id, doctorNode);
    plan.taskGraph.nodes.push(doctorNode);

    plan.activeSessions.set(doctorNodeId, sessionId);

    callbacks.emitEvent({
      type: "doctor_started",
      planId: plan.id,
      taskId: doctorNodeId,
      sessionId,
      detail: `Spawned doctor agent to fix task ${taskId}: ${error}`,
      timestamp: Date.now(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.emitEvent({
      type: "doctor_failed",
      planId: plan.id,
      taskId: doctorNodeId,
      detail: `Failed to spawn doctor agent: ${msg}`,
      timestamp: Date.now(),
    });
  }
}

async function retryTask(
  plan: ExecutionPlan,
  taskId: string,
  step: WorkflowStepSnapshot,
  callbacks: FailureHandlerCallbacks,
): Promise<void> {
  const maxRetries = step.failure_policy.max_retries ?? 1;
  const key = `${plan.id}-${taskId}`;
  const count = retryCounts.get(key) ?? 0;

  if (count < maxRetries) {
    retryCounts.set(key, count + 1);

    // Reset the task to pending so the scheduler picks it up again.
    const node = plan.taskGraph.nodes.find((n: TaskNode) => n.id === taskId);
    if (node) {
      node.status = "pending";
      node.assignedTo = null;
      node.updatedAt = Date.now();
    }
    await callbacks.taskStore.updateTask(plan.taskGraph.id, taskId, {
      status: "pending",
      assignedTo: null,
    });

    callbacks.emitEvent({
      type: "task_reassigned",
      planId: plan.id,
      taskId,
      detail: `Retrying task (attempt ${count + 1}/${maxRetries})`,
      timestamp: Date.now(),
    });
  } else {
    // Retries exhausted — fall through to fail_plan.
    await failPlan(plan, taskId, `Exceeded ${maxRetries} retries`, callbacks);
  }
}

async function failPlan(
  plan: ExecutionPlan,
  taskId: string,
  error: string,
  callbacks: FailureHandlerCallbacks,
): Promise<void> {
  plan.phase = "failed";
  plan.updatedAt = Date.now();

  callbacks.emitEvent({
    type: "plan_failed",
    planId: plan.id,
    taskId,
    detail: `Plan failed due to task ${taskId}: ${error}`,
    timestamp: Date.now(),
  });

  // Kill all active sessions.
  const killPromises: Promise<void>[] = [];
  for (const [nodeId, sessionId] of plan.activeSessions) {
    if (nodeId !== taskId) {
      killPromises.push(
        callbacks.killSession(sessionId).catch(() => {
          // Best-effort cleanup — don't let kill failures propagate.
        }),
      );
    }
  }
  await Promise.all(killPromises);
}

async function skipTask(
  plan: ExecutionPlan,
  taskId: string,
  callbacks: FailureHandlerCallbacks,
): Promise<void> {
  const node = plan.taskGraph.nodes.find((n: TaskNode) => n.id === taskId);

  const skipResult: TaskResult = {
    taskId,
    sessionId: node?.assignedTo ?? "",
    status: "complete",
    branch: node?.branch ?? "",
    commits: [],
    summary: "Task skipped due to failure policy",
  };

  if (node) {
    node.status = "complete";
    node.result = skipResult;
    node.updatedAt = Date.now();
  }

  await callbacks.taskStore.updateTask(plan.taskGraph.id, taskId, {
    status: "complete",
    result: skipResult,
  });

  callbacks.emitEvent({
    type: "task_complete",
    planId: plan.id,
    taskId,
    detail: `Task skipped (failure policy: skip)`,
    timestamp: Date.now(),
  });
}

function notifyFailure(
  plan: ExecutionPlan,
  taskId: string,
  error: string,
  callbacks: FailureHandlerCallbacks,
): void {
  callbacks.emitEvent({
    type: "step_failed",
    planId: plan.id,
    taskId,
    detail: `Task ${taskId} failed (notify only): ${error}`,
    timestamp: Date.now(),
  });
  // Don't change task state — the caller decides what to do next.
}
