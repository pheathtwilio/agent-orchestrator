import { NextResponse } from "next/server";
import { getVersions } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/workflows/[id]/versions — retrieve all versions for a workflow
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const versions = getVersions(id);
    return NextResponse.json({ versions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
