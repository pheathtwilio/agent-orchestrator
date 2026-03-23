import { NextResponse } from "next/server";
import { resumePlan, getPlanState } from "@/lib/engine-bridge";
import { createEngineStore } from "@composio/ao-message-bus";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/resume — resume a plan by re-running only failed tasks.
 * Preserves completed tasks and their results.
 *
 * If the plan is in engine memory, delegates to the engine's resumePlan.
 * If the plan is orphaned (in Redis but not memory), cancels and re-creates it
 * so the engine picks it up fresh.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    const { engine } = await getServices();

    // Plan is in engine memory — use the state machine
    if (getPlanState(planId)) {
      const result = await resumePlan(planId);
      return NextResponse.json({ planId, ...result });
    }

    // Orphaned engine plan — re-create it so the engine picks it up
    if (!engine) {
      return NextResponse.json(
        { error: "WorkflowEngine not available" },
        { status: 503 },
      );
    }

    const engineStore = createEngineStore(REDIS_URL);
    try {
      const planData = await engineStore.getPlan(planId);
      if (!planData) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }

      // Clean up the old plan from the active set
      await engineStore.deactivatePlan(planId);

      // Parse workflow snapshot
      let workflowSnapshot: unknown[] = [];
      try {
        workflowSnapshot = planData.workflowSnapshot
          ? JSON.parse(planData.workflowSnapshot)
          : [];
      } catch { /* use empty */ }

      // Re-create via the engine so it gets proper in-memory state
      await engine.createPlan({
        planId,
        projectId: planData.projectId,
        featureDescription: planData.featureDescription,
        workflowId: planData.workflowId ?? "default",
        workflowVersionId: planData.workflowVersionId ?? "built-in",
        workflowSnapshot,
      });

      return NextResponse.json({ planId, resumed: ["re-created from Redis"] });
    } finally {
      await engineStore.disconnect();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
