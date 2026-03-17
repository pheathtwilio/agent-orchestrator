import type { PlanUsage, TaskStore } from "@composio/ao-message-bus";

// ============================================================================
// TYPES
// ============================================================================

export interface PlanSummary {
  planId: string;
  title: string;
  outcome: "complete" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tasks: TaskSummary[];
  totals: {
    total: number;
    complete: number;
    failed: number;
    pending: number;
  };
  branches: string[];
  prUrl: string | null;
  usage: PlanUsage["totals"] | null;
  sessionUsage: PlanUsage["sessions"] | null;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  skill: string;
  model: string;
  branch: string | null;
  assignedTo: string | null;
  durationMs: number | null;
}

// ============================================================================
// GENERATOR
// ============================================================================

export interface GenerateSummaryInput {
  planId: string;
  outcome: "complete" | "failed" | "cancelled";
  prUrl?: string | null;
  taskStore: TaskStore;
}

/**
 * Generate a structured summary for a completed, failed, or cancelled plan.
 *
 * Reads the task graph and usage data from Redis and produces a PlanSummary
 * that can be stored back to Redis and served via the API.
 */
export async function generatePlanSummary(
  input: GenerateSummaryInput,
): Promise<PlanSummary | null> {
  const { planId, outcome, prUrl, taskStore } = input;

  const graph = await taskStore.getGraph(planId);
  if (!graph) return null;

  let usage: PlanUsage["totals"] | null = null;
  let sessionUsage: PlanUsage["sessions"] | null = null;
  try {
    const planUsage = await taskStore.getUsage(planId);
    usage = planUsage.totals;
    sessionUsage = planUsage.sessions;
  } catch {
    // Usage data may not be available
  }

  const tasks: TaskSummary[] = graph.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    status: node.status,
    skill: node.skill,
    model: node.model,
    branch: node.branch,
    assignedTo: node.assignedTo,
    durationMs:
      node.updatedAt && node.createdAt ? node.updatedAt - node.createdAt : null,
  }));

  const branches = graph.nodes
    .map((n) => n.branch)
    .filter((b): b is string => b !== null);

  const uniqueBranches = [...new Set(branches)];

  const complete = graph.nodes.filter((n) => n.status === "complete").length;
  const failed = graph.nodes.filter((n) => n.status === "failed").length;
  const pending = graph.nodes.filter(
    (n) => !["complete", "failed"].includes(n.status),
  ).length;

  const durationMs = graph.updatedAt - graph.createdAt;

  return {
    planId,
    title: graph.title,
    outcome,
    startedAt: new Date(graph.createdAt).toISOString(),
    finishedAt: new Date(graph.updatedAt).toISOString(),
    durationMs,
    tasks,
    totals: {
      total: graph.nodes.length,
      complete,
      failed,
      pending,
    },
    branches: uniqueBranches,
    prUrl: prUrl ?? null,
    usage,
    sessionUsage,
  };
}
