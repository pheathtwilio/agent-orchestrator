import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/archive — archive a plan (hide from default list)
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;
  const taskStore = createTaskStore(REDIS_URL);
  try {
    await taskStore.archiveGraph(planId);
    return NextResponse.json({ archived: true, planId });
  } finally {
    await taskStore.disconnect();
  }
}

/**
 * DELETE /api/plans/:id/archive — unarchive a plan
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;
  const taskStore = createTaskStore(REDIS_URL);
  try {
    await taskStore.unarchiveGraph(planId);
    return NextResponse.json({ archived: false, planId });
  } finally {
    await taskStore.disconnect();
  }
}
