import { NextResponse } from "next/server";
import { publishVersion } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/workflows/[id]/publish — publish a new version of the workflow
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const version = publishVersion(id);
    return NextResponse.json(version, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
