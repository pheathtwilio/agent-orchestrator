import { describe, it, expect, vi } from "vitest";
import { generatePlanSummary } from "../plan-summary.js";
import type { TaskStore, TaskGraph, PlanUsage } from "@composio/ao-message-bus";

function makeGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: "plan-abc123",
    featureId: "feat-1",
    title: "Add user authentication",
    createdAt: 1700000000000,
    updatedAt: 1700003600000,
    nodes: [
      {
        id: "task-1",
        title: "Create login form",
        description: "Build the login UI",
        acceptanceCriteria: ["Form renders"],
        fileBoundary: ["src/login.tsx"],
        status: "complete",
        assignedTo: "session-1",
        model: "sonnet",
        skill: "frontend",
        dependsOn: [],
        branch: "feat/plan-abc123/1",
        result: null,
        createdAt: 1700000000000,
        updatedAt: 1700001800000,
      },
      {
        id: "task-2",
        title: "Add auth API",
        description: "Build the auth endpoint",
        acceptanceCriteria: ["Returns JWT"],
        fileBoundary: ["src/auth.ts"],
        status: "complete",
        assignedTo: "session-2",
        model: "sonnet",
        skill: "backend",
        dependsOn: [],
        branch: "feat/plan-abc123/2",
        result: null,
        createdAt: 1700000000000,
        updatedAt: 1700002400000,
      },
      {
        id: "task-3",
        title: "Add session middleware",
        description: "Session handling",
        acceptanceCriteria: ["Sessions persist"],
        fileBoundary: ["src/middleware.ts"],
        status: "failed",
        assignedTo: "session-3",
        model: "haiku",
        skill: "backend",
        dependsOn: ["task-2"],
        branch: "feat/plan-abc123/3",
        result: null,
        createdAt: 1700001800000,
        updatedAt: 1700003600000,
      },
    ],
    ...overrides,
  };
}

const mockUsage: PlanUsage = {
  sessions: {
    "session-1": {
      taskId: "task-1",
      skill: "frontend",
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadTokens: 1000,
      cacheCreationTokens: 500,
      costUsd: 0.05,
      updatedAt: 1700001800000,
    },
    "session-2": {
      taskId: "task-2",
      skill: "backend",
      inputTokens: 8000,
      outputTokens: 3000,
      cacheReadTokens: 2000,
      cacheCreationTokens: 800,
      costUsd: 0.08,
      updatedAt: 1700002400000,
    },
  },
  totals: {
    inputTokens: 13000,
    outputTokens: 5000,
    cacheReadTokens: 3000,
    cacheCreationTokens: 1300,
    costUsd: 0.13,
  },
};

function mockTaskStore(graph: TaskGraph | null, usage: PlanUsage = mockUsage): TaskStore {
  return {
    getGraph: vi.fn().mockResolvedValue(graph),
    getUsage: vi.fn().mockResolvedValue(usage),
    createGraph: vi.fn(),
    updateTask: vi.fn(),
    addNode: vi.fn(),
    getReadyTasks: vi.fn(),
    listGraphs: vi.fn(),
    deleteGraph: vi.fn(),
    archiveGraph: vi.fn(),
    unarchiveGraph: vi.fn(),
    listArchivedIds: vi.fn().mockResolvedValue(new Set()),
    updateGraphMetadata: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe("generatePlanSummary", () => {
  it("should return null for missing graph", async () => {
    const store = mockTaskStore(null);
    const result = await generatePlanSummary({
      planId: "plan-missing",
      outcome: "complete",
      taskStore: store,
    });
    expect(result).toBeNull();
  });

  it("should generate summary with correct task counts", async () => {
    const graph = makeGraph();
    const store = mockTaskStore(graph);

    const summary = await generatePlanSummary({
      planId: "plan-abc123",
      outcome: "failed",
      taskStore: store,
    });

    expect(summary).not.toBeNull();
    expect(summary!.planId).toBe("plan-abc123");
    expect(summary!.title).toBe("Add user authentication");
    expect(summary!.outcome).toBe("failed");
    expect(summary!.totals.total).toBe(3);
    expect(summary!.totals.complete).toBe(2);
    expect(summary!.totals.failed).toBe(1);
    expect(summary!.totals.pending).toBe(0);
  });

  it("should collect unique branches", async () => {
    const graph = makeGraph();
    const store = mockTaskStore(graph);

    const summary = await generatePlanSummary({
      planId: "plan-abc123",
      outcome: "complete",
      taskStore: store,
    });

    expect(summary!.branches).toHaveLength(3);
    expect(summary!.branches).toContain("feat/plan-abc123/1");
    expect(summary!.branches).toContain("feat/plan-abc123/2");
  });

  it("should include usage totals", async () => {
    const graph = makeGraph();
    const store = mockTaskStore(graph);

    const summary = await generatePlanSummary({
      planId: "plan-abc123",
      outcome: "complete",
      taskStore: store,
    });

    expect(summary!.usage).toEqual(mockUsage.totals);
    expect(summary!.sessionUsage).toEqual(mockUsage.sessions);
    expect(summary!.usage!.costUsd).toBe(0.13);
  });

  it("should calculate duration from graph timestamps", async () => {
    const graph = makeGraph();
    const store = mockTaskStore(graph);

    const summary = await generatePlanSummary({
      planId: "plan-abc123",
      outcome: "complete",
      taskStore: store,
    });

    expect(summary!.durationMs).toBe(3600000); // 1 hour
    expect(summary!.startedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("should include PR URL when provided", async () => {
    const graph = makeGraph();
    const store = mockTaskStore(graph);

    const summary = await generatePlanSummary({
      planId: "plan-abc123",
      outcome: "complete",
      prUrl: "https://github.com/org/repo/pull/42",
      taskStore: store,
    });

    expect(summary!.prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("should handle missing usage data gracefully", async () => {
    const graph = makeGraph();
    const store = mockTaskStore(graph);
    (store.getUsage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no data"));

    const summary = await generatePlanSummary({
      planId: "plan-abc123",
      outcome: "complete",
      taskStore: store,
    });

    expect(summary!.usage).toBeNull();
    expect(summary!.sessionUsage).toBeNull();
  });
});
