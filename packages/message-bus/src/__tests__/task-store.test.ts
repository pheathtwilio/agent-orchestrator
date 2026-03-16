import { describe, it, expect } from "vitest";
import type { TaskNode, TaskGraph, TaskStatus } from "../types.js";

describe("TaskGraph types", () => {
  it("should define valid task statuses", () => {
    const statuses: TaskStatus[] = [
      "pending", "assigned", "in_progress", "testing", "complete", "failed", "blocked",
    ];
    expect(statuses).toHaveLength(7);
  });

  it("should build a task graph with dependencies", () => {
    const nodes: TaskNode[] = [
      {
        id: "1.1",
        title: "Build API endpoints",
        description: "Create REST endpoints for campaigns",
        acceptanceCriteria: ["GET /campaigns returns list"],
        fileBoundary: ["src/api/"],
        status: "pending",
        assignedTo: null,
        model: "claude-sonnet-4-20250514",
        skill: "backend",
        dependsOn: [],
        branch: null,
        result: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "1.2",
        title: "Build dashboard UI",
        description: "Create React dashboard for campaigns",
        acceptanceCriteria: ["Dashboard renders campaign list"],
        fileBoundary: ["src/components/"],
        status: "pending",
        assignedTo: null,
        model: "claude-sonnet-4-20250514",
        skill: "frontend",
        dependsOn: ["1.1"],
        branch: null,
        result: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const graph: TaskGraph = {
      id: "plan-test",
      featureId: "feat-1",
      title: "Campaign Dashboard",
      nodes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[1].dependsOn).toContain("1.1");
  });

  it("should identify ready tasks (deps satisfied)", () => {
    const nodes: TaskNode[] = [
      {
        id: "1",
        title: "Task A",
        description: "",
        acceptanceCriteria: [],
        fileBoundary: [],
        status: "complete",
        assignedTo: null,
        model: "",
        skill: "",
        dependsOn: [],
        branch: null,
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "2",
        title: "Task B (depends on A)",
        description: "",
        acceptanceCriteria: [],
        fileBoundary: [],
        status: "pending",
        assignedTo: null,
        model: "",
        skill: "",
        dependsOn: ["1"],
        branch: null,
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "3",
        title: "Task C (depends on B)",
        description: "",
        acceptanceCriteria: [],
        fileBoundary: [],
        status: "pending",
        assignedTo: null,
        model: "",
        skill: "",
        dependsOn: ["2"],
        branch: null,
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];

    const completedIds = new Set(
      nodes.filter((n) => n.status === "complete").map((n) => n.id),
    );

    const ready = nodes.filter(
      (node) =>
        node.status === "pending" &&
        node.dependsOn.every((depId) => completedIds.has(depId)),
    );

    // Only task B is ready (A is complete, B depends on A, C depends on B)
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("2");
  });
});
