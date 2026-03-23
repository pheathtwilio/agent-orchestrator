import { describe, it, expect, vi } from "vitest";
import { EffectExecutor } from "../effect-executor.js";
import type { Effect } from "../types.js";

function makeMockDeps() {
  return {
    store: {
      atomicUpdate: vi.fn(),
      registerContainer: vi.fn(),
      removeContainer: vi.fn(),
      deactivatePlan: vi.fn(),
    },
    spawner: {
      spawn: vi.fn().mockResolvedValue("session-123"),
      kill: vi.fn(),
    },
    locks: {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      releaseAll: vi.fn().mockResolvedValue(1),
    },
    eventEmitter: vi.fn(),
    feedEvent: vi.fn(),
  };
}

describe("EffectExecutor", () => {
  it("executes SPAWN_CONTAINER by calling spawner.spawn and registerContainer", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "SPAWN_CONTAINER",
      planId: "plan-1",
      taskId: "1.1",
      config: {
        containerName: "ao--plan-1--1.1",
        projectId: "proj-1",
        prompt: "Build API",
        branch: "main",
        model: "sonnet",
        skill: "fullstack",
        dockerImage: "ao-agent:latest",
        environment: {},
      },
    }]);

    expect(deps.spawner.spawn).toHaveBeenCalledOnce();
    expect(deps.store.registerContainer).toHaveBeenCalledWith("ao--plan-1--1.1", "plan-1", "1.1");
  });

  it("feeds SPAWN_FAILED event when spawn throws", async () => {
    const deps = makeMockDeps();
    deps.spawner.spawn.mockRejectedValue(new Error("Docker pull failed"));
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "SPAWN_CONTAINER",
      planId: "plan-1",
      taskId: "1.1",
      config: {
        containerName: "ao--plan-1--1.1",
        projectId: "proj-1",
        prompt: "Build",
        branch: "main",
        model: "sonnet",
        skill: "fullstack",
        dockerImage: "ao-agent:latest",
        environment: {},
      },
    }]);

    expect(deps.feedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SPAWN_FAILED", taskId: "1.1", error: "Docker pull failed" })
    );
  });

  it("executes KILL_CONTAINER idempotently", async () => {
    const deps = makeMockDeps();
    deps.spawner.kill.mockRejectedValue(new Error("already dead"));
    const executor = new EffectExecutor(deps as any);

    // Should not throw
    await executor.execute([{
      type: "KILL_CONTAINER",
      planId: "plan-1",
      taskId: "1.1",
      containerId: "ao--plan-1--1.1",
    }]);
  });

  it("executes UPDATE_TASK via atomicUpdate", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "UPDATE_TASK",
      planId: "plan-1",
      taskId: "1.1",
      status: "complete",
      result: { summary: "done" },
    }]);

    expect(deps.store.atomicUpdate).toHaveBeenCalledOnce();
  });

  it("executes UPDATE_PLAN via atomicUpdate", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "UPDATE_PLAN",
      planId: "plan-1",
      phase: "executing",
      stepIndex: 1,
    }]);

    expect(deps.store.atomicUpdate).toHaveBeenCalledWith("plan-1", [
      { type: "SET_PLAN_FIELD", field: "phase", value: "executing" },
      { type: "SET_PLAN_FIELD", field: "currentStepIndex", value: "1" },
    ]);
  });

  it("executes FEED_EVENT by calling feedEvent", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "FEED_EVENT",
      event: { type: "STEP_COMPLETE", planId: "plan-1", stepIndex: 0 },
    }]);

    expect(deps.feedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "STEP_COMPLETE" })
    );
  });

  it("executes EMIT_EVENT by calling eventEmitter", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "EMIT_EVENT",
      eventType: "task_failed",
      planId: "plan-1",
      taskId: "1.1",
      detail: "OOM killed",
    }]);

    expect(deps.eventEmitter).toHaveBeenCalledWith("task_failed", "plan-1", "1.1", "OOM killed");
  });

  it("executes CLEANUP: kills containers, deactivates plan, feeds CLEANUP_DONE", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "CLEANUP",
      planId: "plan-1",
      resources: [
        { type: "container", id: "ao--plan-1--1.1" },
        { type: "container", id: "ao--plan-1--1.2" },
      ],
    }]);

    expect(deps.spawner.kill).toHaveBeenCalledTimes(2);
    expect(deps.store.deactivatePlan).toHaveBeenCalledWith("plan-1");
    expect(deps.feedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CLEANUP_DONE", planId: "plan-1" })
    );
  });

  it("executes ACQUIRE_LOCKS by calling locks.acquire for each file", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "ACQUIRE_LOCKS",
      planId: "plan-1",
      taskId: "1.1",
      files: ["src/api.ts", "src/db.ts"],
    }]);

    expect(deps.locks.acquire).toHaveBeenCalledTimes(2);
    expect(deps.locks.acquire).toHaveBeenCalledWith("src/api.ts", "plan-1:1.1");
  });

  it("executes RELEASE_LOCKS by calling locks.releaseAll", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "RELEASE_LOCKS",
      planId: "plan-1",
      taskId: "1.1",
    }]);

    expect(deps.locks.releaseAll).toHaveBeenCalledWith("plan-1:1.1");
  });

  it("executes POPULATE_TASKS via atomicUpdate batch", async () => {
    const deps = makeMockDeps();
    const executor = new EffectExecutor(deps as any);

    await executor.execute([{
      type: "POPULATE_TASKS",
      planId: "plan-1",
      tasks: [
        { id: "1.1", stepIndex: 0, status: "pending", containerId: null, retryCount: 0 } as any,
      ],
    }]);

    expect(deps.store.atomicUpdate).toHaveBeenCalledOnce();
  });
});
