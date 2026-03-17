import RedisModule from "ioredis";
const Redis = RedisModule.default ?? RedisModule;
import type { TaskStore, TaskGraph, TaskNode } from "./types.js";

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
      return deleted > 0;
    },

    async disconnect(): Promise<void> {
      connected = false;
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
