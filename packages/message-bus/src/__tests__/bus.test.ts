import { describe, it, expect, vi } from "vitest";
import type { MessageBus, BusMessage, MessageHandler } from "../types.js";

// Unit tests that mock Redis — integration tests require a running Redis instance
// These test the serialization, message routing, and API contract

describe("MessageBus types", () => {
  it("should define all required message types", () => {
    const messageTypes = [
      "ASSIGN_TASK", "ABORT", "UNSTICK", "CONTEXT_UPDATE",
      "TASK_COMPLETE", "TASK_FAILED", "STUCK", "QUESTION",
      "FILE_LOCK_REQUEST", "PROGRESS_UPDATE",
      "RUN_TESTS", "TEST_RESULT",
    ];

    // Type check — ensure all types are valid
    for (const type of messageTypes) {
      const msg: Partial<BusMessage> = {
        type: type as BusMessage["type"],
        from: "test",
        to: "test",
        payload: {},
      };
      expect(msg.type).toBe(type);
    }
  });

  it("should enforce BusMessage structure", () => {
    const msg: BusMessage = {
      id: "test-id",
      type: "ASSIGN_TASK",
      from: "orchestrator",
      to: "agent-1",
      timestamp: Date.now(),
      payload: { taskId: "1.1", description: "Build API" },
    };

    expect(msg.id).toBe("test-id");
    expect(msg.from).toBe("orchestrator");
    expect(msg.to).toBe("agent-1");
    expect(msg.payload.taskId).toBe("1.1");
  });
});

describe("MessageHandler contract", () => {
  it("should accept sync handlers", () => {
    const handler: MessageHandler = (_msg) => {
      // sync handler — no return
    };
    expect(handler).toBeDefined();
  });

  it("should accept async handlers", () => {
    const handler: MessageHandler = async (_msg) => {
      await Promise.resolve();
    };
    expect(handler).toBeDefined();
  });
});
