import { describe, it, expect } from "vitest";
import { transition, createInitialState, containerName } from "../state-machine.js";
import type { PlanState, EngineEvent, TaskState, WorkflowStepSnapshot } from "../types.js";

// ============================================================================
// TEST HELPERS
// ============================================================================

function makePlanState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    planId: "plan-test",
    projectId: "proj-1",
    featureDescription: "Test feature",
    phase: "created",
    currentStepIndex: 0,
    workflowId: "std-dev",
    workflowVersionId: "v1",
    workflowSnapshot: [],
    tasks: new Map(),
    steps: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    status: "pending",
    containerId: null,
    sessionId: null,
    branch: null,
    result: null,
    error: null,
    stepIndex: 0,
    retryCount: 0,
    doctorTaskId: null,
    healingTaskId: null,
    taskType: "implementation",
    title: `Task ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    fileBoundary: [],
    dependsOn: [],
    model: "sonnet",
    skill: "fullstack",
    dockerImage: "ao-agent:latest",
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowStepSnapshot> = {}): WorkflowStepSnapshot {
  return {
    name: "Implement",
    description: "Implement tasks",
    sort_order: 0,
    exit_criteria: { programmatic: ["all_tasks_complete"], description: "All done" },
    failure_policy: { action: "spawn_doctor", max_retries: 2, description: "Doctor heals" },
    agent_config: { skill: "fullstack", model_tier: "sonnet" },
    is_conditional: false,
    condition: null,
    ...overrides,
  };
}

const NOW = 5000;

// ============================================================================
// PLAN LIFECYCLE
// ============================================================================

describe("transition: plan lifecycle", () => {
  it("PLAN_CREATED: created -> decomposing, spawns decomposer", () => {
    const state = makePlanState({ phase: "created" });
    const event: EngineEvent = {
      type: "PLAN_CREATED",
      planId: "plan-test",
      projectId: "proj-1",
      featureDescription: "Build API",
      workflowId: "std-dev",
      workflowVersionId: "v1",
      workflowSnapshot: [makeStep()],
    };

    const { nextState, effects } = transition(state, event, NOW);

    expect(nextState.phase).toBe("decomposing");
    expect(nextState.tasks.has("decomposer")).toBe(true);
    expect(nextState.tasks.get("decomposer")!.taskType).toBe("decomposer");
    expect(nextState.tasks.get("decomposer")!.status).toBe("spawning");
    expect(nextState.steps).toHaveLength(1);
    expect(effects).toContainEqual(
      expect.objectContaining({ type: "SPAWN_CONTAINER", taskId: "decomposer" }),
    );
  });

  it("PLAN_CREATED: ignores if not in created phase", () => {
    const state = makePlanState({ phase: "executing" });
    const event: EngineEvent = {
      type: "PLAN_CREATED",
      planId: "plan-test",
      projectId: "proj-1",
      featureDescription: "Build API",
      workflowId: "std-dev",
      workflowVersionId: "v1",
      workflowSnapshot: [],
    };

    const { nextState, effects } = transition(state, event, NOW);
    expect(nextState.phase).toBe("executing");
    expect(effects).toEqual([]);
  });

  it("PLAN_APPROVED: reviewing -> executing, spawns step 0 tasks", () => {
    const step = makeStep();
    const state = makePlanState({
      phase: "reviewing",
      workflowSnapshot: [step],
      steps: [{ index: 0, name: "Implement", status: "pending", snapshot: step }],
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "pending", stepIndex: 0 })],
        ["1.2", makeTask("1.2", { status: "pending", stepIndex: 0, dependsOn: ["1.1"] })],
      ]),
    });

    const { nextState, effects } = transition(state, { type: "PLAN_APPROVED", planId: "plan-test" }, NOW);

    expect(nextState.phase).toBe("executing");
    expect(nextState.steps[0].status).toBe("active");
    // Only 1.1 is ready (1.2 depends on 1.1)
    expect(nextState.tasks.get("1.1")!.status).toBe("spawning");
    expect(nextState.tasks.get("1.2")!.status).toBe("pending");
    expect(effects.filter((e) => e.type === "SPAWN_CONTAINER")).toHaveLength(1);
  });

  it("PLAN_APPROVED: ignores if not reviewing", () => {
    const state = makePlanState({ phase: "executing" });
    const { nextState, effects } = transition(state, { type: "PLAN_APPROVED", planId: "plan-test" }, NOW);
    expect(nextState.phase).toBe("executing");
    expect(effects).toEqual([]);
  });

  it("CLEANUP_DONE: completing -> complete", () => {
    const state = makePlanState({ phase: "completing" });
    const { nextState, effects } = transition(state, { type: "CLEANUP_DONE", planId: "plan-test" }, NOW);
    expect(nextState.phase).toBe("complete");
    expect(effects).toContainEqual(
      expect.objectContaining({ type: "EMIT_EVENT", eventType: "plan_complete" }),
    );
  });

  it("CLEANUP_DONE: ignores if not completing", () => {
    const state = makePlanState({ phase: "executing" });
    const { nextState } = transition(state, { type: "CLEANUP_DONE", planId: "plan-test" }, NOW);
    expect(nextState.phase).toBe("executing");
  });

  it("MERGE_FAILED: plan -> failed", () => {
    const state = makePlanState({ phase: "completing" });
    const { nextState, effects } = transition(state, { type: "MERGE_FAILED", planId: "plan-test", error: "conflict" }, NOW);
    expect(nextState.phase).toBe("failed");
    expect(effects).toContainEqual(expect.objectContaining({ type: "UPDATE_PLAN", phase: "failed" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "EMIT_EVENT", eventType: "merge_failed" }));
  });
});

// ============================================================================
// PLANNER COMPLETION
// ============================================================================

describe("transition: decomposer completion", () => {
  it("decomposer TASK_COMPLETE with no tasks: decomposing -> reviewing, no auto-approve", () => {
    const decomposerTask = makeTask("decomposer", { taskType: "decomposer", status: "running", stepIndex: -1 });
    const state = makePlanState({
      phase: "decomposing",
      tasks: new Map([["decomposer", decomposerTask]]),
    });

    const event: EngineEvent = {
      type: "TASK_COMPLETE",
      planId: "plan-test",
      taskId: "decomposer",
      payload: { tasks: [] },
    };

    const { nextState, effects } = transition(state, event, NOW);

    expect(nextState.phase).toBe("reviewing");
    expect(nextState.tasks.get("decomposer")!.status).toBe("complete");
    expect(effects).toContainEqual(expect.objectContaining({ type: "UPDATE_PLAN", phase: "reviewing" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "POPULATE_TASKS" }));
    // No auto-approve when tasks are empty
    expect(effects).not.toContainEqual(expect.objectContaining({ type: "FEED_EVENT" }));
  });

  it("decomposer TASK_COMPLETE with tasks: populates tasks, kills container, auto-approves", () => {
    const decomposerTask = makeTask("decomposer", {
      taskType: "decomposer", status: "running", stepIndex: -1,
      containerId: "ao--plan-test--decomposer",
    });
    const state = makePlanState({
      phase: "decomposing",
      tasks: new Map([["decomposer", decomposerTask]]),
    });

    const event: EngineEvent = {
      type: "TASK_COMPLETE",
      planId: "plan-test",
      taskId: "decomposer",
      payload: {
        tasks: [
          {
            id: "0.1",
            title: "Build auth API",
            description: "Implement login endpoint",
            stepIndex: 0,
            skill: "backend",
            model: "sonnet",
            dependsOn: [],
            fileBoundary: ["src/auth/**"],
            acceptanceCriteria: ["Login works"],
          },
          {
            id: "0.2",
            title: "Build auth UI",
            description: "Implement login form",
            stepIndex: 0,
            skill: "frontend",
            model: "sonnet",
            dependsOn: [],
            fileBoundary: ["src/components/auth/**"],
            acceptanceCriteria: ["Form renders"],
          },
        ],
      },
    };

    const { nextState, effects } = transition(state, event, NOW);

    expect(nextState.phase).toBe("reviewing");
    expect(nextState.tasks.size).toBe(3); // decomposer + 2 tasks
    expect(nextState.tasks.get("0.1")!.title).toBe("Build auth API");
    expect(nextState.tasks.get("0.1")!.skill).toBe("backend");
    expect(nextState.tasks.get("0.1")!.status).toBe("pending");
    expect(nextState.tasks.get("0.2")!.title).toBe("Build auth UI");

    // Effects: UPDATE_PLAN, UPDATE_TASK, POPULATE_TASKS, KILL_CONTAINER, FEED_EVENT(auto-approve)
    expect(effects).toContainEqual(expect.objectContaining({ type: "UPDATE_PLAN", phase: "reviewing" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "UPDATE_TASK", taskId: "decomposer", status: "complete" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "POPULATE_TASKS" }));
    const populateEffect = effects.find((e) => e.type === "POPULATE_TASKS") as any;
    expect(populateEffect.tasks).toHaveLength(2);
    expect(effects).toContainEqual(expect.objectContaining({ type: "KILL_CONTAINER", containerId: "ao--plan-test--decomposer" }));
    expect(effects).toContainEqual(expect.objectContaining({
      type: "FEED_EVENT",
      event: { type: "PLAN_APPROVED", planId: "plan-test" },
    }));
  });

  it("decomposer TASK_FAILED: decomposing -> failed", () => {
    const decomposerTask = makeTask("decomposer", { taskType: "decomposer", status: "running", stepIndex: -1 });
    const state = makePlanState({
      phase: "decomposing",
      tasks: new Map([["decomposer", decomposerTask]]),
    });

    const { nextState, effects } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "decomposer", error: "LLM error",
    }, NOW);

    expect(nextState.phase).toBe("failed");
    expect(nextState.tasks.get("decomposer")!.status).toBe("failed");
    expect(effects).toContainEqual(expect.objectContaining({ type: "CLEANUP" }));
  });
});

// ============================================================================
// TASK LIFECYCLE
// ============================================================================

describe("transition: task lifecycle", () => {
  it("DEPS_MET: pending -> spawning", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([["1.1", makeTask("1.1", { status: "pending" })]]),
    });

    const { nextState, effects } = transition(state, {
      type: "DEPS_MET", planId: "plan-test", taskId: "1.1",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("spawning");
    expect(effects).toContainEqual(expect.objectContaining({ type: "SPAWN_CONTAINER", taskId: "1.1" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "ACQUIRE_LOCKS", taskId: "1.1" }));
  });

  it("DEPS_MET: ignores non-pending task", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([["1.1", makeTask("1.1", { status: "running" })]]),
    });
    const { effects } = transition(state, { type: "DEPS_MET", planId: "plan-test", taskId: "1.1" }, NOW);
    expect(effects).toEqual([]);
  });

  it("CONTAINER_READY: spawning -> running", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([["1.1", makeTask("1.1", { status: "spawning" })]]),
    });

    const { nextState, effects } = transition(state, {
      type: "CONTAINER_READY", planId: "plan-test", taskId: "1.1", sessionId: "ao-99",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("running");
    expect(nextState.tasks.get("1.1")!.containerId).toBe("ao--plan-test--1.1");
    expect(nextState.tasks.get("1.1")!.sessionId).toBe("ao-99");
    expect(effects).toContainEqual(expect.objectContaining({ type: "UPDATE_TASK", status: "running" }));
  });

  it("TASK_COMPLETE: running -> complete, kills container, releases locks", () => {
    const state = makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "running", containerId: "ao--plan-test--1.1", stepIndex: 0 })],
        ["1.2", makeTask("1.2", { status: "running", stepIndex: 0 })],
      ]),
    });

    const { nextState, effects } = transition(state, {
      type: "TASK_COMPLETE", planId: "plan-test", taskId: "1.1", payload: { summary: "done" },
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("complete");
    expect(effects).toContainEqual(expect.objectContaining({ type: "UPDATE_TASK", taskId: "1.1", status: "complete" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "KILL_CONTAINER", containerId: "ao--plan-test--1.1" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "RELEASE_LOCKS", taskId: "1.1" }));
    // 1.2 still running, so no STEP_COMPLETE
    expect(effects.find((e) => e.type === "FEED_EVENT")).toBeUndefined();
  });

  it("TASK_COMPLETE: last step task triggers STEP_COMPLETE", () => {
    const step = makeStep();
    const state = makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      workflowSnapshot: [step],
      steps: [{ index: 0, name: "Implement", status: "active", snapshot: step }],
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "complete", stepIndex: 0 })],
        ["1.2", makeTask("1.2", { status: "running", containerId: "c", stepIndex: 0 })],
      ]),
    });

    const { effects } = transition(state, {
      type: "TASK_COMPLETE", planId: "plan-test", taskId: "1.2", payload: {},
    }, NOW);

    const feedEvent = effects.find((e) => e.type === "FEED_EVENT");
    expect(feedEvent).toBeDefined();
    expect((feedEvent as any).event.type).toBe("STEP_COMPLETE");
  });
});

// ============================================================================
// FAILURE POLICIES
// ============================================================================

describe("transition: failure policies", () => {
  function makeExecutingState(
    policy: WorkflowStepSnapshot["failure_policy"],
  ) {
    const step = makeStep({ failure_policy: policy });
    return makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      workflowSnapshot: [step],
      steps: [{ index: 0, name: "Implement", status: "active", snapshot: step }],
      tasks: new Map([
        ["1.1", makeTask("1.1", {
          status: "running", containerId: "ao--plan-test--1.1", stepIndex: 0,
        })],
      ]),
    });
  }

  it("spawn_doctor: failed task -> doctoring, doctor task created", () => {
    const state = makeExecutingState({
      action: "spawn_doctor", max_retries: 2, description: "Doctor",
    });

    const { nextState, effects } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "crash",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("doctoring");
    expect(nextState.tasks.has("doctor-1.1")).toBe(true);
    const doctor = nextState.tasks.get("doctor-1.1")!;
    expect(doctor.taskType).toBe("doctor");
    expect(doctor.healingTaskId).toBe("1.1");
    expect(effects).toContainEqual(expect.objectContaining({ type: "SPAWN_CONTAINER", taskId: "doctor-1.1" }));
  });

  it("retry: resets task to pending with incremented retryCount", () => {
    const state = makeExecutingState({
      action: "retry", max_retries: 3, description: "Retry",
    });

    const { nextState } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "flaky",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("pending");
    expect(nextState.tasks.get("1.1")!.retryCount).toBe(1);
  });

  it("retry: exhausted retries -> fail_plan", () => {
    const state = makeExecutingState({
      action: "retry", max_retries: 1, description: "Retry",
    });
    // Set retryCount to max
    state.tasks.get("1.1")!.retryCount = 1;

    const { nextState } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "still failing",
    }, NOW);

    expect(nextState.phase).toBe("failed");
  });

  it("fail_plan: plan -> failed, kills all", () => {
    const state = makeExecutingState({
      action: "fail_plan", description: "Fail",
    });

    const { nextState, effects } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "fatal",
    }, NOW);

    expect(nextState.phase).toBe("failed");
    expect(effects).toContainEqual(expect.objectContaining({ type: "CLEANUP" }));
  });

  it("skip: task stays failed, plan continues", () => {
    const state = makeExecutingState({
      action: "skip", description: "Skip",
    });

    const { nextState } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "non-critical",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("failed");
    expect(nextState.phase).toBe("executing");
  });

  it("notify: emits event, plan continues", () => {
    const state = makeExecutingState({
      action: "notify", description: "Notify",
    });

    const { nextState, effects } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "warning",
    }, NOW);

    expect(nextState.phase).toBe("executing");
    expect(effects).toContainEqual(expect.objectContaining({ type: "EMIT_EVENT", eventType: "task_failed" }));
  });
});

// ============================================================================
// CONTAINER EVENTS
// ============================================================================

describe("transition: container events", () => {
  it("CONTAINER_DIED: running -> failed, applies failure policy", () => {
    const step = makeStep();
    const state = makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      workflowSnapshot: [step],
      steps: [{ index: 0, name: "Implement", status: "active", snapshot: step }],
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "running", containerId: "ao--plan-test--1.1", stepIndex: 0 })],
      ]),
    });

    const { nextState, effects } = transition(state, {
      type: "CONTAINER_DIED", planId: "plan-test", taskId: "1.1", containerId: "ao--plan-test--1.1",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("doctoring");
    expect(effects).toContainEqual(expect.objectContaining({ type: "UPDATE_TASK", status: "failed" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "RELEASE_LOCKS" }));
  });

  it("CONTAINER_DIED: ignores non-running task", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([["1.1", makeTask("1.1", { status: "complete" })]]),
    });

    const { effects } = transition(state, {
      type: "CONTAINER_DIED", planId: "plan-test", taskId: "1.1", containerId: "c",
    }, NOW);
    expect(effects).toEqual([]);
  });

  it("HEARTBEAT_TIMEOUT: running -> failed + KILL_CONTAINER", () => {
    const step = makeStep({ failure_policy: { action: "fail_plan", description: "Fail" } });
    const state = makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      workflowSnapshot: [step],
      steps: [{ index: 0, name: "Impl", status: "active", snapshot: step }],
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "running", containerId: "ao--plan-test--1.1", stepIndex: 0 })],
      ]),
    });

    const { nextState, effects } = transition(state, {
      type: "HEARTBEAT_TIMEOUT", planId: "plan-test", taskId: "1.1",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("failed");
    expect(effects).toContainEqual(expect.objectContaining({ type: "KILL_CONTAINER" }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "RELEASE_LOCKS" }));
  });

  it("SPAWN_FAILED: spawning -> failed, applies policy", () => {
    const step = makeStep({ failure_policy: { action: "skip", description: "Skip" } });
    const state = makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      workflowSnapshot: [step],
      steps: [{ index: 0, name: "Impl", status: "active", snapshot: step }],
      tasks: new Map([["1.1", makeTask("1.1", { status: "spawning", stepIndex: 0 })]]),
    });

    const { nextState } = transition(state, {
      type: "SPAWN_FAILED", planId: "plan-test", taskId: "1.1", error: "docker pull failed",
    }, NOW);

    expect(nextState.tasks.get("1.1")!.status).toBe("failed");
    expect(nextState.phase).toBe("executing"); // skip policy
  });
});

// ============================================================================
// STEP ADVANCEMENT
// ============================================================================

describe("transition: step advancement", () => {
  it("STEP_COMPLETE: advances to next step, spawns ready tasks", () => {
    const step0 = makeStep({ name: "Implement", sort_order: 0 });
    const step1 = makeStep({ name: "Test", sort_order: 1 });
    const state = makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      workflowSnapshot: [step0, step1],
      steps: [
        { index: 0, name: "Implement", status: "active", snapshot: step0 },
        { index: 1, name: "Test", status: "pending", snapshot: step1 },
      ],
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "complete", stepIndex: 0 })],
        ["2.1", makeTask("2.1", { status: "pending", stepIndex: 1 })],
      ]),
    });

    const { nextState, effects } = transition(state, {
      type: "STEP_COMPLETE", planId: "plan-test", stepIndex: 0,
    }, NOW);

    expect(nextState.currentStepIndex).toBe(1);
    expect(nextState.steps[0].status).toBe("complete");
    expect(nextState.steps[1].status).toBe("active");
    expect(nextState.tasks.get("2.1")!.status).toBe("spawning");
    expect(effects).toContainEqual(expect.objectContaining({ type: "SPAWN_CONTAINER", taskId: "2.1" }));
  });

  it("STEP_COMPLETE: last step -> completing, MERGE_PRS + CLEANUP", () => {
    const step0 = makeStep();
    const state = makePlanState({
      phase: "executing",
      currentStepIndex: 0,
      workflowSnapshot: [step0],
      steps: [{ index: 0, name: "Implement", status: "active", snapshot: step0 }],
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "complete", stepIndex: 0, branch: "feat/1.1" })],
      ]),
    });

    const { nextState, effects } = transition(state, {
      type: "STEP_COMPLETE", planId: "plan-test", stepIndex: 0,
    }, NOW);

    expect(nextState.phase).toBe("completing");
    expect(effects).toContainEqual(expect.objectContaining({ type: "MERGE_PRS", branches: ["feat/1.1"] }));
    expect(effects).toContainEqual(expect.objectContaining({ type: "CLEANUP" }));
  });
});

// ============================================================================
// GUARDS
// ============================================================================

describe("transition: guards", () => {
  it("ignores events when plan is complete", () => {
    const state = makePlanState({ phase: "complete" });
    const { nextState, effects } = transition(state, {
      type: "TASK_COMPLETE", planId: "plan-test", taskId: "1.1", payload: {},
    }, NOW);
    expect(nextState.phase).toBe("complete");
    expect(effects).toEqual([]);
  });

  it("ignores events when plan is failed", () => {
    const state = makePlanState({ phase: "failed" });
    const { effects } = transition(state, {
      type: "PLAN_APPROVED", planId: "plan-test",
    }, NOW);
    expect(effects).toEqual([]);
  });

  it("ignores events when plan is cancelled", () => {
    const state = makePlanState({ phase: "cancelled" });
    const { effects } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "x",
    }, NOW);
    expect(effects).toEqual([]);
  });

  it("ignores TASK_COMPLETE for already-complete task", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([["1.1", makeTask("1.1", { status: "complete" })]]),
    });
    const { effects } = transition(state, {
      type: "TASK_COMPLETE", planId: "plan-test", taskId: "1.1", payload: {},
    }, NOW);
    expect(effects).toEqual([]);
  });

  it("ignores TASK_FAILED for already-failed task", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([["1.1", makeTask("1.1", { status: "failed" })]]),
    });
    const { effects } = transition(state, {
      type: "TASK_FAILED", planId: "plan-test", taskId: "1.1", error: "x",
    }, NOW);
    expect(effects).toEqual([]);
  });

  it("ignores TASK_COMPLETE for unknown task", () => {
    const state = makePlanState({ phase: "executing" });
    const { effects } = transition(state, {
      type: "TASK_COMPLETE", planId: "plan-test", taskId: "nonexistent", payload: {},
    }, NOW);
    expect(effects).toEqual([]);
  });
});

// ============================================================================
// DOCTOR LIFECYCLE
// ============================================================================

describe("transition: doctor lifecycle", () => {
  it("doctor TASK_COMPLETE: resets healed task to pending", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "doctoring", stepIndex: 0, doctorTaskId: "doctor-1.1" })],
        ["doctor-1.1", makeTask("doctor-1.1", {
          status: "running", taskType: "doctor", healingTaskId: "1.1", stepIndex: 0,
        })],
      ]),
    });

    const { nextState, effects } = transition(state, {
      type: "TASK_COMPLETE", planId: "plan-test", taskId: "doctor-1.1", payload: { fix: "applied" },
    }, NOW);

    expect(nextState.tasks.get("doctor-1.1")!.status).toBe("complete");
    expect(nextState.tasks.get("1.1")!.status).toBe("pending");
    expect(nextState.tasks.get("1.1")!.error).toBeNull();
    expect(effects).toContainEqual(expect.objectContaining({ type: "RELEASE_LOCKS" }));
  });
});

// ============================================================================
// PLAN CANCELLATION
// ============================================================================

describe("transition: plan cancellation", () => {
  it("PLAN_CANCELLED: kills all running containers, cleanup", () => {
    const state = makePlanState({
      phase: "executing",
      tasks: new Map([
        ["1.1", makeTask("1.1", { status: "running", containerId: "c1" })],
        ["1.2", makeTask("1.2", { status: "spawning", containerId: "c2" })],
        ["1.3", makeTask("1.3", { status: "complete" })],
      ]),
    });

    const { nextState, effects } = transition(state, {
      type: "PLAN_CANCELLED", planId: "plan-test",
    }, NOW);

    expect(nextState.phase).toBe("cancelled");
    const killEffects = effects.filter((e) => e.type === "KILL_CONTAINER");
    expect(killEffects).toHaveLength(2);
    expect(effects).toContainEqual(expect.objectContaining({ type: "CLEANUP" }));
  });
});

// ============================================================================
// CONTAINER NAME
// ============================================================================

describe("containerName", () => {
  it("returns deterministic ao--planId--taskId format", () => {
    expect(containerName("plan-44c00107", "1.4")).toBe("ao--plan-44c00107--1.4");
  });

  it("handles doctor task IDs", () => {
    expect(containerName("plan-abc", "doctor-1.3.2")).toBe("ao--plan-abc--doctor-1.3.2");
  });
});
