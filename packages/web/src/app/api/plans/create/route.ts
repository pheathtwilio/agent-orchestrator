import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createAndExecutePlan } from "@/lib/plan-executor";
import { isEngineActive, createPlan as engineCreatePlan } from "@/lib/engine-bridge";
import { getActiveSnapshot } from "@/lib/workflow-store";
import { DEFAULT_WORKFLOW } from "@composio/ao-workflow-engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/create — create and auto-execute a plan.
 *
 * Decomposes the feature description into tasks, spawns agents,
 * and starts a background watch loop that drives the plan to completion.
 *
 * When AO_USE_WORKFLOW_ENGINE=true, routes through the new WorkflowEngine
 * instead of the legacy plan-executor.
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
    // Resolve the active workflow for plan creation
    const workflowData = getActiveSnapshot("default-sdlc");

    // Feature flag: route through WorkflowEngine when active
    if (isEngineActive()) {
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
        engine: true,
      });
    }

    // Legacy path: plan-executor
    const result = await createAndExecutePlan({
      project,
      description,
      skipTesting,
      maxConcurrency,
      workflowId: workflowData ? "default-sdlc" : undefined,
      workflowVersionId: workflowData?.versionId,
      workflowSnapshot: workflowData?.steps,
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
