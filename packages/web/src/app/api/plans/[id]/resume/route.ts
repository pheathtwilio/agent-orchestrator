import { NextResponse } from "next/server";
import { resumePlan } from "@/lib/engine-bridge";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/:id/resume — resume a plan by re-running only failed tasks.
 * Preserves completed tasks and their results.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  try {
    await getServices();
    const result = await resumePlan(planId);
    return NextResponse.json({ planId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
