import { transition, createInitialState, containerName } from "./state-machine.js";
import { EffectExecutor } from "./effect-executor.js";
import { MessageProcessor } from "./message-processor.js";
import type { PlanState, EngineEvent, SpawnConfig } from "./types.js";

export interface EngineDeps {
  bus: {
    createGroup(stream: string, group: string, startId?: string): Promise<void>;
    subscribeGroup(
      stream: string, group: string, consumer: string,
      handler: (msg: any, streamId: string) => Promise<void>,
    ): Promise<void>;
    ack(stream: string, group: string, streamId: string): Promise<void>;
    autoClaim(stream: string, group: string, consumer: string, minIdleMs: number): Promise<any[]>;
    disconnect(): Promise<void>;
  };
  store: {
    createPlan(planId: string, data: any): Promise<void>;
    getPlan(planId: string): Promise<any>;
    atomicUpdate(planId: string, ops: any[]): Promise<void>;
    getAllTasks(planId: string): Promise<Record<string, string>>;
    getActivePlanIds(): Promise<string[]>;
    deactivatePlan(planId: string): Promise<void>;
    registerContainer(name: string, planId: string, taskId: string): Promise<void>;
    lookupContainer(name: string): Promise<{ planId: string; taskId: string } | null>;
    removeContainer(name: string): Promise<void>;
    updateHeartbeat(planId: string, taskId: string, timestamp: number): Promise<void>;
    getHeartbeats(): Promise<Record<string, number>>;
    disconnect(): Promise<void>;
  };
  spawner: {
    spawn(config: SpawnConfig): Promise<string>;
    kill(containerId: string): Promise<void>;
  };
  eventEmitter: (eventType: string, planId: string, taskId: string | undefined, detail: string) => void;
}

const STREAM_KEY = "ao:inbox:orchestrator";
const GROUP_NAME = "engine";
const CONSUMER_NAME = `engine-${process.pid}`;

export class WorkflowEngine {
  private plans = new Map<string, PlanState>();
  private processor: MessageProcessor;
  private effectExecutor: EffectExecutor;
  private deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.processor = new MessageProcessor(
      (event) => this.processEvent(event),
    );
    this.effectExecutor = new EffectExecutor({
      store: deps.store,
      spawner: deps.spawner,
      eventEmitter: deps.eventEmitter,
      feedEvent: (event) => this.processEvent(event),
    });
  }

  async start(): Promise<void> {
    await this.deps.bus.createGroup(STREAM_KEY, GROUP_NAME);
    await this.recover();
    await this.deps.bus.subscribeGroup(
      STREAM_KEY, GROUP_NAME, CONSUMER_NAME,
      async (msg, streamId) => {
        const event = this.messageToEvent(msg);
        if (!event) {
          await this.deps.bus.ack(STREAM_KEY, GROUP_NAME, streamId);
          return;
        }
        const planId = (event as any).planId;
        if (planId) {
          await this.processor.route(planId, event, () =>
            this.deps.bus.ack(STREAM_KEY, GROUP_NAME, streamId)
          );
        }
      },
    );
  }

  async createPlan(params: {
    planId: string;
    projectId: string;
    featureDescription: string;
    workflowId: string;
    workflowVersionId: string;
    workflowSnapshot: any[];
  }): Promise<void> {
    const state = createInitialState(params.planId);
    this.plans.set(params.planId, state);

    const event: EngineEvent = {
      type: "PLAN_CREATED",
      ...params,
    };

    await this.processEvent(event);
  }

  async processEvent(event: EngineEvent): Promise<void> {
    const planId = (event as any).planId;
    if (!planId) return;

    const state = this.plans.get(planId);
    if (!state) return;

    const { nextState, effects } = transition(state, event);
    this.plans.set(planId, nextState);

    await this.effectExecutor.execute(effects);
  }

  getPlanState(planId: string): PlanState | undefined {
    return this.plans.get(planId);
  }

  /**
   * Resume a plan by resetting failed tasks to pending and re-approving.
   * Preserves completed tasks.
   */
  async resumePlan(planId: string): Promise<{ resumed: string[] }> {
    const state = this.plans.get(planId);
    if (!state) throw new Error(`Plan ${planId} not found`);

    const resumed: string[] = [];
    for (const [taskId, task] of state.tasks) {
      if (task.status === "failed") {
        task.status = "pending";
        task.error = null;
        task.containerId = null;
        task.retryCount = 0;
        resumed.push(taskId);
      }
    }

    if (resumed.length === 0) return { resumed };

    // Reset phase to executing so the engine can re-process
    state.phase = "executing";
    state.updatedAt = Date.now();

    // Re-approve to trigger spawning of ready tasks
    await this.processEvent({ type: "PLAN_APPROVED", planId });
    return { resumed };
  }

  /**
   * Retry a plan by resetting ALL tasks to pending and re-starting.
   */
  async retryPlan(planId: string): Promise<void> {
    const state = this.plans.get(planId);
    if (!state) throw new Error(`Plan ${planId} not found`);

    // Kill any running containers first
    await this.processEvent({ type: "PLAN_CANCELLED", planId });

    // Reset all tasks
    for (const [, task] of state.tasks) {
      task.status = "pending";
      task.error = null;
      task.containerId = null;
      task.retryCount = 0;
      task.result = null;
    }

    // Reset plan phase and re-approve
    state.phase = "reviewing";
    state.updatedAt = Date.now();
    // Don't reset currentStepIndex — we keep the workflow position

    await this.processEvent({ type: "PLAN_APPROVED", planId });
  }

  private async recover(): Promise<void> {
    const planIds = await this.deps.store.getActivePlanIds();
    for (const planId of planIds) {
      const planData = await this.deps.store.getPlan(planId);
      if (!planData) continue;
      const state = createInitialState(planId);
      state.phase = planData.phase;
      state.projectId = planData.projectId;
      state.featureDescription = planData.featureDescription;
      state.currentStepIndex = planData.currentStepIndex;
      state.workflowId = planData.workflowId;
      state.workflowVersionId = planData.workflowVersionId;

      const tasks = await this.deps.store.getAllTasks(planId);
      for (const [taskId, json] of Object.entries(tasks)) {
        state.tasks.set(taskId, JSON.parse(json));
      }
      this.plans.set(planId, state);
    }

    await this.deps.bus.autoClaim(STREAM_KEY, GROUP_NAME, CONSUMER_NAME, 60000);
  }

  private messageToEvent(msg: any): EngineEvent | null {
    const payload = msg.payload ?? {};
    const planId = payload.planId ?? msg.from?.split(":")?.[1];
    if (!planId) return null;

    switch (msg.type) {
      case "TASK_COMPLETE":
        return { type: "TASK_COMPLETE", planId, taskId: payload.taskId, payload };
      case "TASK_FAILED":
        return { type: "TASK_FAILED", planId, taskId: payload.taskId, error: payload.error ?? "Unknown error" };
      case "PROGRESS_UPDATE":
        if (planId && payload.taskId) {
          this.deps.store.updateHeartbeat(planId, payload.taskId as string, Date.now());
        }
        return null;
      default:
        return null;
    }
  }

  async stop(): Promise<void> {
    await this.deps.bus.disconnect();
    await this.deps.store.disconnect();
  }
}
