import RedisModule from "ioredis";
const Redis = RedisModule.default ?? RedisModule;

const DEFAULT_REDIS_URL = "redis://localhost:6379";

export async function migrate(redisUrl?: string): Promise<{ migrated: number; skipped: number }> {
  const url = redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const redis = new Redis(url, { lazyConnect: true });
  await redis.connect();

  let migrated = 0;
  let skipped = 0;

  try {
    const graphIds = await redis.smembers("ao:taskgraphs");

    for (const graphId of graphIds) {
      const data = await redis.get(`ao:taskgraph:${graphId}`);
      if (!data) { skipped++; continue; }

      const graph = JSON.parse(data);

      // Check if already migrated
      const exists = await redis.exists(`ao:plan:${graphId}`);
      if (exists) { skipped++; continue; }

      // Write plan metadata
      const pipeline = redis.multi();
      pipeline.hset(`ao:plan:${graphId}`, {
        phase: "complete",
        currentStepIndex: String(graph.currentStepIndex ?? 0),
        workflowId: graph.workflowId ?? "legacy",
        workflowVersionId: graph.workflowVersionId ?? "v0",
        workflowSnapshot: JSON.stringify(graph.workflowSnapshot ?? []),
        projectId: graph.featureId ?? "",
        featureDescription: graph.title ?? "",
        createdAt: String(graph.createdAt ?? Date.now()),
        updatedAt: String(graph.updatedAt ?? Date.now()),
      });

      // Write individual tasks
      for (const node of (graph.nodes ?? [])) {
        pipeline.hset(`ao:plan:${graphId}:tasks`, node.id, JSON.stringify(node));
      }

      await pipeline.exec();
      migrated++;
    }
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }

  return { migrated, skipped };
}
