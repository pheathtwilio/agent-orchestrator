import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";
import { cancelPlan, getPlanState } from "@/lib/engine-bridge";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/cancel — cancel a running plan.
 *
 * Routes through WorkflowEngine for engine-managed plans.
 * Falls back to direct Redis updates for legacy plans.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    const { sessionManager } = await getServices();

    // Engine-managed plan — use the state machine
    if (getPlanState(planId)) {
      await cancelPlan(planId);
      return NextResponse.json({ planId, cancelled: true });
    }

    // Legacy plan — update tasks directly in Redis
    const taskStore = createTaskStore(REDIS_URL);
    try {
      const graph = await taskStore.getGraph(planId);
      if (!graph) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }

      const killed: string[] = [];
      let cancelled = 0;

      for (const node of graph.nodes) {
        if (!["complete", "failed"].includes(node.status)) {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
