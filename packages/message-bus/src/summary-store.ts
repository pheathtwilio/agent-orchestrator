import RedisModule from "ioredis";
const Redis = RedisModule.default ?? RedisModule;
import type { SummaryStore } from "./types.js";

const DEFAULT_REDIS_URL = "redis://localhost:6379";
const SUMMARY_PREFIX = "ao:summary:";

/**
 * Redis-backed store for plan completion summaries.
 * Stored at `ao:summary:<planId>` as JSON.
 */
export function createSummaryStore(redisUrl?: string): SummaryStore {
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
    async store(summary: { planId: string }): Promise<void> {
      await ensureConnected();
      await redis.set(
        `${SUMMARY_PREFIX}${summary.planId}`,
        JSON.stringify(summary),
      );
    },

    async get(planId: string): Promise<Record<string, unknown> | null> {
      await ensureConnected();
      const data = await redis.get(`${SUMMARY_PREFIX}${planId}`);
      if (!data) return null;
      return JSON.parse(data) as Record<string, unknown>;
    },

    async disconnect(): Promise<void> {
      connected = false;
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
