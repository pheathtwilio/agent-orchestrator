import { NextResponse } from "next/server";
import {
  createMessageBus,
  createFileLockRegistry,
  createTaskStore,
} from "@composio/ao-message-bus";
import { createPlanner } from "@composio/ao-planner";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * POST /api/plans/create — create a new execution plan.
 *
 * Decomposes the feature description into tasks, classifies skills,
 * and stores the task graph in Redis. Does NOT start execution —
 * the user must run `ao plan watch` or `ao plan approve` to begin.
 *
 * Body:
 *   - project: string (project ID from config)
 *   - description: string (feature to implement)
 *   - autoApprove?: boolean (default: false)
 *   - skipTesting?: boolean (default: false)
 *   - maxConcurrency?: number (default: 5)
 */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const project = body.project as string;
  const description = body.description as string;

  if (!project || !description) {
    return NextResponse.json(
      { error: "Missing required fields: project, description" },
      { status: 400 },
    );
  }

  const autoApprove = body.autoApprove === true;
  const skipTesting = body.skipTesting === true;
  const maxConcurrency = typeof body.maxConcurrency === "number" ? body.maxConcurrency : 5;

  const messageBus = createMessageBus(REDIS_URL);
  const fileLocks = createFileLockRegistry(REDIS_URL);
  const taskStore = createTaskStore(REDIS_URL);

  try {
    // Create planner with requireApproval=true so it only plans, never spawns
    // The stub spawnSession/killSession will never be called during planning
    const planner = createPlanner(
      {
        messageBus,
        fileLocks,
        taskStore,
        spawnSession: async () => {
          throw new Error("Web UI planning only — use ao plan watch to execute");
        },
        killSession: async () => {},
      },
      {
        requireApproval: !autoApprove,
        skipIntegrationTest: skipTesting,
        maxConcurrency,
      },
    );

    const plan = await planner.planFeature(project, description);

    return NextResponse.json({
      planId: plan.id,
      title: plan.taskGraph.title,
      phase: plan.phase,
      taskCount: plan.taskGraph.nodes.length,
      message: autoApprove
        ? `Plan created. Run: ao plan watch ${project} ${plan.id} --follow`
        : `Plan created and awaiting approval. Run: ao plan approve ${project} ${plan.id}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await messageBus.disconnect();
    await fileLocks.disconnect();
    await taskStore.disconnect();
  }
}
