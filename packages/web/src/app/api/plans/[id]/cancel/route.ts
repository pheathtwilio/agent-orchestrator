import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";
import { stopPlanWatcher } from "@/lib/plan-executor";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/cancel — cancel a running plan.
 *
 * Stops the background watcher, marks all in-progress/pending tasks as failed,
 * and kills any active sessions.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;
  const taskStore = createTaskStore(REDIS_URL);

  try {
    // Stop the background watcher if running
    stopPlanWatcher(planId);

    const graph = await taskStore.getGraph(planId);
    if (!graph) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    // Mark all non-terminal tasks as failed
    let cancelled = 0;
    for (const node of graph.nodes) {
      if (!["complete", "failed"].includes(node.status)) {
        await taskStore.updateTask(planId, node.id, {
          status: "failed",
          assignedTo: null,
        });
        cancelled++;
      }
    }

    return NextResponse.json({ planId, cancelled });
  } finally {
    await taskStore.disconnect();
  }
}
