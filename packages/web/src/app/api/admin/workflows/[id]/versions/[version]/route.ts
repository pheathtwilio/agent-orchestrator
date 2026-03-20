import { NextResponse } from "next/server";
import { getVersion } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/workflows/[id]/versions/[version] — retrieve a specific version
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
): Promise<Response> {
  const { id, version } = await params;

  const versionNumber = parseInt(version, 10);
  if (isNaN(versionNumber)) {
    return NextResponse.json({ error: "Invalid version number" }, { status: 400 });
  }

  try {
    const versionData = getVersion(id, versionNumber);
    if (!versionData) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }

    return NextResponse.json(versionData);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
