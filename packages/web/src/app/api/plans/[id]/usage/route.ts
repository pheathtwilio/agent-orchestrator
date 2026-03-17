import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * GET /api/plans/:id/usage — token usage breakdown for a plan.
 *
 * Returns per-session usage and aggregated totals (tokens, cost).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;
  const taskStore = createTaskStore(REDIS_URL);

  try {
    const graph = await taskStore.getGraph(planId);
    if (!graph) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    const usage = await taskStore.getUsage(planId);

    return NextResponse.json({
      planId,
      title: graph.title,
      ...usage,
    });
  } finally {
    await taskStore.disconnect();
  }
}
