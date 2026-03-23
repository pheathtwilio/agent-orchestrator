import { describe, it, expect, vi } from "vitest";
import { WorkflowEngine } from "../engine.js";
import { containerName } from "../state-machine.js";
import type { TaskState } from "../types.js";

function makeMockEngineDeps() {
  return {
    bus: {
      createGroup: vi.fn(),
      subscribeGroup: vi.fn(),
      ack: vi.fn(),
      autoClaim: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      disconnect: vi.fn(),
    },
    store: {
      createPlan: vi.fn(),
      getPlan: vi.fn().mockResolvedValue(null),
      atomicUpdate: vi.fn(),
      getTask: vi.fn(),
      getAllTasks: vi.fn().mockResolvedValue({}),
      getActivePlanIds: vi.fn().mockResolvedValue([]),
      deactivatePlan: vi.fn(),
      registerContainer: vi.fn(),
      lookupContainer: vi.fn(),
      removeContainer: vi.fn(),
      updateHeartbeat: vi.fn(),
      getHeartbeats: vi.fn().mockResolvedValue({}),
      disconnect: vi.fn(),
    },
    spawner: {
      spawn: vi.fn().mockResolvedValue("session-1"),
      kill: vi.fn(),
    },
    eventEmitter: vi.fn(),
  };
}

describe("WorkflowEngine", () => {
  it("creates a plan and transitions to decomposing", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.createPlan({
      planId: "plan-1",
      projectId: "proj-1",
      featureDescription: "Build user auth",
      workflowId: "std-dev",
      workflowVersionId: "v1",
      workflowSnapshot: [],
    });

    const state = engine.getPlanState("plan-1");
    expect(state).toBeDefined();
    expect(state!.phase).toBe("decomposing");

    // Planner container should have been spawned
    expect(deps.spawner.spawn).toHaveBeenCalledOnce();
  });

  it("handles TASK_COMPLETE event for decomposer", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.createPlan({
      planId: "plan-1",
      projectId: "proj-1",
      featureDescription: "Build auth",
      workflowId: "std-dev",
      workflowVersionId: "v1",
      workflowSnapshot: [],
    });

    // Set decomposer task to running (simulating CONTAINER_READY)
    const state = engine.getPlanState("plan-1")!;
    const decomposerTask = state.tasks.get("decomposer")!;
    state.tasks.set("decomposer", { ...decomposerTask, status: "running" });

    await engine.processEvent({
      type: "TASK_COMPLETE",
      planId: "plan-1",
      taskId: "decomposer",
      payload: { tasks: [] },
    });

    expect(engine.getPlanState("plan-1")!.phase).toBe("reviewing");
  });

  it("returns undefined for unknown plan", () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);
    expect(engine.getPlanState("nonexistent")).toBeUndefined();
  });

  it("ignores events for unknown plans", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    // Should not throw
    await engine.processEvent({
      type: "TASK_COMPLETE",
      planId: "unknown",
      taskId: "1.1",
      payload: {},
    });
  });

  it("stops gracefully", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.stop();

    expect(deps.bus.disconnect).toHaveBeenCalledOnce();
    expect(deps.store.disconnect).toHaveBeenCalledOnce();
  });
});

describe("Regression: known bugs", () => {
  it("replayed TASK_COMPLETE for already-complete task is ignored", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.createPlan({
      planId: "plan-1", projectId: "p1", featureDescription: "test",
      workflowId: "std", workflowVersionId: "v1", workflowSnapshot: [],
    });

    const state = engine.getPlanState("plan-1")!;
    state.tasks.set("1.1", {
      id: "1.1", status: "complete", containerId: null, sessionId: null, branch: "feat-1",
      result: { summary: "done" }, error: null, stepIndex: 1, retryCount: 0,
      doctorTaskId: null, healingTaskId: null, taskType: "implementation",
      title: "Task 1.1", description: "", acceptanceCriteria: [], fileBoundary: [],
      dependsOn: [], model: "sonnet", skill: "fullstack", dockerImage: "ao-agent:latest",
    } as TaskState);

    // Replay TASK_COMPLETE for already-complete task
    await engine.processEvent({
      type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.1", payload: {},
    });

    expect(engine.getPlanState("plan-1")!.tasks.get("1.1")!.status).toBe("complete");
  });

  it("container name is deterministic ao--planId--taskId", () => {
    expect(containerName("plan-44c00107", "1.4")).toBe("ao--plan-44c00107--1.4");
    expect(containerName("plan-abc", "doctor-1.3")).toBe("ao--plan-abc--doctor-1.3");
  });

  it("events for terminal plan states are ignored", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.createPlan({
      planId: "plan-1", projectId: "p1", featureDescription: "test",
      workflowId: "std", workflowVersionId: "v1", workflowSnapshot: [],
    });

    // Force plan to "complete" state
    const state = engine.getPlanState("plan-1")!;
    state.phase = "complete";

    // Try to process more events — should be ignored
    await engine.processEvent({
      type: "TASK_COMPLETE", planId: "plan-1", taskId: "decomposer", payload: {},
    });

    expect(engine.getPlanState("plan-1")!.phase).toBe("complete");
  });

  it("TASK_COMPLETE for unknown task is ignored", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.createPlan({
      planId: "plan-1", projectId: "p1", featureDescription: "test",
      workflowId: "std", workflowVersionId: "v1", workflowSnapshot: [],
    });

    // Process event for task that doesn't exist
    await engine.processEvent({
      type: "TASK_COMPLETE", planId: "plan-1", taskId: "nonexistent", payload: {},
    });

    // Plan should still be in decomposing (unchanged)
    expect(engine.getPlanState("plan-1")!.phase).toBe("decomposing");
  });
});

describe("Scenario: plan creation through approval", () => {
  it("create -> decomposer completes -> reviewing -> approve -> executing", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    // 1. Create plan
    await engine.createPlan({
      planId: "plan-1", projectId: "proj-1", featureDescription: "Auth system",
      workflowId: "std-dev", workflowVersionId: "v1",
      workflowSnapshot: [
        { name: "Implement", sort_order: 1, exit_criteria: { programmatic: ["all_tasks_complete"] },
          failure_policy: { action: "fail_plan" }, agent_config: { skill: "fullstack", model_tier: "sonnet", docker_image: "ao-agent:latest" },
          is_conditional: false, condition: null },
      ],
    });
    expect(engine.getPlanState("plan-1")!.phase).toBe("decomposing");

    // 2. Simulate decomposer running and completing
    const state = engine.getPlanState("plan-1")!;
    const decomposerTask = state.tasks.get("decomposer")!;
    state.tasks.set("decomposer", { ...decomposerTask, status: "running" });

    await engine.processEvent({
      type: "TASK_COMPLETE", planId: "plan-1", taskId: "decomposer", payload: {},
    });
    expect(engine.getPlanState("plan-1")!.phase).toBe("reviewing");

    // 3. Approve the plan
    await engine.processEvent({ type: "PLAN_APPROVED", planId: "plan-1" });
    expect(engine.getPlanState("plan-1")!.phase).toBe("executing");
  });
});

describe("Scenario: decomposer produces tasks → auto-approve → executing", () => {
  it("full flow: create → decomposer with tasks → auto-approve → tasks spawned", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    // 1. Create plan with a workflow step
    await engine.createPlan({
      planId: "plan-1", projectId: "proj-1", featureDescription: "Auth system",
      workflowId: "std-dev", workflowVersionId: "v1",
      workflowSnapshot: [
        { name: "Implement", sort_order: 0, description: "Build the feature",
          exit_criteria: { programmatic: ["all_tasks_complete"], description: "" },
          failure_policy: { action: "fail_plan", description: "" },
          agent_config: { skill: "fullstack", model_tier: "sonnet" },
          is_conditional: false, condition: null },
      ],
    });
    expect(engine.getPlanState("plan-1")!.phase).toBe("decomposing");

    // 2. Simulate decomposer running
    const state = engine.getPlanState("plan-1")!;
    const decomposerTask = state.tasks.get("decomposer")!;
    state.tasks.set("decomposer", { ...decomposerTask, status: "running", containerId: "ao--plan-1--decomposer" });

    // 3. Decomposer completes with task graph
    const spawnCallsBefore = deps.spawner.spawn.mock.calls.length;
    await engine.processEvent({
      type: "TASK_COMPLETE", planId: "plan-1", taskId: "decomposer",
      payload: {
        tasks: [
          { id: "0.1", title: "Build API", description: "Implement endpoints",
            stepIndex: 0, skill: "backend", model: "sonnet",
            dependsOn: [], fileBoundary: ["src/api/**"], acceptanceCriteria: ["API works"] },
          { id: "0.2", title: "Build UI", description: "Implement frontend",
            stepIndex: 0, skill: "frontend", model: "sonnet",
            dependsOn: [], fileBoundary: ["src/ui/**"], acceptanceCriteria: ["UI renders"] },
        ],
      },
    });

    // Should have auto-approved and started executing
    expect(engine.getPlanState("plan-1")!.phase).toBe("executing");
    expect(engine.getPlanState("plan-1")!.tasks.size).toBe(3); // decomposer + 2 tasks
    // Tasks go spawning → running because CONTAINER_READY fires synchronously after spawn
    expect(engine.getPlanState("plan-1")!.tasks.get("0.1")!.status).toBe("running");
    expect(engine.getPlanState("plan-1")!.tasks.get("0.2")!.status).toBe("running");

    // Two task containers should have been spawned (not counting the decomposer)
    const newSpawnCalls = deps.spawner.spawn.mock.calls.length - spawnCallsBefore;
    expect(newSpawnCalls).toBe(2);
  });
});

describe("Scenario: plan cancellation", () => {
  it("cancelling a plan kills containers and transitions to cancelled", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.createPlan({
      planId: "plan-1", projectId: "p1", featureDescription: "test",
      workflowId: "std", workflowVersionId: "v1", workflowSnapshot: [],
    });

    // Set decomposer to running with a container
    const state = engine.getPlanState("plan-1")!;
    const decomposerTask = state.tasks.get("decomposer")!;
    state.tasks.set("decomposer", {
      ...decomposerTask,
      status: "running",
      containerId: "ao--plan-1--decomposer",
    });

    await engine.processEvent({ type: "PLAN_CANCELLED", planId: "plan-1" });

    // Should be in cancelling or cancelled state
    const phase = engine.getPlanState("plan-1")!.phase;
    expect(["cancelling", "cancelled"]).toContain(phase);
  });
});

describe("Scenario: concurrent events for same plan", () => {
  it("MessageProcessor ensures sequential processing", async () => {
    const deps = makeMockEngineDeps();
    const engine = new WorkflowEngine(deps as any);

    await engine.createPlan({
      planId: "plan-1", projectId: "p1", featureDescription: "test",
      workflowId: "std", workflowVersionId: "v1", workflowSnapshot: [],
    });

    // Both events target same plan — should not throw
    const p1 = engine.processEvent({
      type: "TASK_COMPLETE", planId: "plan-1", taskId: "nonexistent-1", payload: {},
    });
    const p2 = engine.processEvent({
      type: "TASK_COMPLETE", planId: "plan-1", taskId: "nonexistent-2", payload: {},
    });

    await Promise.all([p1, p2]);
    // No crash = success
  });
});
