import { NextResponse } from "next/server";
import { getWorkflows, createWorkflow } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/workflows — retrieve all workflows
 */
export async function GET(): Promise<Response> {
  try {
    const workflows = getWorkflows();
    return NextResponse.json({ workflows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/admin/workflows — create a new workflow
 *
 * Body:
 *   - id: string (unique workflow ID)
 *   - name: string (workflow name)
 *   - description: string (workflow description)
 */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = body.id as string;
  const name = body.name as string;
  const description = body.description as string;

  if (!id || !name || !description) {
    return NextResponse.json(
      { error: "Missing required fields: id, name, description" },
      { status: 400 },
    );
  }

  try {
    const workflow = createWorkflow(id, name, description);
    return NextResponse.json(workflow, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
