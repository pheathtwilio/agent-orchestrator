import { NextResponse } from "next/server";
import { createTaskStore, createEngineStore } from "@composio/ao-message-bus";
import { getPlanState } from "@/lib/engine-bridge";
import { extractTitle } from "@/lib/extract-title";

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
    // Try legacy store first
    const graph = await taskStore.getGraph(id);
    if (graph) {
      return NextResponse.json({ plan: graph });
    }

    // Try engine store
    const engineStore = createEngineStore(REDIS_URL);
    try {
      const planData = await engineStore.getPlan(id);
      if (!planData) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }

      // Build a graph-like response from engine data
      const tasks = await engineStore.getAllTasks(id);
      const engineState = getPlanState(id);
      const nodes = Object.entries(tasks).map(([taskId, json]) => {
        const task = JSON.parse(json);
        return {
          id: taskId,
          title: task.title || taskId,
          description: task.description || "",
          status: task.status || "pending",
          skill: task.skill || "",
          model: task.model || "",
          assignedTo: task.containerId || null,
          branch: task.branch || null,
          dependsOn: task.dependsOn || [],
          fileBoundary: task.fileBoundary || [],
          acceptanceCriteria: task.acceptanceCriteria || [],
          result: task.result || null,
          createdAt: planData.createdAt,
          updatedAt: planData.updatedAt,
        };
      });

      return NextResponse.json({
        plan: {
          id,
          featureId: id,
          title: extractTitle(planData.featureDescription),
          nodes,
          createdAt: planData.createdAt,
          updatedAt: planData.updatedAt,
          enginePhase: engineState?.phase ?? planData.phase,
        },
      });
    } finally {
      await engineStore.disconnect();
    }
  } finally {
    await taskStore.disconnect();
  }
}
