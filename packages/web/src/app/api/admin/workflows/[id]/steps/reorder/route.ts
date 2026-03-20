import { NextResponse } from "next/server";
import { reorderSteps } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/workflows/[id]/steps/reorder — reorder steps
 *
 * Body:
 *   - stepIds: string[] (ordered array of step IDs)
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

  const stepIds = body.stepIds;

  if (!Array.isArray(stepIds)) {
    return NextResponse.json(
      { error: "Missing required field: stepIds (array)" },
      { status: 400 },
    );
  }

  try {
    reorderSteps(id, stepIds as string[]);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
