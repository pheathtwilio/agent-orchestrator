import { describe, it, expect, vi } from "vitest";
import { parseContainerName, ContainerManager, containerName } from "../container-manager.js";

describe("parseContainerName", () => {
  it("parses ao--planId--taskId format", () => {
    const result = parseContainerName("ao--plan-44c00107--1.4");
    expect(result).toEqual({ planId: "plan-44c00107", taskId: "1.4" });
  });

  it("returns null for non-engine containers", () => {
    expect(parseContainerName("redis-server")).toBeNull();
    expect(parseContainerName("ao-old-format")).toBeNull();
  });

  it("handles task IDs with dots", () => {
    const result = parseContainerName("ao--plan-abc--doctor-1.3.2");
    expect(result).toEqual({ planId: "plan-abc", taskId: "doctor-1.3.2" });
  });
});

describe("containerName", () => {
  it("creates deterministic name", () => {
    expect(containerName("plan-1", "1.1")).toBe("ao--plan-1--1.1");
  });
});

describe("ContainerManager", () => {
  it("reconciliation: detects orphan container (no matching task)", async () => {
    const mockDeps = {
      listContainers: vi.fn().mockResolvedValue([
        { name: "ao--plan-1--1.1", state: "running" },
      ]),
      lookupContainer: vi.fn().mockResolvedValue({ planId: "plan-1", taskId: "1.1" }),
      getRunningTasks: vi.fn().mockResolvedValue(new Map()),
      killContainer: vi.fn(),
      feedEvent: vi.fn(),
      getHeartbeats: vi.fn().mockResolvedValue({}),
    };

    const mgr = new ContainerManager(mockDeps as any);
    await mgr.reconcile();

    expect(mockDeps.killContainer).toHaveBeenCalledWith("ao--plan-1--1.1");
  });

  it("reconciliation: detects orphan task (running status, no container)", async () => {
    const mockDeps = {
      listContainers: vi.fn().mockResolvedValue([]),
      lookupContainer: vi.fn().mockResolvedValue(null),
      getRunningTasks: vi.fn().mockResolvedValue(
        new Map([["plan-1:1.1", { planId: "plan-1", taskId: "1.1" }]])
      ),
      killContainer: vi.fn(),
      feedEvent: vi.fn(),
      getHeartbeats: vi.fn().mockResolvedValue({}),
    };

    const mgr = new ContainerManager(mockDeps as any);
    await mgr.reconcile();

    expect(mockDeps.feedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONTAINER_DIED", planId: "plan-1", taskId: "1.1" })
    );
  });

  it("heartbeat timeout: feeds HEARTBEAT_TIMEOUT for stale tasks", async () => {
    const now = Date.now();
    const mockDeps = {
      listContainers: vi.fn().mockResolvedValue([
        { name: "ao--plan-1--1.1", state: "running" },
      ]),
      lookupContainer: vi.fn().mockResolvedValue({ planId: "plan-1", taskId: "1.1" }),
      getRunningTasks: vi.fn().mockResolvedValue(
        new Map([["plan-1:1.1", { planId: "plan-1", taskId: "1.1" }]])
      ),
      killContainer: vi.fn(),
      feedEvent: vi.fn(),
      getHeartbeats: vi.fn().mockResolvedValue({
        "plan-1:1.1": now - 6 * 60 * 1000,
      }),
    };

    const mgr = new ContainerManager(mockDeps as any);
    await mgr.reconcile();

    expect(mockDeps.feedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "HEARTBEAT_TIMEOUT", planId: "plan-1", taskId: "1.1" })
    );
  });

  it("does not fire events for healthy containers with fresh heartbeats", async () => {
    const now = Date.now();
    const mockDeps = {
      listContainers: vi.fn().mockResolvedValue([
        { name: "ao--plan-1--1.1", state: "running" },
      ]),
      lookupContainer: vi.fn().mockResolvedValue({ planId: "plan-1", taskId: "1.1" }),
      getRunningTasks: vi.fn().mockResolvedValue(
        new Map([["plan-1:1.1", { planId: "plan-1", taskId: "1.1" }]])
      ),
      killContainer: vi.fn(),
      feedEvent: vi.fn(),
      getHeartbeats: vi.fn().mockResolvedValue({
        "plan-1:1.1": now - 60 * 1000, // 1 min ago — healthy
      }),
    };

    const mgr = new ContainerManager(mockDeps as any);
    await mgr.reconcile();

    expect(mockDeps.feedEvent).not.toHaveBeenCalled();
    expect(mockDeps.killContainer).not.toHaveBeenCalled();
  });
});

describe("Docker event stream", () => {
  it("parses container die event and feeds CONTAINER_DIED", () => {
    const result = parseContainerName("ao--plan-1--1.1");
    expect(result).toEqual({ planId: "plan-1", taskId: "1.1" });
  });
});
