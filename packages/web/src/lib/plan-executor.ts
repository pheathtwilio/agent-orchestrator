/**
 * Server-side plan executor — runs plan watch loops in the background.
 *
 * When a plan is created with auto-execute, this spawns agents and
 * handles the message loop (task completion → spawn next tasks).
 * Lives in the Next.js server process alongside the existing services.
 */

import {
  createMessageBus,
  createFileLockRegistry,
  createTaskStore,
} from "@composio/ao-message-bus";
import { createPlanner, type PlannerEvent } from "@composio/ao-planner";
import { getServices } from "./services";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Track running plan watchers — keyed by planId
const activeWatchers = new Map<string, { stop: () => void }>();

// Cache in globalThis for Next.js HMR stability
const globalForExecutor = globalThis as typeof globalThis & {
  _aoActiveWatchers?: Map<string, { stop: () => void }>;
};
if (globalForExecutor._aoActiveWatchers) {
  // Restore from previous HMR cycle
  for (const [k, v] of globalForExecutor._aoActiveWatchers) {
    activeWatchers.set(k, v);
  }
}
globalForExecutor._aoActiveWatchers = activeWatchers;

export interface ExecutePlanOptions {
  project: string;
  description: string;
  skipTesting: boolean;
  maxConcurrency: number;
}

export interface ExecutePlanResult {
  planId: string;
  title: string;
  taskCount: number;
}

/**
 * Create a plan and immediately start executing it in the background.
 * Returns as soon as agents are spawned — the watch loop continues
 * running in the background, handling task completions.
 */
export async function createAndExecutePlan(
  opts: ExecutePlanOptions,
): Promise<ExecutePlanResult> {
  const { sessionManager } = await getServices();

  const messageBus = createMessageBus(REDIS_URL);
  const fileLocks = createFileLockRegistry(REDIS_URL);
  const taskStore = createTaskStore(REDIS_URL);

  const planner = createPlanner(
    {
      messageBus,
      fileLocks,
      taskStore,
      spawnSession: async (params) => {
        const session = await sessionManager.spawn({
          projectId: params.projectId,
          prompt: params.prompt,
          branch: params.branch,
          runtimeConfig: { image: params.dockerImage },
          environment: {
            ...params.environment,
            AO_SKILL: params.skill,
            AO_MODEL: params.model,
          },
        });
        return session.id;
      },
      killSession: async (sessionId) => {
        await sessionManager.kill(sessionId);
      },
    },
    {
      requireApproval: false,
      skipIntegrationTest: opts.skipTesting,
      maxConcurrency: opts.maxConcurrency,
    },
  );

  // Log events server-side
  planner.onEvent((event: PlannerEvent) => {
    console.log(`[plan-executor] ${event.type} plan=${event.planId} ${event.detail}`);
  });

  // Create the plan (this also spawns ready tasks since requireApproval=false)
  const plan = await planner.planFeature(opts.project, opts.description);

  // Start background watch loop for this plan
  startWatchLoop(plan.id, planner, messageBus, taskStore);

  return {
    planId: plan.id,
    title: plan.taskGraph.title,
    taskCount: plan.taskGraph.nodes.length,
  };
}

/**
 * Start a background watch loop that handles agent messages
 * and drives the plan to completion.
 */
function startWatchLoop(
  planId: string,
  planner: ReturnType<typeof createPlanner>,
  messageBus: ReturnType<typeof createMessageBus>,
  taskStore: ReturnType<typeof createTaskStore>,
) {
  // Don't double-watch
  if (activeWatchers.has(planId)) return;

  let stopped = false;

  // Subscribe to orchestrator inbox for messages from agents
  messageBus.subscribe("orchestrator", async (message) => {
    if (stopped) return;

    const payload = message.payload as Record<string, unknown>;
    if (payload.planId !== planId) return;

    try {
      await planner.handleMessage(message);
    } catch (err) {
      console.error(`[plan-executor] Error handling message for ${planId}:`, err);
    }
  });

  // Periodic monitor check (stuck agents, deadlocks, orphaned sessions)
  const monitorInterval = setInterval(async () => {
    if (stopped) return;
    try {
      await planner.monitor();

      // Check if plan is done
      const graph = await taskStore.getGraph(planId);
      if (graph) {
        const allDone = graph.nodes.every((n) =>
          ["complete", "failed"].includes(n.status),
        );
        if (allDone) {
          console.log(`[plan-executor] Plan ${planId} finished — stopping watcher`);
          stop();
          return;
        }

        // Detect orphaned sessions: tasks marked in_progress/assigned but
        // the session container no longer exists
        const { sessionManager: sm } = await getServices();
        const activeSessions = await sm.list();
        const aliveIds = new Set(activeSessions.map((s) => s.id));

        for (const node of graph.nodes) {
          if (
            node.assignedTo &&
            ["in_progress", "assigned", "testing"].includes(node.status) &&
            !aliveIds.has(node.assignedTo)
          ) {
            console.log(
              `[plan-executor] Orphaned task ${node.id} — session ${node.assignedTo} no longer exists. Marking failed.`,
            );
            await taskStore.updateTask(planId, node.id, {
              status: "failed",
              assignedTo: null,
            });
          }
        }
      }
    } catch {
      // Non-critical
    }
  }, 30_000);

  function stop() {
    stopped = true;
    clearInterval(monitorInterval);
    messageBus.unsubscribe("orchestrator").catch(() => {});
    // Don't disconnect messageBus/taskStore — they may be shared
    activeWatchers.delete(planId);
  }

  activeWatchers.set(planId, { stop });
}

/** Check if a plan has an active watcher */
export function isPlanWatching(planId: string): boolean {
  return activeWatchers.has(planId);
}

/** Stop watching a plan */
export function stopPlanWatcher(planId: string): void {
  const watcher = activeWatchers.get(planId);
  if (watcher) watcher.stop();
}

/** Get list of currently watched plan IDs */
export function getActiveWatcherIds(): string[] {
  return Array.from(activeWatchers.keys());
}

/**
 * Restart watchers for all in-progress plans.
 * Stops existing watchers and creates fresh planner instances with latest code.
 * Use after deploying code changes to pick up new planner logic.
 */
export async function restartAllWatchers(
  opts: { skipTesting: boolean; maxConcurrency: number },
): Promise<{ restarted: string[]; skipped: string[] }> {
  const taskStore = createTaskStore(REDIS_URL);
  const restarted: string[] = [];
  const skipped: string[] = [];

  try {
    // Stop all existing watchers
    const currentIds = Array.from(activeWatchers.keys());
    for (const id of currentIds) {
      const watcher = activeWatchers.get(id);
      if (watcher) watcher.stop();
    }

    // Find all plans that are still in progress
    const graphs = await taskStore.listGraphs();
    const archivedSet = await taskStore.listArchivedIds();

    for (const graph of graphs) {
      if (archivedSet.has(graph.id)) continue;

      const hasActive = graph.nodes.some((n) =>
        ["in_progress", "assigned", "testing", "pending"].includes(n.status),
      );
      const allTerminal = graph.nodes.every((n) =>
        ["complete", "failed"].includes(n.status),
      );

      if (allTerminal || !hasActive) {
        skipped.push(graph.id);
        continue;
      }

      // Create fresh planner + watch loop for this plan
      const { sessionManager, config } = await getServices();
      const projectId = Object.keys(config.projects)[0];
      if (!projectId) continue;

      const messageBus = createMessageBus(REDIS_URL);
      const fileLocks = createFileLockRegistry(REDIS_URL);
      const freshTaskStore = createTaskStore(REDIS_URL);

      const planner = createPlanner(
        {
          messageBus,
          fileLocks,
          taskStore: freshTaskStore,
          spawnSession: async (params) => {
            const session = await sessionManager.spawn({
              projectId: params.projectId,
              prompt: params.prompt,
              branch: params.branch,
              runtimeConfig: { image: params.dockerImage },
              environment: {
                ...params.environment,
                AO_SKILL: params.skill,
                AO_MODEL: params.model,
              },
            });
            return session.id;
          },
          killSession: async (sessionId) => {
            await sessionManager.kill(sessionId);
          },
        },
        {
          requireApproval: false,
          skipIntegrationTest: opts.skipTesting,
          maxConcurrency: opts.maxConcurrency,
        },
      );

      planner.onEvent((event: PlannerEvent) => {
        console.log(`[plan-executor] ${event.type} plan=${event.planId} ${event.detail}`);
      });

      // Load existing plan state (reconstructs phase, assignments, etc.)
      await planner.loadPlan(graph.id, projectId);

      // Start fresh watch loop with new planner instance
      startWatchLoop(graph.id, planner, messageBus, freshTaskStore);
      restarted.push(graph.id);
    }
  } finally {
    await taskStore.disconnect();
  }

  console.log(
    `[plan-executor] Restarted ${restarted.length} watchers, skipped ${skipped.length} terminal plans`,
  );

  return { restarted, skipped };
}

/**
 * Retry a plan that was cancelled or failed.
 * Expects all tasks to already be reset to "pending".
 * Creates a new planner instance, loads the plan, and spawns agents.
 */
export async function retryPlan(
  planId: string,
  opts: { skipTesting: boolean; maxConcurrency: number; project?: string },
): Promise<void> {
  const { sessionManager, config } = await getServices();

  // Resolve the project ID — use provided, or fall back to first configured project
  const projectId = opts.project ?? Object.keys(config.projects)[0];
  if (!projectId) throw new Error("No projects configured");

  const messageBus = createMessageBus(REDIS_URL);
  const fileLocks = createFileLockRegistry(REDIS_URL);
  const taskStore = createTaskStore(REDIS_URL);

  const planner = createPlanner(
    {
      messageBus,
      fileLocks,
      taskStore,
      spawnSession: async (params) => {
        const session = await sessionManager.spawn({
          projectId: params.projectId,
          prompt: params.prompt,
          branch: params.branch,
          runtimeConfig: { image: params.dockerImage },
          environment: {
            ...params.environment,
            AO_SKILL: params.skill,
            AO_MODEL: params.model,
          },
        });
        return session.id;
      },
      killSession: async (sessionId) => {
        await sessionManager.kill(sessionId);
      },
    },
    {
      requireApproval: false,
      skipIntegrationTest: opts.skipTesting,
      maxConcurrency: opts.maxConcurrency,
    },
  );

  planner.onEvent((event: PlannerEvent) => {
    console.log(`[plan-executor] ${event.type} plan=${event.planId} ${event.detail}`);
  });

  // Load the existing plan from Redis and approve it (spawns ready tasks)
  await planner.loadPlan(planId, projectId);
  await planner.approvePlan(planId);

  // Start background watch loop
  startWatchLoop(planId, planner, messageBus, taskStore);
}
