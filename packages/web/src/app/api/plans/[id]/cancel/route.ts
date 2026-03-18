import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";
import { stopPlanWatcher } from "@/lib/plan-executor";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/cancel — cancel a running plan.
 *
 * Stops the background watcher, kills active agent containers,
 * and marks all in-progress/pending tasks as failed.
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

    const { sessionManager } = await getServices();
    const killed: string[] = [];

    // Kill active agent containers and mark non-terminal tasks as failed
    let cancelled = 0;
    for (const node of graph.nodes) {
      if (!["complete", "failed"].includes(node.status)) {
        // Kill the container if the task has an assigned agent
        if (node.assignedTo) {
          try {
            await sessionManager.kill(node.assignedTo);
            killed.push(node.assignedTo);
          } catch {
            // Container may already be gone
          }
        }

        await taskStore.updateTask(planId, node.id, {
          status: "failed",
          assignedTo: null,
        });
        cancelled++;
      }
    }

    return NextResponse.json({ planId, cancelled, killed });
  } finally {
    await taskStore.disconnect();
  }
}
