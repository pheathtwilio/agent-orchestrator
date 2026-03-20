import { NextResponse } from "next/server";
import { updateStep, removeStep } from "@/lib/workflow-store";
import type { WorkflowStep } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/workflows/[id]/steps/[stepId] — update a step
 *
 * Body: partial step fields
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
): Promise<Response> {
  const { stepId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const updates: Partial<WorkflowStep> = {};

    if (body.name !== undefined) updates.name = body.name as string;
    if (body.description !== undefined) updates.description = body.description as string;
    if (body.exit_criteria !== undefined)
      updates.exit_criteria = body.exit_criteria as WorkflowStep["exit_criteria"];
    if (body.failure_policy !== undefined)
      updates.failure_policy = body.failure_policy as WorkflowStep["failure_policy"];
    if (body.agent_config !== undefined)
      updates.agent_config = body.agent_config as WorkflowStep["agent_config"];
    if (body.is_conditional !== undefined)
      updates.is_conditional = body.is_conditional as boolean;
    if (body.condition !== undefined)
      updates.condition = body.condition as WorkflowStep["condition"];
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order as number;

    const updatedStep = updateStep(stepId, updates);

    if (!updatedStep) {
      return NextResponse.json({ error: "Step not found" }, { status: 404 });
    }

    return NextResponse.json(updatedStep);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/workflows/[id]/steps/[stepId] — delete a step
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
): Promise<Response> {
  const { stepId } = await params;

  try {
    const deleted = removeStep(stepId);
    if (!deleted) {
      return NextResponse.json({ error: "Step not found" }, { status: 404 });
    }

    return NextResponse.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
