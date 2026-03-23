import {
  createMessageBus,
  createTaskStore,
  type BusMessage,
  type TaskGraph,
} from "@composio/ao-message-bus";
import { getPlanState } from "@/lib/engine-bridge";

export const dynamic = "force-dynamic";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * GET /api/plans/:id/events — SSE stream for real-time plan updates.
 *
 * Emits three kinds of events:
 *   - "plan_snapshot"  — full plan state, sent on connect and every poll
 *   - "bus_message"    — orchestrator inbox messages for this plan
 *   - "agent_output"   — real-time stdout/stderr lines from agent sessions
 *
 * Query params:
 *   - follow=true  — also subscribe to real-time agent output (default: false)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: planId } = await params;
  const { searchParams } = new URL(request.url);
  const follow = searchParams.get("follow") === "true";

  const encoder = new TextEncoder();
  const taskStore = createTaskStore(REDIS_URL);
  const messageBus = createMessageBus(REDIS_URL);

  // Track subscribed output sessions for cleanup
  const outputSessions = new Set<string>();

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  function send(controller: ReadableStreamDefaultController, event: string, data: unknown) {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      // Stream closed
      closed = true;
    }
  }

  /** Build a snapshot payload from the current graph state + usage */
  async function buildSnapshot(graph: TaskGraph) {
    const usage = await taskStore.getUsage(planId);
    // Include engine phase when workflow engine is active
    const enginePhase = getPlanState(planId)?.phase ?? null;
    return {
      plan: {
        id: graph.id,
        featureId: graph.featureId,
        title: graph.title,
        createdAt: graph.createdAt,
        updatedAt: graph.updatedAt,
        workflowSnapshot: graph.workflowSnapshot,
        currentStepIndex: graph.currentStepIndex,
        enginePhase,
      },
      tasks: graph.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        description: n.description,
        status: n.status,
        skill: n.skill,
        model: n.model,
        assignedTo: n.assignedTo,
        branch: n.branch,
        dependsOn: n.dependsOn,
        fileBoundary: n.fileBoundary,
        updatedAt: n.updatedAt,
        result: n.result
          ? { summary: n.result.summary, branch: n.result.branch, error: n.result.error }
          : null,
      })),
      usage: usage.totals,
      sessionUsage: usage.sessions,
    };
  }

  /** Subscribe to agent output for all active sessions in the plan */
  async function subscribeToActiveOutputs(
    controller: ReadableStreamDefaultController,
    graph: TaskGraph,
  ) {
    if (!follow) return;

    const activeSessions = graph.nodes
      .filter((n) => n.assignedTo && ["assigned", "in_progress", "testing"].includes(n.status))
      .map((n) => n.assignedTo!)
      .filter((sid) => !outputSessions.has(sid));

    for (const sessionId of activeSessions) {
      outputSessions.add(sessionId);
      // The sidecar publishes to ao:output:<AO_SESSION_NAME> where AO_SESSION_NAME
      // is the session manager's session ID (e.g. "ao-99"), which matches assignedTo.
      const sidecarId = sessionId;
      await messageBus.subscribeOutput(sidecarId, (data) => {
        send(controller, "agent_output", {
          sessionId,
          timestamp: data.timestamp,
          line: data.line,
        });
      });
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        // Initial snapshot
        const graph = await taskStore.getGraph(planId);
        if (!graph) {
          send(controller, "error", { error: "Plan not found" });
          controller.close();
          return;
        }

        const snapshot = await buildSnapshot(graph);
        send(controller, "plan_snapshot", snapshot);

        // Subscribe to orchestrator inbox for messages related to this plan
        const orchestratorListener = `plan-events-${planId}`;
        await messageBus.subscribe(orchestratorListener, () => {
          // We don't actually receive messages via this subscription since it's
          // a unique recipient. Instead we poll getHistory on the orchestrator inbox.
        });

        // Subscribe to agent output streams if follow=true
        await subscribeToActiveOutputs(controller, graph);

        // Send recent orchestrator messages as initial history
        const history = await messageBus.getHistory("orchestrator", 100);
        const planMessages = history.filter((msg) => {
          const payload = msg.payload as Record<string, unknown>;
          return payload.planId === planId;
        });
        for (const msg of planMessages.slice(-20)) {
          send(controller, "bus_message", formatBusMessage(msg));
        }

        // Track last seen message timestamp for incremental polling
        let lastSeenTimestamp = planMessages.length > 0
          ? planMessages[planMessages.length - 1].timestamp
          : Date.now();

        // Poll for plan state changes and new messages
        poller = setInterval(() => {
          void (async () => {
            if (closed) return;
            try {
              const currentGraph = await taskStore.getGraph(planId);
              if (!currentGraph) return;

              // Send updated snapshot
              const snap = await buildSnapshot(currentGraph);
              send(controller, "plan_snapshot", snap);

              // Subscribe to any new agent output sessions
              await subscribeToActiveOutputs(controller, currentGraph);

              // Check for new orchestrator messages
              const recent = await messageBus.getHistory("orchestrator", 50);
              const newMessages = recent.filter((msg) => {
                const payload = msg.payload as Record<string, unknown>;
                return payload.planId === planId && msg.timestamp > lastSeenTimestamp;
              });

              for (const msg of newMessages) {
                send(controller, "bus_message", formatBusMessage(msg));
                lastSeenTimestamp = msg.timestamp;
              }
            } catch {
              // Transient error — retry on next poll
            }
          })();
        }, 3000);

        // Heartbeat to keep connection alive
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            closed = true;
            cleanup();
          }
        }, 15000);
      })();
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  function cleanup() {
    clearInterval(heartbeat);
    clearInterval(poller);
    void (async () => {
      for (const sid of outputSessions) {
        await messageBus.unsubscribeOutput(sid).catch(() => {});
      }
      outputSessions.clear();
      await messageBus.disconnect().catch(() => {});
      await taskStore.disconnect().catch(() => {});
    })();
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function formatBusMessage(msg: BusMessage) {
  return {
    id: msg.id,
    type: msg.type,
    from: msg.from,
    to: msg.to,
    timestamp: msg.timestamp,
    payload: msg.payload,
  };
}
