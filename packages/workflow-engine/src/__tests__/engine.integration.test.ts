import { describe, it, expect, vi } from "vitest";
import { WorkflowEngine } from "../engine.js";

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
  it("creates a plan and transitions to planning", async () => {
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
    expect(state!.phase).toBe("planning");

    // Planner container should have been spawned
    expect(deps.spawner.spawn).toHaveBeenCalledOnce();
  });

  it("handles TASK_COMPLETE event for planner", async () => {
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

    // Set planner task to running (simulating CONTAINER_READY)
    const state = engine.getPlanState("plan-1")!;
    const plannerTask = state.tasks.get("planner")!;
    state.tasks.set("planner", { ...plannerTask, status: "running" });

    await engine.processEvent({
      type: "TASK_COMPLETE",
      planId: "plan-1",
      taskId: "planner",
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
