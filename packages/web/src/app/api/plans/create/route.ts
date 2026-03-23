import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createPlan as engineCreatePlan } from "@/lib/engine-bridge";
import { getActiveSnapshot } from "@/lib/workflow-store";
import { getServices } from "@/lib/services";
import { DEFAULT_WORKFLOW } from "@composio/ao-workflow-engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/create — create and auto-execute a plan.
 *
 * Decomposes the feature description into tasks, spawns agents,
 * and drives the plan to completion via the WorkflowEngine.
 *
 * Body:
 *   - project: string (project ID from config)
 *   - description: string (feature to implement)
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

  try {
    // Ensure services (including engine) are initialized
    await getServices();

    // Resolve the active workflow for plan creation
    const workflowData = getActiveSnapshot("default-sdlc");
    const planId = `plan-${randomUUID().slice(0, 8)}`;

    await engineCreatePlan({
      planId,
      projectId: project,
      featureDescription: description,
      workflowId: workflowData ? "default-sdlc" : "default",
      workflowVersionId: workflowData?.versionId ?? "built-in",
      workflowSnapshot: workflowData?.steps ?? DEFAULT_WORKFLOW,
    });

    return NextResponse.json({
      planId,
      title: description,
      taskCount: 0, // Planner will decompose asynchronously
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
