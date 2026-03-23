import { NextResponse } from "next/server";
import { createTaskStore, createEngineStore } from "@composio/ao-message-bus";
import { cancelPlan, getPlanState } from "@/lib/engine-bridge";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/cancel — cancel a running plan.
 *
 * Routes through WorkflowEngine for engine-managed plans.
 * Falls back to direct Redis updates for legacy and orphaned engine plans.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    const { sessionManager } = await getServices();

    // Engine-managed plan in memory — use the state machine
    if (getPlanState(planId)) {
      await cancelPlan(planId);
      return NextResponse.json({ planId, cancelled: true });
    }

    // Try legacy store first
    const taskStore = createTaskStore(REDIS_URL);
    try {
      const graph = await taskStore.getGraph(planId);
      if (graph) {
        const killed: string[] = [];
        let cancelled = 0;

        for (const node of graph.nodes) {
          if (!["complete", "failed"].includes(node.status)) {
            if (node.assignedTo) {
              try {
                await sessionManager.kill(node.assignedTo);
                killed.push(node.assignedTo);
              } catch { /* Container may already be gone */ }
            }
            await taskStore.updateTask(planId, node.id, {
              status: "failed",
              assignedTo: null,
            });
            cancelled++;
          }
        }

        return NextResponse.json({ planId, cancelled, killed });
      }
    } finally {
      await taskStore.disconnect();
    }

    // Orphaned engine plan — exists in Redis but not in engine memory
    const engineStore = createEngineStore(REDIS_URL);
    try {
      const planData = await engineStore.getPlan(planId);
      if (!planData) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }

      // Kill any containers matching this plan
      const killed: string[] = [];
      const tasks = await engineStore.getAllTasks(planId);
      for (const [taskId, json] of Object.entries(tasks)) {
        const task = JSON.parse(json);
        const containerName = `ao--${planId}--${taskId}`;
        if (task.status !== "complete" && task.status !== "failed") {
          try {
            await sessionManager.kill(containerName);
            killed.push(containerName);
          } catch { /* Container may already be gone */ }
          await engineStore.atomicUpdate(planId, [
            { type: "SET_TASK", taskId, data: JSON.stringify({ ...task, status: "failed" }) },
          ]);
        }
      }

      // Mark plan as cancelled — keep in active set so it remains visible
      await engineStore.atomicUpdate(planId, [
        { type: "SET_PLAN_FIELD", field: "phase", value: "cancelled" },
      ]);

      return NextResponse.json({ planId, cancelled: true, killed });
    } finally {
      await engineStore.disconnect();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
