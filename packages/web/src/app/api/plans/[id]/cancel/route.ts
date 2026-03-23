import { NextResponse } from "next/server";
import { cancelPlan } from "@/lib/engine-bridge";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/:id/cancel — cancel a running plan.
 *
 * Sends PLAN_CANCELLED event to the WorkflowEngine which kills
 * all active containers and marks tasks as failed.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    await getServices();
    await cancelPlan(planId);
    return NextResponse.json({ planId, cancelled: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
