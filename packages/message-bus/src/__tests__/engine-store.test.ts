import { describe, it, expect } from "vitest";
import type { EngineStore } from "../types.js";

describe("EngineStore contract", () => {
  it("should define all required methods", () => {
    // Type-level check — ensure the interface has all expected methods
    const methods: (keyof EngineStore)[] = [
      "createPlan",
      "getPlan",
      "atomicUpdate",
      "getTask",
      "getAllTasks",
      "getActivePlanIds",
      "deactivatePlan",
      "registerContainer",
      "lookupContainer",
      "removeContainer",
      "updateHeartbeat",
      "getHeartbeats",
      "disconnect",
    ];

    expect(methods).toHaveLength(13);
  });
});
