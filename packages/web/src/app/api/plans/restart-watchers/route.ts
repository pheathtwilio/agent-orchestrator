import { NextResponse } from "next/server";
import { restartAllWatchers, getActiveWatcherIds } from "@/lib/plan-executor";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/restart-watchers — restart all plan watchers with fresh code.
 * Use after deploying code changes to the planner/executor.
 *
 * GET returns the list of currently active watcher plan IDs.
 */
export async function POST(): Promise<Response> {
  try {
    const result = await restartAllWatchers({
      skipTesting: false,
      maxConcurrency: 3,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to restart watchers" },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json({ activeWatchers: getActiveWatcherIds() });
}
