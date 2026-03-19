import { NextResponse } from "next/server";
import { createAndExecuteCleanupPlan } from "@/lib/plan-executor";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/cleanup — create and execute a cleanup plan.
 *
 * Removes stopped containers, stale worktrees, orphan branches,
 * and optionally old plans from Redis. Shows up as a plan in the
 * dashboard with per-step progress.
 *
 * Body (all optional):
 *   - project?: string (project ID, defaults to first configured)
 *   - containers?: boolean (default: true)
 *   - worktrees?: boolean (default: true)
 *   - branches?: boolean (default: true)
 *   - maxPlanAgeDays?: number (default: 7, 0 = skip)
 */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // All fields are optional — empty body is fine
  }

  try {
    const result = await createAndExecuteCleanupPlan({
      project: (body.project as string) || undefined,
      containers: body.containers !== false,
      worktrees: body.worktrees !== false,
      branches: body.branches !== false,
      maxPlanAgeDays: typeof body.maxPlanAgeDays === "number" ? body.maxPlanAgeDays : 7,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
