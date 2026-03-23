import { describe, it, expect, vi } from "vitest";
import { PlanMessageQueue, MessageProcessor } from "../message-processor.js";
import type { EngineEvent } from "../types.js";

describe("PlanMessageQueue", () => {
  it("processes messages sequentially", async () => {
    const order: string[] = [];
    const transitionFn = vi.fn(async (event: EngineEvent): Promise<void> => {
      order.push(event.type);
      await new Promise((r) => setTimeout(r, 10));
    });

    const queue = new PlanMessageQueue("plan-1", transitionFn);

    const p1 = queue.enqueue(
      { type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.1", payload: {} },
      async () => {},
    );
    const p2 = queue.enqueue(
      { type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.2", payload: {} },
      async () => {},
    );

    await Promise.all([p1, p2]);

    expect(order).toEqual(["TASK_COMPLETE", "TASK_COMPLETE"]);
    expect(transitionFn).toHaveBeenCalledTimes(2);
  });

  it("calls ackFn after processing", async () => {
    const ackFn = vi.fn();
    const queue = new PlanMessageQueue("plan-1", async () => {});

    await queue.enqueue(
      { type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.1", payload: {} },
      ackFn,
    );

    expect(ackFn).toHaveBeenCalledOnce();
  });

  it("rejects on processFn error without blocking queue", async () => {
    let callCount = 0;
    const queue = new PlanMessageQueue("plan-1", async () => {
      callCount++;
      if (callCount === 1) throw new Error("fail");
    });

    const p1 = queue.enqueue(
      { type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.1", payload: {} },
      async () => {},
    ).catch(() => "rejected");

    const p2 = queue.enqueue(
      { type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.2", payload: {} },
      async () => {},
    );

    const [r1] = await Promise.all([p1, p2]);
    expect(r1).toBe("rejected");
    expect(callCount).toBe(2);
  });
});

describe("MessageProcessor", () => {
  it("routes to per-plan queues", async () => {
    const events: string[] = [];
    const processor = new MessageProcessor(async (event) => {
      events.push(`${event.planId}:${event.type}`);
    });

    await processor.route("plan-1",
      { type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.1", payload: {} },
      async () => {},
    );
    await processor.route("plan-2",
      { type: "TASK_COMPLETE", planId: "plan-2", taskId: "2.1", payload: {} },
      async () => {},
    );

    expect(events).toEqual(["plan-1:TASK_COMPLETE", "plan-2:TASK_COMPLETE"]);
  });

  it("removePlan cleans up queue", async () => {
    const processor = new MessageProcessor(async () => {});
    await processor.route("plan-1",
      { type: "TASK_COMPLETE", planId: "plan-1", taskId: "1.1", payload: {} },
      async () => {},
    );
    processor.removePlan("plan-1");
    // No error — just verifies cleanup doesn't throw
  });
});
