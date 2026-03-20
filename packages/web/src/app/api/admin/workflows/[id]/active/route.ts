import { NextResponse } from "next/server";
import { getActiveSnapshot } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/workflows/[id]/active — retrieve the active version snapshot
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const activeSnapshot = getActiveSnapshot(id);
    if (!activeSnapshot) {
      return NextResponse.json({ error: "No active version found" }, { status: 404 });
    }

    return NextResponse.json(activeSnapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
