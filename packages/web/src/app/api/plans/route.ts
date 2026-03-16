import { NextResponse } from "next/server";
import {
  createMessageBus,
  createFileLockRegistry,
  createTaskStore,
} from "@composio/ao-message-bus";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** GET /api/plans — list all active plans */
export async function GET(): Promise<Response> {
  const taskStore = createTaskStore(REDIS_URL);
  try {
    const graphs = await taskStore.listGraphs();

    const plans = graphs.map((graph) => {
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
      };
    });

    return NextResponse.json({ plans });
  } finally {
    await taskStore.disconnect();
  }
}
