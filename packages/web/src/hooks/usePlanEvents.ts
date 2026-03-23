"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ── Types matching the SSE event payloads ──

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  status: string;
  skill: string;
  model: string;
  assignedTo: string | null;
  branch: string | null;
  dependsOn: string[];
  fileBoundary: string[];
  updatedAt: number;
  result: { summary: string; branch: string; error?: string } | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface SessionUsage {
  taskId: string;
  skill: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  updatedAt: number;
}

export interface WorkflowStep {
  name: string;
}

export interface PlanSnapshot {
  plan: {
    id: string;
    featureId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    workflowSnapshot?: WorkflowStep[];
    currentStepIndex?: number;
    enginePhase?: string | null;
  };
  tasks: PlanTask[];
  usage: UsageTotals;
  sessionUsage: Record<string, SessionUsage>;
}

export interface BusMessage {
  id: string;
  type: string;
  from: string;
  to: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface AgentOutputLine {
  sessionId: string;
  timestamp: number;
  line: string;
}

export interface PlanEventsState {
  snapshot: PlanSnapshot | null;
  messages: BusMessage[];
  outputLines: AgentOutputLine[];
  connected: boolean;
  error: string | null;
}

const MAX_MESSAGES = 200;
const MAX_OUTPUT_LINES = 500;

/**
 * Hook that connects to the SSE event stream for a plan.
 * Returns real-time plan state, bus messages, and agent output.
 */
export function usePlanEvents(planId: string | null, follow = false): PlanEventsState {
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [outputLines, setOutputLines] = useState<AgentOutputLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
  }, []);

  useEffect(() => {
    if (!planId) {
      cleanup();
      return;
    }

    const url = `/api/plans/${planId}/events${follow ? "?follow=true" : ""}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("plan_snapshot", (e) => {
      try {
        const data = JSON.parse(e.data) as PlanSnapshot;
        setSnapshot(data);
        setError(null);
      } catch {
        // Ignore parse errors
      }
    });

    es.addEventListener("bus_message", (e) => {
      try {
        const msg = JSON.parse(e.data) as BusMessage;
        setMessages((prev) => {
          const next = [...prev, msg];
          return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
        });
      } catch {
        // Ignore
      }
    });

    es.addEventListener("agent_output", (e) => {
      try {
        const line = JSON.parse(e.data) as AgentOutputLine;
        setOutputLines((prev) => {
          const next = [...prev, line];
          return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next;
        });
      } catch {
        // Ignore
      }
    });

    es.addEventListener("error_event", (e) => {
      try {
        const data = JSON.parse(e.data);
        setError(data.error ?? "Unknown error");
      } catch {
        setError("Connection error");
      }
    });

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };

    return cleanup;
  }, [planId, follow, cleanup]);

  return { snapshot, messages, outputLines, connected, error };
}
