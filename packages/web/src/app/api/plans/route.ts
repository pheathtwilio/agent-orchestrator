import { NextResponse } from "next/server";
import { createTaskStore, createEngineStore } from "@composio/ao-message-bus";
import { getPlanState } from "@/lib/engine-bridge";
import { extractTitle } from "@/lib/extract-title";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * GET /api/plans — list all plans.
 *
 * Merges legacy plans (ao:taskgraph:*) and engine plans (ao:plan:*).
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
  const engineStore = createEngineStore(REDIS_URL);

  try {
    const archivedSet = await taskStore.listArchivedIds();
    const graphs = await taskStore.listGraphs();
    const legacyIds = new Set(graphs.map((g) => g.id));

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

    // Add engine-managed plans not already in legacy store
    if (!archivedOnly) {
      const enginePlanIds = await engineStore.getActivePlanIds();
      for (const planId of enginePlanIds) {
        if (legacyIds.has(planId)) continue;

        const planData = await engineStore.getPlan(planId);
        if (!planData) continue;

        const tasks = await engineStore.getAllTasks(planId);
        const taskList = Object.values(tasks).map((json) => JSON.parse(json));
        const total = taskList.length;
        const complete = taskList.filter((t) => t.status === "complete").length;
        const inProgress = taskList.filter((t) => ["running", "spawning"].includes(t.status)).length;
        const pending = taskList.filter((t) => t.status === "pending").length;
        const failed = taskList.filter((t) => t.status === "failed").length;
        const engineState = getPlanState(planId);

        plans.push({
          id: planId,
          featureId: planId,
          title: extractTitle(planData.featureDescription),
          taskCount: total,
          complete,
          inProgress,
          pending,
          failed,
          progressPercent: total > 0 ? Math.round((complete / total) * 100) : 0,
          createdAt: planData.createdAt,
          updatedAt: planData.updatedAt,
          archived: false,
          enginePhase: engineState?.phase ?? planData.phase,
        } as typeof plans[number]);
      }
    }

    return NextResponse.json({ plans });
  } finally {
    await taskStore.disconnect();
    await engineStore.disconnect();
  }
}
