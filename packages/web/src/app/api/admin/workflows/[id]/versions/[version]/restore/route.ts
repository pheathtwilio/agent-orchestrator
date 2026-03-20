import { NextResponse } from "next/server";
import { restoreVersion } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/workflows/[id]/versions/[version]/restore — restore a previous version
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
): Promise<Response> {
  const { id, version } = await params;

  const versionNumber = parseInt(version, 10);
  if (isNaN(versionNumber)) {
    return NextResponse.json({ error: "Invalid version number" }, { status: 400 });
  }

  try {
    restoreVersion(id, versionNumber);
    return NextResponse.json({ restored: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
