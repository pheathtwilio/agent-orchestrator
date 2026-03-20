import { NextResponse } from "next/server";
import { getSteps, addStep } from "@/lib/workflow-store";
import type { WorkflowStep } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/workflows/[id]/steps — retrieve all steps for a workflow
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const steps = getSteps(id);
    return NextResponse.json({ steps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/admin/workflows/[id]/steps — create a new step
 *
 * Body: step fields (name, description, exit_criteria, failure_policy, agent_config, is_conditional, condition, sort_order)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    name,
    description,
    exit_criteria,
    failure_policy,
    agent_config,
    is_conditional,
    condition,
    sort_order,
  } = body;

  if (
    !name ||
    !description ||
    !exit_criteria ||
    !failure_policy ||
    !agent_config ||
    is_conditional === undefined ||
    sort_order === undefined
  ) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: name, description, exit_criteria, failure_policy, agent_config, is_conditional, sort_order",
      },
      { status: 400 },
    );
  }

  try {
    const step: Omit<WorkflowStep, "id" | "workflow_id"> = {
      sort_order: sort_order as number,
      name: name as string,
      description: description as string,
      exit_criteria: exit_criteria as WorkflowStep["exit_criteria"],
      failure_policy: failure_policy as WorkflowStep["failure_policy"],
      agent_config: agent_config as WorkflowStep["agent_config"],
      is_conditional: is_conditional as boolean,
      condition: (condition as WorkflowStep["condition"]) ?? null,
    };

    const createdStep = addStep(id, step);
    return NextResponse.json(createdStep, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
