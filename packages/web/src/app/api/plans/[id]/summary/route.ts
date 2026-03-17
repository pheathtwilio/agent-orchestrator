import { NextResponse } from "next/server";
import { createTaskStore, createSummaryStore } from "@composio/ao-message-bus";
import { generatePlanSummary } from "@composio/ao-planner";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * GET /api/plans/:id/summary — get the completion summary for a plan.
 *
 * Returns a cached summary if one exists in Redis, otherwise generates
 * one on the fly from the current task graph and usage data.
 *
 * Query params:
 *   - refresh=true  — regenerate even if a cached summary exists
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "true";

  const summaryStore = createSummaryStore(REDIS_URL);
  const taskStore = createTaskStore(REDIS_URL);

  try {
    // Check for cached summary first
    if (!refresh) {
      const cached = await summaryStore.get(planId);
      if (cached) {
        return NextResponse.json({ summary: cached, cached: true });
      }
    }

    // Generate from current state
    const graph = await taskStore.getGraph(planId);
    if (!graph) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    // Infer outcome from task statuses
    const allComplete = graph.nodes.every((n) => n.status === "complete");
    const anyFailed = graph.nodes.some((n) => n.status === "failed");
    const outcome = allComplete ? "complete" : anyFailed ? "failed" : "complete";

    const summary = await generatePlanSummary({
      planId,
      outcome,
      taskStore,
    });

    if (!summary) {
      return NextResponse.json({ error: "Could not generate summary" }, { status: 500 });
    }

    // Cache it
    await summaryStore.store(summary);

    return NextResponse.json({ summary, cached: false });
  } finally {
    await summaryStore.disconnect();
    await taskStore.disconnect();
  }
}
