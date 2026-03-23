import { describe, it, expect } from "vitest";
import { createMessageBus } from "../bus.js";

describe("MessageBus consumer group contract", () => {
  it("should define subscribeGroup on the interface", () => {
    const bus = createMessageBus();
    expect(typeof bus.subscribeGroup).toBe("function");
  });

  it("should define ack on the interface", () => {
    const bus = createMessageBus();
    expect(typeof bus.ack).toBe("function");
  });

  it("should define autoClaim on the interface", () => {
    const bus = createMessageBus();
    expect(typeof bus.autoClaim).toBe("function");
  });

  it("should define createGroup on the interface", () => {
    const bus = createMessageBus();
    expect(typeof bus.createGroup).toBe("function");
  });
});
