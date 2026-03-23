import type { EngineEvent } from "./types.js";

interface QueueEntry {
  event: EngineEvent;
  ackFn: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class PlanMessageQueue {
  private queue: QueueEntry[] = [];
  private draining = false;
  private planId: string;
  private processFn: (event: EngineEvent) => Promise<void>;

  constructor(planId: string, processFn: (event: EngineEvent) => Promise<void>) {
    this.planId = planId;
    this.processFn = processFn;
  }

  async enqueue(event: EngineEvent, ackFn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ event, ackFn, resolve, reject });
      if (!this.draining) {
        this.drain().catch(() => {});
      }
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        await this.processFn(entry.event);
        await entry.ackFn();
        entry.resolve();
      } catch (err) {
        entry.reject(err);
      }
    }
    this.draining = false;
  }

  get pending(): number {
    return this.queue.length;
  }
}

export class MessageProcessor {
  private queues = new Map<string, PlanMessageQueue>();
  private processFn: (event: EngineEvent) => Promise<void>;

  constructor(processFn: (event: EngineEvent) => Promise<void>) {
    this.processFn = processFn;
  }

  async route(planId: string, event: EngineEvent, ackFn: () => Promise<void>): Promise<void> {
    let queue = this.queues.get(planId);
    if (!queue) {
      queue = new PlanMessageQueue(planId, this.processFn);
      this.queues.set(planId, queue);
    }
    await queue.enqueue(event, ackFn);
  }

  removePlan(planId: string): void {
    this.queues.delete(planId);
  }
}
