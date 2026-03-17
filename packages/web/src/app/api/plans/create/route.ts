import { NextResponse } from "next/server";
import { createAndExecutePlan } from "@/lib/plan-executor";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/create — create and auto-execute a plan.
 *
 * Decomposes the feature description into tasks, spawns agents,
 * and starts a background watch loop that drives the plan to completion.
 *
 * Body:
 *   - project: string (project ID from config)
 *   - description: string (feature to implement)
 *   - skipTesting?: boolean (default: false)
 *   - maxConcurrency?: number (default: 5)
 */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const project = body.project as string;
  const description = body.description as string;

  if (!project || !description) {
    return NextResponse.json(
      { error: "Missing required fields: project, description" },
      { status: 400 },
    );
  }

  const skipTesting = body.skipTesting === true;
  const maxConcurrency = typeof body.maxConcurrency === "number" ? body.maxConcurrency : 5;

  try {
    const result = await createAndExecutePlan({
      project,
      description,
      skipTesting,
      maxConcurrency,
    });

    return NextResponse.json({
      planId: result.planId,
      title: result.title,
      taskCount: result.taskCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
