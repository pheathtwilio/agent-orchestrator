import RedisModule from "ioredis";
const Redis = RedisModule.default ?? RedisModule;
import type { EngineStore, EnginePlanData, AtomicOp } from "./types.js";

const DEFAULT_REDIS_URL = "redis://localhost:6379";

export function createEngineStore(redisUrl?: string): EngineStore {
  const url = redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (!connected) {
      await redis.connect();
      connected = true;
    }
  }

  return {
    async createPlan(planId, data) {
      await ensureConnected();
      await redis.hset(`ao:plan:${planId}`, {
        phase: data.phase,
        currentStepIndex: String(data.currentStepIndex),
        workflowId: data.workflowId,
        workflowVersionId: data.workflowVersionId,
        workflowSnapshot: data.workflowSnapshot,
        projectId: data.projectId,
        featureDescription: data.featureDescription,
        createdAt: String(data.createdAt),
        updatedAt: String(data.updatedAt),
      });
      const added = await redis.sadd("ao:engine:plans", planId);
      console.log(`[engine-store] createPlan ${planId}: sadd returned ${added}`);
    },

    async getPlan(planId) {
      await ensureConnected();
      const data = await redis.hgetall(`ao:plan:${planId}`);
      if (!data || !data.phase) return null;
      return {
        phase: data.phase,
        currentStepIndex: parseInt(data.currentStepIndex, 10),
        workflowId: data.workflowId,
        workflowVersionId: data.workflowVersionId,
        workflowSnapshot: data.workflowSnapshot,
        projectId: data.projectId,
        featureDescription: data.featureDescription,
        createdAt: parseInt(data.createdAt, 10),
        updatedAt: parseInt(data.updatedAt, 10),
      };
    },

    async atomicUpdate(planId, ops) {
      await ensureConnected();
      const pipeline = redis.multi();
      for (const op of ops) {
        switch (op.type) {
          case "SET_TASK":
            pipeline.hset(`ao:plan:${planId}:tasks`, op.taskId, op.data);
            break;
          case "SET_PLAN_FIELD":
            pipeline.hset(`ao:plan:${planId}`, op.field, op.value);
            break;
          case "ADD_CLEANUP":
            pipeline.sadd(`ao:plan:${op.planId}:cleanup`, op.resource);
            break;
          case "REMOVE_CLEANUP":
            pipeline.srem(`ao:plan:${op.planId}:cleanup`, op.resource);
            break;
        }
      }
      pipeline.hset(`ao:plan:${planId}`, "updatedAt", String(Date.now()));
      await pipeline.exec();
    },

    async getTask(planId, taskId) {
      await ensureConnected();
      return redis.hget(`ao:plan:${planId}:tasks`, taskId);
    },

    async getAllTasks(planId) {
      await ensureConnected();
      return redis.hgetall(`ao:plan:${planId}:tasks`);
    },

    async getActivePlanIds() {
      await ensureConnected();
      return redis.smembers("ao:engine:plans");
    },

    async deactivatePlan(planId) {
      await ensureConnected();
      await redis.srem("ao:engine:plans", planId);
    },

    async registerContainer(containerName, planId, taskId) {
      await ensureConnected();
      await redis.hset("ao:engine:containers", containerName, JSON.stringify({ planId, taskId }));
    },

    async lookupContainer(containerName) {
      await ensureConnected();
      const data = await redis.hget("ao:engine:containers", containerName);
      if (!data) return null;
      return JSON.parse(data);
    },

    async removeContainer(containerName) {
      await ensureConnected();
      await redis.hdel("ao:engine:containers", containerName);
    },

    async updateHeartbeat(planId, taskId, timestamp) {
      await ensureConnected();
      await redis.hset("ao:engine:heartbeats", `${planId}:${taskId}`, String(timestamp));
    },

    async getHeartbeats() {
      await ensureConnected();
      const data = await redis.hgetall("ao:engine:heartbeats");
      const result: Record<string, number> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = parseInt(value, 10);
      }
      return result;
    },

    async disconnect() {
      connected = false;
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
