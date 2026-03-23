import { NextResponse } from "next/server";
import { retryPlan } from "@/lib/engine-bridge";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/:id/retry — cancel the current plan and re-execute it.
 *
 * Resets all tasks to pending, kills running containers,
 * then re-spawns agents for the same plan.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    await getServices();
    await retryPlan(planId);
    return NextResponse.json({ planId, retried: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
