import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** GET /api/plans/:id — get a single plan with full task details */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const taskStore = createTaskStore(REDIS_URL);

  try {
    const graph = await taskStore.getGraph(id);
    if (!graph) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    return NextResponse.json({ plan: graph });
  } finally {
    await taskStore.disconnect();
  }
}
