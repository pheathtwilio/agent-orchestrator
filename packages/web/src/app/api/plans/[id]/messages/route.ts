import { NextResponse } from "next/server";
import { createMessageBus } from "@composio/ao-message-bus";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * GET /api/plans/:id/messages — paginated message history for a plan.
 *
 * Reads the orchestrator's Redis Stream inbox and filters to messages
 * belonging to this plan (matching planId in payload).
 *
 * Query params:
 *   - count=50  — max messages to return (default: 50, max: 200)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;
  const { searchParams } = new URL(request.url);
  const count = Math.min(parseInt(searchParams.get("count") ?? "50", 10) || 50, 200);

  const messageBus = createMessageBus(REDIS_URL);

  try {
    // Fetch recent history from the orchestrator's inbox
    const history = await messageBus.getHistory("orchestrator", count * 3);

    // Filter to messages belonging to this plan
    const planMessages = history.filter((msg) => {
      const payload = msg.payload as Record<string, unknown>;
      return payload.planId === planId;
    });

    // Return the most recent `count` messages
    const messages = planMessages.slice(-count).map((msg) => ({
      id: msg.id,
      type: msg.type,
      from: msg.from,
      to: msg.to,
      timestamp: msg.timestamp,
      payload: msg.payload,
    }));

    return NextResponse.json({ messages, total: messages.length });
  } finally {
    await messageBus.disconnect();
  }
}
