import { NextResponse } from "next/server";
import { resumePlan } from "@/lib/plan-executor";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/:id/resume — resume a plan by re-running only failed tasks.
 * Preserves completed tasks and their results.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — use defaults
  }

  const skipTesting = body.skipTesting === true;
  const maxConcurrency = typeof body.maxConcurrency === "number" ? body.maxConcurrency : 5;
  const project = typeof body.project === "string" ? body.project : undefined;

  try {
    const result = await resumePlan(planId, { skipTesting, maxConcurrency, project });
    return NextResponse.json({ planId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
