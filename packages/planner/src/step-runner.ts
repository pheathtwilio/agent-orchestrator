import type {
  TaskNode,
  TaskStore,
} from "@composio/ao-message-bus";
import type {
  ExecutionPlan,
  PlannerEvent,
  WorkflowStepSnapshot,
  AgentSkill,
  ModelTier,
} from "./types.js";
import { modelTierToId } from "./skill-classifier.js";
import { checkExitCriteria } from "./step-exit-criteria.js";

// ============================================================================
// STEP RUNNER — core workflow step orchestration
// ============================================================================

/** Spawn parameters (same shape as PlannerDeps.spawnSession). */
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

/** Context gathered from tasks in prior workflow steps. */
export interface StepContext {
  branches: string[];
  testResults: string[];
  errorSummaries: string[];
}

/** Condition type — mirrors the web package's StepCondition without a cross-package import. */
export type StepCondition =
  | { type: "previous_step_had_failures" }
  | { type: "previous_step_all_passed" }
  | { type: "step_result_contains"; stepIndex: number; match: string }
  | { type: "always" }
  | { type: "never" };

/** Callbacks the step runner needs from the planner. */
export interface StepRunnerCallbacks {
  taskStore: TaskStore;
  spawnSession: (params: SpawnParams) => Promise<string>;
  killSession: (sessionId: string) => Promise<void>;
  emitEvent: (event: PlannerEvent) => void;
  completePlan: (plan: ExecutionPlan) => Promise<void>;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Evaluate whether the current workflow step's exit criteria are met.
 * If so, advance to the next step (or complete the plan).
 */
export async function evaluateStepCompletion(
  plan: ExecutionPlan,
  callbacks: StepRunnerCallbacks,
): Promise<void> {
  const steps = plan.workflowSnapshot;
  if (!steps || steps.length === 0) return;

  const stepIndex = plan.currentStepIndex ?? 0;
  if (stepIndex >= steps.length) return;

  const currentStep = steps[stepIndex];

  // Gather tasks belonging to the current step.
  const stepTasks = plan.taskGraph.nodes.filter(
    (t: TaskNode) => (t.workflowStepIndex ?? 0) === stepIndex,
  );

  // Check exit criteria.
  const criteria = currentStep.exit_criteria.programmatic;
  if (!checkExitCriteria(criteria, stepTasks)) {
    return; // Not ready to advance.
  }

  // Exit criteria met — emit step_complete and advance.
  callbacks.emitEvent({
    type: "step_complete",
    planId: plan.id,
    detail: `Step ${stepIndex} "${currentStep.name}" completed`,
    timestamp: Date.now(),
  });

  await advanceToNextStep(plan, stepIndex + 1, callbacks);
}

/**
 * Begin execution of a workflow step.
 *
 * For step 0 (implementation), the caller handles task decomposition before
 * calling this. For later steps, this creates a single task node for the
 * step and spawns a session.
 */
export async function beginStep(
  plan: ExecutionPlan,
  step: WorkflowStepSnapshot,
  callbacks: StepRunnerCallbacks,
): Promise<void> {
  const stepIndex = plan.currentStepIndex ?? 0;

  callbacks.emitEvent({
    type: "step_started",
    planId: plan.id,
    detail: `Starting step ${stepIndex}: "${step.name}"`,
    timestamp: Date.now(),
  });

  // For step 0, decomposition is handled by the caller. Only create tasks
  // for subsequent steps.
  if (stepIndex === 0) return;

  // Gather context from prior steps.
  const context = gatherPriorStepContext(plan);

  // Build the task prompt.
  const prompt = buildStepPrompt(plan, step, context);

  // Determine agent config.
  const modelTier = (step.agent_config.model_tier || "sonnet") as ModelTier;
  const modelId = modelTierToId(modelTier);
  const skill = (step.agent_config.skill || "testing") as AgentSkill;
  const dockerImage = step.agent_config.docker_image ?? "ao-agent-frontend:latest";
  const branch = `step-${stepIndex}/${plan.id}`;

  const taskId = `step-${stepIndex}-${step.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  const taskNode: TaskNode = {
    id: taskId,
    title: step.name,
    description: step.description,
    acceptanceCriteria: [],
    fileBoundary: [],
    status: "in_progress",
    assignedTo: null,
    model: modelId,
    skill,
    dependsOn: [],
    branch,
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workflowStepIndex: stepIndex,
  };

  try {
    const sessionId = await callbacks.spawnSession({
      projectId: plan.projectId,
      taskId,
      prompt,
      branch,
      model: modelId,
      skill,
      dockerImage,
      environment: {
        AO_PLAN_ID: plan.id,
        AO_TASK_ID: taskId,
        AO_MODEL: modelId,
        AO_SKILL: skill,
      },
    });

    taskNode.assignedTo = sessionId;
    await callbacks.taskStore.addNode(plan.taskGraph.id, taskNode);
    plan.taskGraph.nodes.push(taskNode);
    plan.activeSessions.set(taskId, sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.emitEvent({
      type: "step_failed",
      planId: plan.id,
      detail: `Failed to start step ${stepIndex} "${step.name}": ${msg}`,
      timestamp: Date.now(),
    });
  }
}

/**
 * Evaluate a conditional step's condition against the current plan state.
 */
export function evaluateCondition(
  condition: StepCondition,
  plan: ExecutionPlan,
): boolean {
  const currentIndex = plan.currentStepIndex ?? 0;

  switch (condition.type) {
    case "always":
      return true;

    case "never":
      return false;

    case "previous_step_had_failures": {
      if (currentIndex === 0) return false;
      const prevTasks = getTasksForStep(plan, currentIndex - 1);
      return prevTasks.some(
        (t: TaskNode) =>
          t.status === "failed" ||
          (t.result?.error != null && t.result.error.length > 0),
      );
    }

    case "previous_step_all_passed": {
      if (currentIndex === 0) return false;
      const prevTasks = getTasksForStep(plan, currentIndex - 1);
      if (prevTasks.length === 0) return true; // vacuously true
      return prevTasks.every(
        (t: TaskNode) =>
          t.status === "complete" &&
          (t.result == null || !t.result.error || t.result.error.length === 0),
      );
    }

    case "step_result_contains": {
      const refTasks = getTasksForStep(plan, condition.stepIndex);
      const match = condition.match.toLowerCase();
      return refTasks.some((t: TaskNode) => {
        const summary = t.result?.summary?.toLowerCase() ?? "";
        return summary.includes(match);
      });
    }

    default:
      return false;
  }
}

/**
 * Gather context from all tasks in steps prior to the current one.
 * Returns branches, test results, and error summaries.
 */
export function gatherPriorStepContext(plan: ExecutionPlan): StepContext {
  const currentIndex = plan.currentStepIndex ?? 0;
  const branches: string[] = [];
  const testResults: string[] = [];
  const errorSummaries: string[] = [];

  for (const node of plan.taskGraph.nodes) {
    const nodeStep = node.workflowStepIndex ?? 0;
    if (nodeStep >= currentIndex) continue;

    if (node.branch) {
      branches.push(node.branch);
    }

    if (node.result) {
      if (node.result.summary) {
        // Categorize: if the task was a testing task, treat as test result.
        if (node.skill === "testing" || node.id.includes("test")) {
          testResults.push(node.result.summary);
        }
      }
      if (node.result.error) {
        errorSummaries.push(`${node.title}: ${node.result.error}`);
      }
    }
  }

  return { branches, testResults, errorSummaries };
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/** Get all tasks assigned to a specific workflow step index. */
function getTasksForStep(plan: ExecutionPlan, stepIndex: number): TaskNode[] {
  return plan.taskGraph.nodes.filter(
    (t: TaskNode) => (t.workflowStepIndex ?? 0) === stepIndex,
  );
}

/**
 * Advance the plan to the given step index.
 * Skips conditional steps whose conditions are not met.
 * Completes the plan if all steps are done.
 */
async function advanceToNextStep(
  plan: ExecutionPlan,
  nextIndex: number,
  callbacks: StepRunnerCallbacks,
): Promise<void> {
  const steps = plan.workflowSnapshot;
  if (!steps) return;

  // Walk forward, skipping conditional steps whose conditions are not met.
  let idx = nextIndex;
  while (idx < steps.length) {
    const step = steps[idx];
    plan.currentStepIndex = idx;
    plan.updatedAt = Date.now();

    if (step.is_conditional && step.condition != null) {
      const conditionMet = evaluateCondition(
        step.condition as StepCondition,
        plan,
      );
      if (!conditionMet) {
        // Skip this conditional step.
        callbacks.emitEvent({
          type: "step_complete",
          planId: plan.id,
          detail: `Skipped conditional step ${idx} "${step.name}" (condition not met)`,
          timestamp: Date.now(),
        });
        idx++;
        continue;
      }
    }

    // Found a step to execute — begin it.
    plan.currentStepIndex = idx;
    plan.updatedAt = Date.now();
    await beginStep(plan, step, callbacks);
    return;
  }

  // All steps exhausted — plan is complete.
  plan.currentStepIndex = idx;
  plan.updatedAt = Date.now();
  await callbacks.completePlan(plan);
}

/**
 * Build a prompt for a non-implementation step, incorporating context
 * from prior steps.
 */
function buildStepPrompt(
  plan: ExecutionPlan,
  step: WorkflowStepSnapshot,
  context: StepContext,
): string {
  const lines: string[] = [
    `# ${step.name}`,
    "",
    `## Feature: ${plan.featureDescription}`,
    "",
    `## Step Description`,
    step.description,
    "",
  ];

  if (context.branches.length > 0) {
    lines.push("## Completed Branches");
    for (const branch of context.branches) {
      lines.push(`- ${branch}`);
    }
    lines.push("");
  }

  if (context.testResults.length > 0) {
    lines.push("## Prior Test Results");
    for (const result of context.testResults) {
      lines.push(`- ${result}`);
    }
    lines.push("");
  }

  if (context.errorSummaries.length > 0) {
    lines.push("## Errors from Prior Steps");
    for (const err of context.errorSummaries) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }

  lines.push("## Instructions");
  lines.push("Complete the step described above and report TASK_COMPLETE when done.");
  lines.push("If you encounter unrecoverable issues, report TASK_FAILED with details.");

  return lines.join("\n");
}
