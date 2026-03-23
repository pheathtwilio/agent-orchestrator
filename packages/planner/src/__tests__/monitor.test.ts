import { describe, it, expect, vi } from "vitest";
import { createMonitor, DEFAULT_MONITOR_CONFIG } from "../monitor.js";
import type { MonitorDeps } from "../monitor.js";

function createMockDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    messageBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getHistory: vi.fn(),
      disconnect: vi.fn(),
      subscribeOutput: vi.fn(),
      unsubscribeOutput: vi.fn(),
      subscribeGroup: vi.fn(),
      ack: vi.fn(),
      autoClaim: vi.fn(),
      createGroup: vi.fn(),
    },
    fileLocks: {
      acquire: vi.fn(),
      release: vi.fn(),
      releaseAll: vi.fn(),
      getOwner: vi.fn(),
      listAll: vi.fn().mockResolvedValue([]),
      detectDeadlocks: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn(),
    },
    getSessionOutput: vi.fn().mockResolvedValue("some output"),
    isSessionAlive: vi.fn().mockResolvedValue(true),
    killSession: vi.fn(),
    respawnWithSummary: vi.fn().mockResolvedValue("new-session-id"),
    ...overrides,
  };
}

describe("Monitor", () => {
  it("should track and untrack sessions", () => {
    const deps = createMockDeps();
    const monitor = createMonitor(deps);

    monitor.track("plan-1", "task-1", "session-1");
    monitor.untrack("session-1");
    // No error — untrack is idempotent
    monitor.untrack("session-1");
  });

  it("should detect dead sessions", async () => {
    const deps = createMockDeps({
      isSessionAlive: vi.fn().mockResolvedValue(false),
    });
    const monitor = createMonitor(deps);

    monitor.track("plan-1", "task-1", "session-1");
    const results = await monitor.check();

    expect(results).toHaveLength(1);
    expect(results[0].issue).toBe("dead");
    expect(results[0].sessionId).toBe("session-1");
  });

  it("should detect stuck sessions after stale checks threshold", async () => {
    let callCount = 0;
    const deps = createMockDeps({
      // Return the same output every time
      getSessionOutput: vi.fn().mockImplementation(async () => {
        callCount++;
        return "same output every time";
      }),
    });

    const monitor = createMonitor(deps, {
      staleOutputChecks: 2,
      stuckThresholdMs: 0, // immediate
    });

    monitor.track("plan-1", "task-1", "session-1");

    // First check — establishes baseline
    await monitor.check();
    // Second check — same output, staleChecks = 1
    await monitor.check();
    // Third check — same output, staleChecks = 2 >= threshold
    const results = await monitor.check();

    expect(results.some((r) => r.issue === "stuck")).toBe(true);
  });

  it("should not flag active sessions as stuck", async () => {
    let output = "output-1";
    const deps = createMockDeps({
      getSessionOutput: vi.fn().mockImplementation(async () => output),
    });

    const monitor = createMonitor(deps, {
      staleOutputChecks: 2,
      stuckThresholdMs: 0,
    });

    monitor.track("plan-1", "task-1", "session-1");

    await monitor.check();
    output = "output-2"; // Different output
    await monitor.check();
    output = "output-3"; // Different again
    const results = await monitor.check();

    expect(results.filter((r) => r.issue === "stuck")).toHaveLength(0);
  });

  it("should start and stop polling", () => {
    const deps = createMockDeps();
    const monitor = createMonitor(deps, { pollIntervalMs: 100000 });

    monitor.start();
    monitor.start(); // Idempotent
    monitor.stop();
    monitor.stop(); // Idempotent
  });
});
