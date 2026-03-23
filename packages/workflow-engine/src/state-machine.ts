import type {
  PlanState,
  TaskState,
  StepState,
  EngineEvent,
  Effect,
  TransitionResult,
  PlanPhase,
  EngineTaskStatus,
  WorkflowStepSnapshot,
} from "./types.js";
import { buildPlannerPrompt } from "./planner-prompt.js";

// ============================================================================
// HELPERS
// ============================================================================

const TERMINAL_PLAN_PHASES: ReadonlySet<PlanPhase> = new Set([
  "complete",
  "failed",
  "cancelled",
]);

const TERMINAL_TASK_STATUSES: ReadonlySet<EngineTaskStatus> = new Set([
  "complete",
  "failed",
]);

export function containerName(planId: string, taskId: string): string {
  return `ao--${planId}--${taskId}`;
}

export function createInitialState(planId: string): PlanState {
  return {
    planId,
    projectId: "",
    featureDescription: "",
    phase: "created",
    currentStepIndex: 0,
    workflowId: "",
    workflowVersionId: "",
    workflowSnapshot: [],
    tasks: new Map(),
    steps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function cloneState(state: PlanState): PlanState {
  return {
    ...state,
    tasks: new Map(state.tasks),
    steps: state.steps.map((s) => ({ ...s })),
    workflowSnapshot: [...state.workflowSnapshot],
  };
}

function readyTasksForStep(
  state: PlanState,
  stepIndex: number,
): TaskState[] {
  const ready: TaskState[] = [];
  for (const task of state.tasks.values()) {
    if (task.stepIndex !== stepIndex) continue;
    if (task.status !== "pending") continue;
    const allDepsMet = task.dependsOn.every((depId) => {
      const dep = state.tasks.get(depId);
      return dep != null && dep.status === "complete";
    });
    if (allDepsMet) ready.push(task);
  }
  return ready;
}

function spawnEffectsForTasks(
  state: PlanState,
  tasks: TaskState[],
): Effect[] {
  const effects: Effect[] = [];
  for (const task of tasks) {
    effects.push({
      type: "ACQUIRE_LOCKS",
      planId: state.planId,
      taskId: task.id,
      files: task.fileBoundary,
    });
    effects.push({
      type: "SPAWN_CONTAINER",
      planId: state.planId,
      taskId: task.id,
      config: {
        containerName: containerName(state.planId, task.id),
        projectId: state.projectId,
        prompt: task.description,
        branch: task.branch ?? `plan/${state.planId}/${task.id}`,
        model: task.model,
        skill: task.skill,
        dockerImage: task.dockerImage,
        environment: { AO_PLAN_ID: state.planId, AO_TASK_ID: task.id },
      },
    });
  }
  return effects;
}

function allCurrentStepTasksComplete(state: PlanState): boolean {
  for (const task of state.tasks.values()) {
    if (task.stepIndex !== state.currentStepIndex) continue;
    if (task.status !== "complete") return false;
  }
  return true;
}

function getRunningContainerIds(state: PlanState): string[] {
  const ids: string[] = [];
  for (const task of state.tasks.values()) {
    if (
      (task.status === "running" || task.status === "spawning") &&
      task.containerId
    ) {
      ids.push(task.containerId);
    }
  }
  return ids;
}

function killAllEffects(state: PlanState): Effect[] {
  const effects: Effect[] = [];
  for (const task of state.tasks.values()) {
    if (
      (task.status === "running" || task.status === "spawning") &&
      task.containerId
    ) {
      effects.push({
        type: "KILL_CONTAINER",
        planId: state.planId,
        taskId: task.id,
        containerId: task.containerId,
      });
    }
  }
  return effects;
}

function cleanupEffect(state: PlanState): Effect {
  const resources: { type: "container" | "worktree" | "branch"; id: string }[] = [];
  for (const task of state.tasks.values()) {
    if (task.containerId) {
      resources.push({ type: "container", id: task.containerId });
    }
    if (task.branch) {
      resources.push({ type: "worktree", id: task.branch });
      resources.push({ type: "branch", id: task.branch });
    }
  }
  return { type: "CLEANUP", planId: state.planId, resources };
}

function applyFailurePolicy(
  state: PlanState,
  task: TaskState,
  error: string,
): { state: PlanState; effects: Effect[] } {
  const stepSnapshot = state.workflowSnapshot[task.stepIndex];
  const policy = stepSnapshot?.failure_policy;

  if (!policy) {
    // No policy — fail the plan
    state.phase = "failed";
    state.updatedAt = Date.now();
    return { state, effects: [...killAllEffects(state), cleanupEffect(state)] };
  }

  switch (policy.action) {
    case "spawn_doctor": {
      // Set task to doctoring status
      const t = state.tasks.get(task.id)!;
      t.status = "doctoring";
      state.tasks.set(task.id, t);

      const doctorId = `doctor-${task.id}`;
      const doctorTask: TaskState = {
        id: doctorId,
        status: "pending",
        containerId: null,
        sessionId: null,
        branch: task.branch,
        result: null,
        error: null,
        stepIndex: task.stepIndex,
        retryCount: 0,
        doctorTaskId: null,
        healingTaskId: task.id,
        taskType: "doctor",
        title: `Doctor for ${task.title}`,
        description: `Diagnose and fix: ${error}`,
        acceptanceCriteria: [],
        fileBoundary: task.fileBoundary,
        dependsOn: [],
        model: task.model,
        skill: task.skill,
        dockerImage: task.dockerImage,
      };

      // Link original task to its doctor
      t.doctorTaskId = doctorId;
      state.tasks.set(task.id, t);
      state.tasks.set(doctorId, doctorTask);

      const effects = spawnEffectsForTasks(state, [doctorTask]);
      return { state, effects };
    }

    case "retry": {
      const maxRetries = policy.max_retries ?? 3;
      const t = state.tasks.get(task.id)!;
      if (t.retryCount < maxRetries) {
        t.status = "pending";
        t.retryCount += 1;
        t.error = null;
        t.containerId = null;
        t.sessionId = null;
        state.tasks.set(task.id, t);
        // Immediately try to spawn if deps are met
        const readyTasks = readyTasksForStep(state, task.stepIndex);
        return { state, effects: spawnEffectsForTasks(state, readyTasks) };
      }
      // Exhausted retries — fail plan
      t.status = "failed";
      t.error = error;
      state.tasks.set(task.id, t);
      state.phase = "failed";
      return { state, effects: [...killAllEffects(state), cleanupEffect(state)] };
    }

    case "fail_plan": {
      state.phase = "failed";
      return { state, effects: [...killAllEffects(state), cleanupEffect(state)] };
    }

    case "skip": {
      // Task stays failed, plan continues
      return { state, effects: [] };
    }

    case "notify": {
      return {
        state,
        effects: [
          {
            type: "EMIT_EVENT",
            eventType: "task_failed",
            planId: state.planId,
            taskId: task.id,
            detail: error,
          },
        ],
      };
    }

    default:
      return { state, effects: [] };
  }
}

// ============================================================================
// TRANSITION FUNCTION
// ============================================================================

export function transition(
  state: PlanState,
  event: EngineEvent,
  now: number = Date.now(),
): TransitionResult {
  const nextState = cloneState(state);
  nextState.updatedAt = now;

  // Guard: ignore events for terminal plan states
  if (TERMINAL_PLAN_PHASES.has(nextState.phase)) {
    return { nextState: state, effects: [] };
  }

  switch (event.type) {
    // ========================================================================
    // PLAN LIFECYCLE
    // ========================================================================

    case "PLAN_CREATED": {
      if (nextState.phase !== "created") {
        return { nextState: state, effects: [] };
      }

      nextState.phase = "planning";
      nextState.projectId = event.projectId;
      nextState.featureDescription = event.featureDescription;
      nextState.workflowId = event.workflowId;
      nextState.workflowVersionId = event.workflowVersionId;
      nextState.workflowSnapshot = event.workflowSnapshot;

      // Create steps from workflow snapshot
      nextState.steps = event.workflowSnapshot.map((snap, i) => ({
        index: i,
        name: snap.name,
        status: "pending" as const,
        snapshot: snap,
      }));

      // Create planner task
      const plannerTaskId = "planner";
      const plannerTask: TaskState = {
        id: plannerTaskId,
        status: "spawning",
        containerId: null,
        sessionId: null,
        branch: null,
        result: null,
        error: null,
        stepIndex: -1,
        retryCount: 0,
        doctorTaskId: null,
        healingTaskId: null,
        taskType: "planner",
        title: "Planning",
        description: event.featureDescription,
        acceptanceCriteria: [],
        fileBoundary: [],
        dependsOn: [],
        model: "opus",
        skill: "planner",
        dockerImage: "",
        };
      nextState.tasks.set(plannerTaskId, plannerTask);

      const effects: Effect[] = [
        {
          type: "UPDATE_PLAN",
          planId: event.planId,
          phase: "planning",
        },
        {
          type: "UPDATE_TASK",
          planId: event.planId,
          taskId: plannerTaskId,
          status: "spawning",
        },
        {
          type: "SPAWN_CONTAINER",
          planId: event.planId,
          taskId: plannerTaskId,
          config: {
            containerName: containerName(event.planId, plannerTaskId),
            projectId: event.projectId,
            prompt: buildPlannerPrompt(
              event.featureDescription,
              event.workflowSnapshot,
              event.planId,
            ),
            branch: "",
            model: "opus",
            skill: "planner",
            dockerImage: "",
            environment: { AO_PLAN_ID: event.planId, AO_TASK_ID: plannerTaskId },
          },
        },
      ];

      return { nextState, effects };
    }

    case "PLAN_APPROVED": {
      if (nextState.phase !== "reviewing") {
        return { nextState: state, effects: [] };
      }

      nextState.phase = "executing";

      // Activate step 0
      if (nextState.steps.length > 0) {
        nextState.steps[0].status = "active";
      }

      // Spawn ready tasks for step 0
      const ready = readyTasksForStep(nextState, 0);
      const spawnEffects = spawnEffectsForTasks(nextState, ready);

      // Mark spawned tasks as spawning
      for (const task of ready) {
        const t = nextState.tasks.get(task.id)!;
        t.status = "spawning";
        nextState.tasks.set(task.id, t);
      }

      const effects: Effect[] = [
        { type: "UPDATE_PLAN", planId: event.planId, phase: "executing" },
        ...spawnEffects,
      ];

      return { nextState, effects };
    }

    case "PLAN_CANCELLED": {
      nextState.phase = "cancelled";
      const effects: Effect[] = [
        ...killAllEffects(nextState),
        cleanupEffect(nextState),
      ];
      return { nextState, effects };
    }

    case "CLEANUP_DONE": {
      if (nextState.phase !== "completing") {
        return { nextState: state, effects: [] };
      }
      nextState.phase = "complete";
      return {
        nextState,
        effects: [
          {
            type: "EMIT_EVENT",
            eventType: "plan_complete",
            planId: event.planId,
            detail: "Plan completed successfully",
          },
        ],
      };
    }

    case "MERGE_FAILED": {
      nextState.phase = "failed";
      return {
        nextState,
        effects: [
          {
            type: "UPDATE_PLAN",
            planId: event.planId,
            phase: "failed",
          },
          {
            type: "EMIT_EVENT",
            eventType: "merge_failed",
            planId: event.planId,
            detail: event.error,
          },
        ],
      };
    }

    // ========================================================================
    // STEP ADVANCEMENT
    // ========================================================================

    case "STEP_COMPLETE": {
      if (nextState.phase !== "executing") {
        return { nextState: state, effects: [] };
      }

      // Mark current step as complete
      const completedStep = nextState.steps[event.stepIndex];
      if (completedStep) {
        completedStep.status = "complete";
      }

      const nextStepIndex = event.stepIndex + 1;

      if (nextStepIndex < nextState.steps.length) {
        // More steps: advance
        nextState.currentStepIndex = nextStepIndex;
        nextState.steps[nextStepIndex].status = "active";

        const ready = readyTasksForStep(nextState, nextStepIndex);
        const effects = spawnEffectsForTasks(nextState, ready);

        for (const task of ready) {
          const t = nextState.tasks.get(task.id)!;
          t.status = "spawning";
          nextState.tasks.set(task.id, t);
        }

        return { nextState, effects };
      } else {
        // No more steps: completing
        nextState.phase = "completing";

        // Collect all completed branches
        const branches: string[] = [];
        for (const task of nextState.tasks.values()) {
          if (task.status === "complete" && task.branch) {
            branches.push(task.branch);
          }
        }

        const effects: Effect[] = [
          { type: "MERGE_PRS", planId: state.planId, branches },
          cleanupEffect(nextState),
        ];

        return { nextState, effects };
      }
    }

    // ========================================================================
    // TASK LIFECYCLE
    // ========================================================================

    case "DEPS_MET": {
      const task = nextState.tasks.get(event.taskId);
      if (!task || task.status !== "pending") {
        return { nextState: state, effects: [] };
      }

      task.status = "spawning";
      nextState.tasks.set(event.taskId, task);

      const effects = spawnEffectsForTasks(nextState, [task]);
      return { nextState, effects };
    }

    case "CONTAINER_READY": {
      const task = nextState.tasks.get(event.taskId);
      if (!task || task.status !== "spawning") {
        return { nextState: state, effects: [] };
      }

      task.status = "running";
      task.containerId = containerName(state.planId, event.taskId);
      task.sessionId = event.sessionId;
      nextState.tasks.set(event.taskId, task);

      return {
        nextState,
        effects: [
          {
            type: "UPDATE_TASK",
            planId: event.planId,
            taskId: event.taskId,
            status: "running",
          },
        ],
      };
    }

    case "SPAWN_FAILED": {
      const task = nextState.tasks.get(event.taskId);
      if (!task || task.status !== "spawning") {
        return { nextState: state, effects: [] };
      }

      task.status = "failed";
      task.error = event.error;
      nextState.tasks.set(event.taskId, task);

      const result = applyFailurePolicy(nextState, task, event.error);
      return { nextState: result.state, effects: result.effects };
    }

    case "TASK_COMPLETE": {
      const task = nextState.tasks.get(event.taskId);
      if (!task) {
        return { nextState: state, effects: [] };
      }

      // Guard: ignore if task is in terminal state
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        return { nextState: state, effects: [] };
      }

      // --- Planner completion ---
      if (task.taskType === "planner") {
        if (nextState.phase !== "planning") {
          return { nextState: state, effects: [] };
        }

        task.status = "complete";
        task.result = event.payload;
        nextState.tasks.set(event.taskId, task);
        nextState.phase = "reviewing";

        // Parse tasks from the planner output
        const rawTasks = Array.isArray(event.payload?.tasks) ? event.payload.tasks : [];
        const populatedTasks: TaskState[] = rawTasks.map((t: Record<string, unknown>) => ({
          id: String(t.id ?? ""),
          status: "pending" as const,
          containerId: null,
          sessionId: null,
          branch: t.branch ? String(t.branch) : null,
          result: null,
          error: null,
          stepIndex: typeof t.stepIndex === "number" ? t.stepIndex : 0,
          retryCount: 0,
          doctorTaskId: null,
          healingTaskId: null,
          taskType: "implementation" as const,
          title: String(t.title ?? t.id ?? ""),
          description: String(t.description ?? ""),
          acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(String) : [],
          fileBoundary: Array.isArray(t.fileBoundary) ? t.fileBoundary.map(String) : [],
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
          model: String(t.model ?? "sonnet"),
          skill: String(t.skill ?? "fullstack"),
          dockerImage: String(t.dockerImage ?? ""),
        }));

        // Add tasks to state
        for (const pt of populatedTasks) {
          nextState.tasks.set(pt.id, pt);
        }

        const effects: Effect[] = [
          {
            type: "UPDATE_PLAN",
            planId: event.planId,
            phase: "reviewing",
          },
          {
            type: "UPDATE_TASK",
            planId: event.planId,
            taskId: event.taskId,
            status: "complete",
            result: event.payload,
          },
          {
            type: "POPULATE_TASKS",
            planId: event.planId,
            tasks: populatedTasks,
          },
        ];

        // Kill planner container
        if (task.containerId) {
          effects.push({
            type: "KILL_CONTAINER",
            planId: event.planId,
            taskId: event.taskId,
            containerId: task.containerId,
          });
        }

        // Auto-approve if tasks were populated
        if (populatedTasks.length > 0) {
          effects.push({
            type: "FEED_EVENT",
            event: { type: "PLAN_APPROVED", planId: event.planId },
          });
        }

        return { nextState, effects };
      }

      // --- Doctor completion ---
      if (task.taskType === "doctor" && task.healingTaskId) {
        task.status = "complete";
        task.result = event.payload;
        nextState.tasks.set(event.taskId, task);

        // Reset healed task to pending
        const healedTask = nextState.tasks.get(task.healingTaskId);
        if (healedTask) {
          healedTask.status = "pending";
          healedTask.error = null;
          healedTask.containerId = null;
          healedTask.sessionId = null;
          healedTask.doctorTaskId = null;
          nextState.tasks.set(task.healingTaskId, healedTask);
        }

        const effects: Effect[] = [
          {
            type: "UPDATE_TASK",
            planId: event.planId,
            taskId: event.taskId,
            status: "complete",
            result: event.payload,
          },
          {
            type: "RELEASE_LOCKS",
            planId: event.planId,
            taskId: event.taskId,
          },
        ];

        return { nextState, effects };
      }

      // --- Normal task completion ---
      task.status = "complete";
      task.result = event.payload;
      nextState.tasks.set(event.taskId, task);

      const effects: Effect[] = [
        {
          type: "UPDATE_TASK",
          planId: event.planId,
          taskId: event.taskId,
          status: "complete",
          result: event.payload,
        },
      ];

      // Kill container if it had one
      if (task.containerId) {
        effects.push({
          type: "KILL_CONTAINER",
          planId: event.planId,
          taskId: event.taskId,
          containerId: task.containerId,
        });
      }

      // Release locks
      effects.push({
        type: "RELEASE_LOCKS",
        planId: event.planId,
        taskId: event.taskId,
      });

      // Check if all tasks at current step are complete
      if (
        nextState.phase === "executing" &&
        task.stepIndex === nextState.currentStepIndex &&
        allCurrentStepTasksComplete(nextState)
      ) {
        effects.push({
          type: "FEED_EVENT",
          event: {
            type: "STEP_COMPLETE",
            planId: event.planId,
            stepIndex: nextState.currentStepIndex,
          },
        });
      }

      return { nextState, effects };
    }

    case "TASK_FAILED": {
      const task = nextState.tasks.get(event.taskId);
      if (!task) {
        return { nextState: state, effects: [] };
      }

      // Guard: ignore if task is in terminal state
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        return { nextState: state, effects: [] };
      }

      // Planner failure
      if (task.taskType === "planner") {
        if (nextState.phase !== "planning") {
          return { nextState: state, effects: [] };
        }

        task.status = "failed";
        task.error = event.error;
        nextState.tasks.set(event.taskId, task);
        nextState.phase = "failed";

        return {
          nextState,
          effects: [cleanupEffect(nextState)],
        };
      }

      // Normal task failure
      task.status = "failed";
      task.error = event.error;
      nextState.tasks.set(event.taskId, task);

      const effects: Effect[] = [
        {
          type: "UPDATE_TASK",
          planId: event.planId,
          taskId: event.taskId,
          status: "failed",
          error: event.error,
        },
      ];

      // Kill container if it had one
      if (task.containerId) {
        effects.push({
          type: "KILL_CONTAINER",
          planId: event.planId,
          taskId: event.taskId,
          containerId: task.containerId,
        });
      }

      // Release locks
      effects.push({
        type: "RELEASE_LOCKS",
        planId: event.planId,
        taskId: event.taskId,
      });

      const result = applyFailurePolicy(nextState, task, event.error);
      return {
        nextState: result.state,
        effects: [...effects, ...result.effects],
      };
    }

    case "CONTAINER_DIED": {
      const task = nextState.tasks.get(event.taskId);
      if (!task || task.status !== "running") {
        return { nextState: state, effects: [] };
      }

      task.status = "failed";
      task.error = "Container died unexpectedly";
      nextState.tasks.set(event.taskId, task);

      const effects: Effect[] = [
        {
          type: "UPDATE_TASK",
          planId: event.planId,
          taskId: event.taskId,
          status: "failed",
          error: "Container died unexpectedly",
        },
        {
          type: "RELEASE_LOCKS",
          planId: event.planId,
          taskId: event.taskId,
        },
      ];

      const result = applyFailurePolicy(nextState, task, "Container died unexpectedly");
      return {
        nextState: result.state,
        effects: [...effects, ...result.effects],
      };
    }

    case "HEARTBEAT_TIMEOUT": {
      const task = nextState.tasks.get(event.taskId);
      if (!task || task.status !== "running") {
        return { nextState: state, effects: [] };
      }

      task.status = "failed";
      task.error = "Heartbeat timeout";
      nextState.tasks.set(event.taskId, task);

      const effects: Effect[] = [];

      if (task.containerId) {
        effects.push({
          type: "KILL_CONTAINER",
          planId: event.planId,
          taskId: event.taskId,
          containerId: task.containerId,
        });
      }

      effects.push({
        type: "RELEASE_LOCKS",
        planId: event.planId,
        taskId: event.taskId,
      });

      const result = applyFailurePolicy(nextState, task, "Heartbeat timeout");
      return {
        nextState: result.state,
        effects: [...effects, ...result.effects],
      };
    }

    // This event is not in our EngineEvent union but handle unknown gracefully
    default: {
      return { nextState: state, effects: [] };
    }
  }
}
