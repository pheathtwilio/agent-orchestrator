import { NextResponse } from "next/server";
import { createFileLockRegistry } from "@composio/ao-message-bus";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** GET /api/plans/locks — list all file locks and detect deadlocks */
export async function GET(): Promise<Response> {
  const fileLocks = createFileLockRegistry(REDIS_URL);

  try {
    const locks = await fileLocks.listAll();
    const deadlocks = await fileLocks.detectDeadlocks();

    return NextResponse.json({
      locks: locks.map((l) => ({
        ...l,
        ageMs: Date.now() - l.acquiredAt,
      })),
      deadlocks,
    });
  } finally {
    await fileLocks.disconnect();
  }
}
