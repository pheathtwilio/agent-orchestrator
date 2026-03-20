import RedisModule from "ioredis";
const Redis = RedisModule.default ?? RedisModule;
import type { TaskStore, TaskGraph, TaskNode, PlanUsage, SessionUsage } from "./types.js";

const DEFAULT_REDIS_URL = "redis://localhost:6379";
const GRAPH_PREFIX = "ao:taskgraph:";
const GRAPH_INDEX = "ao:taskgraphs";

/**
 * Redis-backed task store.
 *
 * Manages task graphs — DAGs of tasks produced by the planner.
 * The orchestrator queries for ready tasks (all deps satisfied)
 * and assigns them to agents.
 */
export function createTaskStore(redisUrl?: string): TaskStore {
  const url = redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (!connected) {
      await redis.connect();
      connected = true;
    }
  }

  function graphKey(graphId: string): string {
    return `${GRAPH_PREFIX}${graphId}`;
  }

  return {
    async createGraph(graph): Promise<TaskGraph> {
      await ensureConnected();

      const now = Date.now();
      const fullGraph: TaskGraph = {
        ...graph,
        createdAt: now,
        updatedAt: now,
      };

      await redis.set(graphKey(graph.id), JSON.stringify(fullGraph));
      await redis.sadd(GRAPH_INDEX, graph.id);

      return fullGraph;
    },

    async getGraph(graphId: string): Promise<TaskGraph | null> {
      await ensureConnected();

      const data = await redis.get(graphKey(graphId));
      if (!data) return null;

      return JSON.parse(data) as TaskGraph;
    },

    async updateTask(
      graphId: string,
      taskId: string,
      update: Partial<TaskNode>,
    ): Promise<TaskNode | null> {
      await ensureConnected();

      const data = await redis.get(graphKey(graphId));
      if (!data) return null;

      const graph = JSON.parse(data) as TaskGraph;
      const taskIndex = graph.nodes.findIndex((n) => n.id === taskId);
      if (taskIndex === -1) return null;

      const task = graph.nodes[taskIndex];
      const updatedTask: TaskNode = {
        ...task,
        ...update,
        updatedAt: Date.now(),
      };
      graph.nodes[taskIndex] = updatedTask;
      graph.updatedAt = Date.now();

      await redis.set(graphKey(graphId), JSON.stringify(graph));

      return updatedTask;
    },

    async addNode(graphId: string, node: TaskNode): Promise<TaskNode | null> {
      await ensureConnected();

      const data = await redis.get(graphKey(graphId));
      if (!data) return null;

      const graph = JSON.parse(data) as TaskGraph;

      // Replace if a node with this ID already exists, otherwise append
      const existing = graph.nodes.findIndex((n) => n.id === node.id);
      if (existing !== -1) {
        graph.nodes[existing] = node;
      } else {
        graph.nodes.push(node);
      }
      graph.updatedAt = Date.now();

      await redis.set(graphKey(graphId), JSON.stringify(graph));
      return node;
    },

    async getReadyTasks(graphId: string): Promise<TaskNode[]> {
      await ensureConnected();

      const data = await redis.get(graphKey(graphId));
      if (!data) return [];

      const graph = JSON.parse(data) as TaskGraph;

      // A task is ready if:
      // 1. Its status is "pending"
      // 2. All its dependencies are "complete"
      const completedIds = new Set(
        graph.nodes.filter((n) => n.status === "complete").map((n) => n.id),
      );

      return graph.nodes.filter(
        (node) =>
          node.status === "pending" &&
          node.dependsOn.every((depId) => completedIds.has(depId)),
      );
    },

    async listGraphs(): Promise<TaskGraph[]> {
      await ensureConnected();

      const ids = await redis.smembers(GRAPH_INDEX);
      const graphs: TaskGraph[] = [];

      for (const id of ids) {
        const data = await redis.get(graphKey(id));
        if (data) {
          graphs.push(JSON.parse(data) as TaskGraph);
        }
      }

      return graphs;
    },

    async deleteGraph(graphId: string): Promise<boolean> {
      await ensureConnected();
      const deleted = await redis.del(graphKey(graphId));
      await redis.srem(GRAPH_INDEX, graphId);
      // Also clean up usage data
      await redis.del(`ao:usage:${graphId}`);
      return deleted > 0;
    },

    async archiveGraph(graphId: string): Promise<void> {
      await ensureConnected();
      await redis.sadd("ao:archived", graphId);
    },

    async unarchiveGraph(graphId: string): Promise<void> {
      await ensureConnected();
      await redis.srem("ao:archived", graphId);
    },

    async listArchivedIds(): Promise<Set<string>> {
      await ensureConnected();
      const ids = await redis.smembers("ao:archived");
      return new Set(ids);
    },

    async updateGraphMetadata(graphId, update): Promise<void> {
      await ensureConnected();
      const data = await redis.get(graphKey(graphId));
      if (!data) return;

      const graph = JSON.parse(data) as TaskGraph;
      if (update.currentStepIndex !== undefined) graph.currentStepIndex = update.currentStepIndex;
      if (update.workflowId !== undefined) graph.workflowId = update.workflowId;
      if (update.workflowVersionId !== undefined) graph.workflowVersionId = update.workflowVersionId;
      if (update.workflowSnapshot !== undefined) graph.workflowSnapshot = update.workflowSnapshot;
      graph.updatedAt = Date.now();

      await redis.set(graphKey(graphId), JSON.stringify(graph));
    },

    async getUsage(planId: string): Promise<PlanUsage> {
      await ensureConnected();
      const data = await redis.hgetall(`ao:usage:${planId}`);

      const sessions: Record<string, SessionUsage> = {};
      const totals = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };

      for (const [sessionId, json] of Object.entries(data)) {
        try {
          const usage = JSON.parse(json) as SessionUsage;
          sessions[sessionId] = usage;
          totals.inputTokens += usage.inputTokens;
          totals.outputTokens += usage.outputTokens;
          totals.cacheReadTokens += usage.cacheReadTokens;
          totals.cacheCreationTokens += usage.cacheCreationTokens;
          totals.costUsd += usage.costUsd;
        } catch {
          // Skip malformed entries
        }
      }

      return { sessions, totals };
    },

    async disconnect(): Promise<void> {
      connected = false;
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
