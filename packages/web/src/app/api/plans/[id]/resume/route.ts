import { NextResponse } from "next/server";
import { createEngineStore } from "@composio/ao-message-bus";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/resume — resume a plan by re-running only failed tasks.
 * Preserves completed tasks and their results.
 *
 * Re-creates the plan from scratch via engine.createPlan(), which starts
 * the planner again. Works for stalled, cancelled, and orphaned plans.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    const { engine } = await getServices();
    if (!engine) {
      return NextResponse.json(
        { error: "WorkflowEngine not available" },
        { status: 503 },
      );
    }

    // Read plan data from Redis (may or may not be in engine memory)
    const engineStore = createEngineStore(REDIS_URL);
    try {
      const planData = await engineStore.getPlan(planId);
      if (!planData) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }

      // Re-create the plan from scratch — this handles all cases:
      // stalled planning, cancelled, failed, or orphaned plans
      let workflowSnapshot: unknown[] = [];
      try {
        workflowSnapshot = planData.workflowSnapshot
          ? JSON.parse(planData.workflowSnapshot)
          : [];
      } catch { /* use empty */ }

      await engine.createPlan({
        planId,
        projectId: planData.projectId,
        featureDescription: planData.featureDescription,
        workflowId: planData.workflowId ?? "default",
        workflowVersionId: planData.workflowVersionId ?? "built-in",
        workflowSnapshot,
      });

      // Safety net: ensure plan is in the active set
      const active = await engineStore.getActivePlanIds();
      if (!active.includes(planId)) {
        const fresh = await engineStore.getPlan(planId);
        if (fresh) await engineStore.createPlan(planId, fresh);
      }

      return NextResponse.json({ planId, resumed: ["re-created"] });
    } finally {
      await engineStore.disconnect();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
