import { describe, it, expect } from "vitest";
import type { FileLock, FileLockRegistry } from "../types.js";

describe("FileLock types", () => {
  it("should define a file lock with required fields", () => {
    const lock: FileLock = {
      filePath: "src/api/routes.ts",
      owner: "task-1.1",
      acquiredAt: Date.now(),
    };

    expect(lock.filePath).toBe("src/api/routes.ts");
    expect(lock.owner).toBe("task-1.1");
    expect(lock.acquiredAt).toBeGreaterThan(0);
  });
});

describe("FileLockRegistry contract", () => {
  it("should define all required methods", () => {
    // Type-level check — ensure the interface has all expected methods
    const methods: (keyof FileLockRegistry)[] = [
      "acquire",
      "release",
      "releaseAll",
      "getOwner",
      "listAll",
      "detectDeadlocks",
      "disconnect",
    ];

    expect(methods).toHaveLength(7);
  });
});
