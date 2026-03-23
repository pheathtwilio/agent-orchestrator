import { NextResponse } from "next/server";
import { approvePlan } from "@/lib/engine-bridge";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/:id/approve — approve a plan in "reviewing" state.
 *
 * Transitions the plan from reviewing -> executing, spawning tasks
 * for the first workflow step.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    await getServices();
    await approvePlan(planId);
    return NextResponse.json({ planId, approved: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
