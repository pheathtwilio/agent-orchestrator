import type { Effect, EngineEvent, SpawnConfig } from "./types.js";

export interface EffectDeps {
  store: {
    atomicUpdate(planId: string, ops: Array<{ type: string; [key: string]: unknown }>): Promise<void>;
    registerContainer(name: string, planId: string, taskId: string): Promise<void>;
    removeContainer(name: string): Promise<void>;
    deactivatePlan(planId: string): Promise<void>;
  };
  spawner: {
    spawn(config: SpawnConfig): Promise<string>;
    kill(containerId: string): Promise<void>;
  };
  merger?: {
    mergePRs(planId: string, branches: string[]): Promise<void>;
  };
  locks?: {
    acquire(filePath: string, owner: string): Promise<boolean>;
    release(filePath: string, owner: string): Promise<boolean>;
    releaseAll(owner: string): Promise<number>;
  };
  eventEmitter: (eventType: string, planId: string, taskId: string | undefined, detail: string) => void;
  feedEvent: (event: EngineEvent) => void;
}

export class EffectExecutor {
  constructor(private deps: EffectDeps) {}

  async execute(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      await this.executeOne(effect);
    }
  }

  private async executeOne(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "SPAWN_CONTAINER":
        return this.handleSpawn(effect);
      case "KILL_CONTAINER":
        return this.handleKill(effect);
      case "UPDATE_TASK":
        return this.handleUpdateTask(effect);
      case "UPDATE_PLAN":
        return this.handleUpdatePlan(effect);
      case "MERGE_PRS":
        return this.handleMergePRs(effect);
      case "EMIT_EVENT":
        this.deps.eventEmitter(effect.eventType, effect.planId, effect.taskId, effect.detail);
        return;
      case "CLEANUP":
        return this.handleCleanup(effect);
      case "POPULATE_TASKS":
        return this.handlePopulateTasks(effect);
      case "FEED_EVENT":
        this.deps.feedEvent(effect.event);
        return;
      case "ACQUIRE_LOCKS":
        return this.handleAcquireLocks(effect);
      case "RELEASE_LOCKS":
        return this.handleReleaseLocks(effect);
    }
  }

  private async handleSpawn(effect: Extract<Effect, { type: "SPAWN_CONTAINER" }>): Promise<void> {
    try {
      await this.deps.spawner.spawn(effect.config);
      await this.deps.store.registerContainer(effect.config.containerName, effect.planId, effect.taskId);
    } catch (err) {
      this.deps.feedEvent({
        type: "SPAWN_FAILED",
        planId: effect.planId,
        taskId: effect.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleKill(effect: Extract<Effect, { type: "KILL_CONTAINER" }>): Promise<void> {
    try {
      await this.deps.spawner.kill(effect.containerId);
      await this.deps.store.removeContainer(effect.containerId);
    } catch {
      // Kill is idempotent — container may already be gone
    }
  }

  private async handleUpdateTask(effect: Extract<Effect, { type: "UPDATE_TASK" }>): Promise<void> {
    const taskData: Record<string, unknown> = { status: effect.status };
    if (effect.result) taskData.result = effect.result;
    if (effect.error) taskData.error = effect.error;

    await this.deps.store.atomicUpdate(effect.planId, [
      { type: "SET_TASK", taskId: effect.taskId, data: JSON.stringify(taskData) },
    ]);
  }

  private async handleUpdatePlan(effect: Extract<Effect, { type: "UPDATE_PLAN" }>): Promise<void> {
    const ops: Array<{ type: string; field?: string; value?: string; [key: string]: unknown }> = [
      { type: "SET_PLAN_FIELD", field: "phase", value: effect.phase },
    ];
    if (effect.stepIndex !== undefined) {
      ops.push({ type: "SET_PLAN_FIELD", field: "currentStepIndex", value: String(effect.stepIndex) });
    }
    await this.deps.store.atomicUpdate(effect.planId, ops);
  }

  private async handleMergePRs(effect: Extract<Effect, { type: "MERGE_PRS" }>): Promise<void> {
    if (this.deps.merger) {
      try {
        await this.deps.merger.mergePRs(effect.planId, effect.branches);
      } catch (err) {
        this.deps.feedEvent({
          type: "MERGE_FAILED",
          planId: effect.planId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async handleCleanup(effect: Extract<Effect, { type: "CLEANUP" }>): Promise<void> {
    for (const resource of effect.resources) {
      if (resource.type === "container") {
        try {
          await this.deps.spawner.kill(resource.id);
          await this.deps.store.removeContainer(resource.id);
        } catch { /* cleanup is best-effort */ }
      }
    }
    await this.deps.store.deactivatePlan(effect.planId);
    this.deps.feedEvent({ type: "CLEANUP_DONE", planId: effect.planId });
  }

  private async handlePopulateTasks(effect: Extract<Effect, { type: "POPULATE_TASKS" }>): Promise<void> {
    const ops = effect.tasks.map((task) => ({
      type: "SET_TASK" as const,
      taskId: task.id,
      data: JSON.stringify(task),
    }));
    await this.deps.store.atomicUpdate(effect.planId, ops);
  }

  private async handleAcquireLocks(effect: Extract<Effect, { type: "ACQUIRE_LOCKS" }>): Promise<void> {
    if (!this.deps.locks) return;
    const owner = `${effect.planId}:${effect.taskId}`;
    for (const file of effect.files) {
      await this.deps.locks.acquire(file, owner);
    }
  }

  private async handleReleaseLocks(effect: Extract<Effect, { type: "RELEASE_LOCKS" }>): Promise<void> {
    if (!this.deps.locks) return;
    const owner = `${effect.planId}:${effect.taskId}`;
    await this.deps.locks.releaseAll(owner);
  }
}
