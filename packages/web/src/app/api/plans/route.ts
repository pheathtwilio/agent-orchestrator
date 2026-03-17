import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * GET /api/plans — list all plans.
 *
 * Query params:
 *   - include=archived — also show archived plans
 *   - archived=only — show only archived plans
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const include = searchParams.get("include");
  const archivedOnly = searchParams.get("archived") === "only";

  const taskStore = createTaskStore(REDIS_URL);

  try {
    const archivedSet = await taskStore.listArchivedIds();
    const graphs = await taskStore.listGraphs();

    let filtered = graphs;
    if (archivedOnly) {
      filtered = graphs.filter((g) => archivedSet.has(g.id));
    } else if (include !== "archived") {
      filtered = graphs.filter((g) => !archivedSet.has(g.id));
    }

    const plans = filtered.map((graph) => {
      const complete = graph.nodes.filter((n) => n.status === "complete").length;
      const inProgress = graph.nodes.filter((n) => n.status === "in_progress").length;
      const pending = graph.nodes.filter((n) => n.status === "pending").length;
      const failed = graph.nodes.filter((n) => n.status === "failed").length;
      const total = graph.nodes.length;

      return {
        id: graph.id,
        featureId: graph.featureId,
        title: graph.title,
        taskCount: total,
        complete,
        inProgress,
        pending,
        failed,
        progressPercent: total > 0 ? Math.round((complete / total) * 100) : 0,
        createdAt: graph.createdAt,
        updatedAt: graph.updatedAt,
        archived: archivedSet.has(graph.id),
      };
    });

    return NextResponse.json({ plans });
  } finally {
    await taskStore.disconnect();
  }
}
