import RedisModule from "ioredis";
const Redis = RedisModule.default ?? RedisModule;
import type { FileLockRegistry, FileLock } from "./types.js";

const DEFAULT_REDIS_URL = "redis://localhost:6379";
const LOCK_PREFIX = "ao:lock:";
const LOCK_INDEX = "ao:locks";
const WAIT_PREFIX = "ao:lock-wait:";

/**
 * Redis-backed file lock registry.
 *
 * Prevents two agents from editing the same file simultaneously.
 * The orchestrator assigns file boundaries when decomposing tasks,
 * but agents can also request locks for files outside their boundary.
 *
 * Uses Redis SETNX for atomic lock acquisition.
 */
export function createFileLockRegistry(redisUrl?: string): FileLockRegistry {
  const url = redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (!connected) {
      await redis.connect();
      connected = true;
    }
  }

  function lockKey(filePath: string): string {
    return `${LOCK_PREFIX}${filePath}`;
  }

  return {
    async acquire(filePath: string, owner: string): Promise<boolean> {
      await ensureConnected();

      const key = lockKey(filePath);

      // Atomic: set only if not exists
      const result = await redis.set(key, JSON.stringify({
        owner,
        acquiredAt: Date.now(),
      }), "NX");

      if (result === "OK") {
        // Track in the index set for listAll
        await redis.sadd(LOCK_INDEX, filePath);
        // Clear any wait record
        await redis.del(`${WAIT_PREFIX}${owner}:${filePath}`);
        return true;
      }

      // Lock exists — check if we already own it
      const existing = await redis.get(key);
      if (existing) {
        const lock = JSON.parse(existing) as { owner: string };
        if (lock.owner === owner) return true;
      }

      // Record that this owner is waiting for this file (for deadlock detection)
      await redis.set(`${WAIT_PREFIX}${owner}:${filePath}`, "1");

      return false;
    },

    async release(filePath: string, owner: string): Promise<boolean> {
      await ensureConnected();

      const key = lockKey(filePath);
      const existing = await redis.get(key);

      if (!existing) return false;

      const lock = JSON.parse(existing) as { owner: string };
      if (lock.owner !== owner) return false;

      await redis.del(key);
      await redis.srem(LOCK_INDEX, filePath);
      return true;
    },

    async releaseAll(owner: string): Promise<number> {
      await ensureConnected();

      const files = await redis.smembers(LOCK_INDEX);
      let released = 0;

      for (const filePath of files) {
        const existing = await redis.get(lockKey(filePath));
        if (!existing) continue;

        const lock = JSON.parse(existing) as { owner: string };
        if (lock.owner === owner) {
          await redis.del(lockKey(filePath));
          await redis.srem(LOCK_INDEX, filePath);
          released++;
        }
      }

      // Clean up wait records
      const waitKeys = await redis.keys(`${WAIT_PREFIX}${owner}:*`);
      if (waitKeys.length > 0) {
        await redis.del(...waitKeys);
      }

      return released;
    },

    async getOwner(filePath: string): Promise<string | null> {
      await ensureConnected();

      const existing = await redis.get(lockKey(filePath));
      if (!existing) return null;

      const lock = JSON.parse(existing) as { owner: string };
      return lock.owner;
    },

    async listAll(): Promise<FileLock[]> {
      await ensureConnected();

      const files = await redis.smembers(LOCK_INDEX);
      const locks: FileLock[] = [];

      for (const filePath of files) {
        const existing = await redis.get(lockKey(filePath));
        if (!existing) {
          // Stale index entry — clean up
          await redis.srem(LOCK_INDEX, filePath);
          continue;
        }
        const data = JSON.parse(existing) as { owner: string; acquiredAt: number };
        locks.push({
          filePath,
          owner: data.owner,
          acquiredAt: data.acquiredAt,
        });
      }

      return locks;
    },

    async detectDeadlocks(): Promise<string[][]> {
      await ensureConnected();

      // Build a wait-for graph: owner → [owners they're waiting on]
      // A waits for B if A is waiting on a file that B owns

      const waitKeys = await redis.keys(`${WAIT_PREFIX}*`);
      const locks = await this.listAll();
      const ownerByFile = new Map(locks.map((l) => [l.filePath, l.owner]));

      // Parse wait records: "ao:lock-wait:<owner>:<filePath>" → owner waits for file
      const waitsFor = new Map<string, Set<string>>();

      for (const key of waitKeys) {
        const rest = key.slice(WAIT_PREFIX.length);
        const colonIdx = rest.indexOf(":");
        if (colonIdx === -1) continue;

        const waitingOwner = rest.slice(0, colonIdx);
        const filePath = rest.slice(colonIdx + 1);
        const fileOwner = ownerByFile.get(filePath);

        if (fileOwner && fileOwner !== waitingOwner) {
          if (!waitsFor.has(waitingOwner)) {
            waitsFor.set(waitingOwner, new Set());
          }
          waitsFor.get(waitingOwner)!.add(fileOwner);
        }
      }

      // DFS cycle detection
      const cycles: string[][] = [];
      const visited = new Set<string>();
      const inStack = new Set<string>();

      function dfs(node: string, path: string[]): void {
        if (inStack.has(node)) {
          // Found a cycle
          const cycleStart = path.indexOf(node);
          cycles.push(path.slice(cycleStart));
          return;
        }
        if (visited.has(node)) return;

        visited.add(node);
        inStack.add(node);
        path.push(node);

        for (const dep of waitsFor.get(node) ?? []) {
          dfs(dep, [...path]);
        }

        inStack.delete(node);
      }

      for (const owner of waitsFor.keys()) {
        dfs(owner, []);
      }

      return cycles;
    },

    async disconnect(): Promise<void> {
      connected = false;
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
