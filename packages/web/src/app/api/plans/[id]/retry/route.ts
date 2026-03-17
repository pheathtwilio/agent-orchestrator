import { NextResponse } from "next/server";
import { createTaskStore } from "@composio/ao-message-bus";
import { stopPlanWatcher, retryPlan } from "@/lib/plan-executor";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/:id/retry — cancel the current plan and re-execute it.
 *
 * Resets all tasks to pending, stops any existing watcher,
 * then spawns a new execution using the same plan graph.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — use defaults
  }

  const skipTesting = body.skipTesting === true;
  const maxConcurrency = typeof body.maxConcurrency === "number" ? body.maxConcurrency : 5;

  const taskStore = createTaskStore(REDIS_URL);

  try {
    // Stop existing watcher
    stopPlanWatcher(planId);

    const graph = await taskStore.getGraph(planId);
    if (!graph) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    // Reset all tasks to pending
    for (const node of graph.nodes) {
      await taskStore.updateTask(planId, node.id, {
        status: "pending",
        assignedTo: null,
      });
    }

    const project = typeof body.project === "string" ? body.project : undefined;

    // Re-execute with a new watcher
    await retryPlan(planId, { skipTesting, maxConcurrency, project });

    return NextResponse.json({ planId, retried: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await taskStore.disconnect();
  }
}
