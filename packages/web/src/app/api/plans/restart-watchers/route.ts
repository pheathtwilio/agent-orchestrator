import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * POST /api/plans/restart-watchers — no-op with WorkflowEngine.
 * The engine handles recovery automatically via its recover() method on start.
 *
 * GET returns the engine status.
 */
export async function POST(): Promise<Response> {
  try {
    const { engine } = await getServices();
    if (!engine) {
      return NextResponse.json({ error: "WorkflowEngine not initialized" }, { status: 503 });
    }
    // Engine recovery happens on start — nothing to restart
    return NextResponse.json({ message: "WorkflowEngine handles recovery automatically" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  try {
    const { engine } = await getServices();
    return NextResponse.json({
      engineActive: !!engine,
    });
  } catch {
    return NextResponse.json({ engineActive: false });
  }
}
