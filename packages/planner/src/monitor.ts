import type { MessageBus, FileLockRegistry } from "@composio/ao-message-bus";
import type { PlannerEvent, PlannerEventHandler, ExecutionPlan } from "./types.js";

// ============================================================================
// MONITOR — watches agent health, detects stuck/bloated agents
// ============================================================================

export interface MonitorConfig {
  /** How often to check agent health (ms) */
  pollIntervalMs: number;
  /** Time without output before an agent is considered stuck (ms) */
  stuckThresholdMs: number;
  /** Max docker logs lines before considering context bloated */
  contextBloatLines: number;
  /** Max consecutive identical output checks before stuck */
  staleOutputChecks: number;
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  pollIntervalMs: 30_000,
  stuckThresholdMs: 5 * 60 * 1000,
  contextBloatLines: 5000,
  staleOutputChecks: 3,
};

export interface MonitorDeps {
  messageBus: MessageBus;
  fileLocks: FileLockRegistry;
  /** Get recent output from a session's container */
  getSessionOutput: (sessionId: string, lines?: number) => Promise<string>;
  /** Check if a session is still alive */
  isSessionAlive: (sessionId: string) => Promise<boolean>;
  /** Kill a session */
  killSession: (sessionId: string) => Promise<void>;
  /** Respawn a session with a summary of prior progress */
  respawnWithSummary: (params: {
    planId: string;
    taskId: string;
    sessionId: string;
    progressSummary: string;
  }) => Promise<string>;
}

interface SessionState {
  sessionId: string;
  taskId: string;
  planId: string;
  lastOutputHash: string;
  staleChecks: number;
  lastActivityAt: number;
  outputLineCount: number;
}

function hashOutput(output: string): string {
  // Simple hash — we just need to detect change, not cryptographic strength
  let hash = 0;
  for (let i = 0; i < output.length; i++) {
    const char = output.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return String(hash);
}

export function createMonitor(
  deps: MonitorDeps,
  config: Partial<MonitorConfig> = {},
): {
  /** Register a session to monitor */
  track(planId: string, taskId: string, sessionId: string): void;
  /** Remove a session from monitoring */
  untrack(sessionId: string): void;
  /** Run one monitoring cycle */
  check(): Promise<MonitorResult[]>;
  /** Start the polling loop */
  start(): void;
  /** Stop the polling loop */
  stop(): void;
  /** Register event handler */
  onEvent(handler: PlannerEventHandler): void;
} {
  const cfg = { ...DEFAULT_MONITOR_CONFIG, ...config };
  const sessions = new Map<string, SessionState>();
  const eventHandlers: PlannerEventHandler[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  function emit(event: Omit<PlannerEvent, "timestamp">): void {
    const full: PlannerEvent = { ...event, timestamp: Date.now() };
    for (const handler of eventHandlers) {
      try { handler(full); } catch { /* */ }
    }
  }

  return {
    track(planId, taskId, sessionId) {
      sessions.set(sessionId, {
        sessionId,
        taskId,
        planId,
        lastOutputHash: "",
        staleChecks: 0,
        lastActivityAt: Date.now(),
        outputLineCount: 0,
      });
    },

    untrack(sessionId) {
      sessions.delete(sessionId);
    },

    async check(): Promise<MonitorResult[]> {
      const results: MonitorResult[] = [];

      for (const [sessionId, state] of sessions) {
        // Check if session is still alive
        const alive = await deps.isSessionAlive(sessionId);
        if (!alive) {
          results.push({
            sessionId,
            taskId: state.taskId,
            planId: state.planId,
            issue: "dead",
            detail: "Session container is no longer running",
          });
          continue;
        }

        // Get recent output
        const output = await deps.getSessionOutput(sessionId, 100);
        const currentHash = hashOutput(output);

        // Check for stale output (agent stuck)
        if (currentHash === state.lastOutputHash) {
          state.staleChecks++;
          if (state.staleChecks >= cfg.staleOutputChecks) {
            const stuckDuration = Date.now() - state.lastActivityAt;
            if (stuckDuration >= cfg.stuckThresholdMs) {
              emit({
                type: "agent_stuck",
                planId: state.planId,
                taskId: state.taskId,
                sessionId,
                detail: `No output change for ${Math.round(stuckDuration / 1000)}s`,
              });
              results.push({
                sessionId,
                taskId: state.taskId,
                planId: state.planId,
                issue: "stuck",
                detail: `Stale for ${state.staleChecks} checks (${Math.round(stuckDuration / 1000)}s)`,
              });
            }
          }
        } else {
          state.lastOutputHash = currentHash;
          state.staleChecks = 0;
          state.lastActivityAt = Date.now();
        }

        // Check for context bloat
        const fullOutput = await deps.getSessionOutput(sessionId, cfg.contextBloatLines + 100);
        const lineCount = fullOutput.split("\n").length;
        state.outputLineCount = lineCount;

        if (lineCount > cfg.contextBloatLines) {
          emit({
            type: "agent_stuck",
            planId: state.planId,
            taskId: state.taskId,
            sessionId,
            detail: `Context bloat detected: ${lineCount} lines of output`,
          });

          // Extract a progress summary from the output
          const summary = extractProgressSummary(fullOutput);

          // Kill and respawn with summary
          const newSessionId = await deps.respawnWithSummary({
            planId: state.planId,
            taskId: state.taskId,
            sessionId,
            progressSummary: summary,
          });

          // Update tracking
          sessions.delete(sessionId);
          sessions.set(newSessionId, {
            sessionId: newSessionId,
            taskId: state.taskId,
            planId: state.planId,
            lastOutputHash: "",
            staleChecks: 0,
            lastActivityAt: Date.now(),
            outputLineCount: 0,
          });

          emit({
            type: "agent_unstuck",
            planId: state.planId,
            taskId: state.taskId,
            sessionId: newSessionId,
            detail: `Respawned with progress summary (was ${lineCount} lines)`,
          });

          results.push({
            sessionId: newSessionId,
            taskId: state.taskId,
            planId: state.planId,
            issue: "respawned",
            detail: `Context bloat (${lineCount} lines) — respawned as ${newSessionId}`,
          });
        }
      }

      return results;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        this.check().catch(() => { /* log error in production */ });
      }, cfg.pollIntervalMs);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    onEvent(handler) {
      eventHandlers.push(handler);
    },
  };
}

export interface MonitorResult {
  sessionId: string;
  taskId: string;
  planId: string;
  issue: "stuck" | "dead" | "bloated" | "respawned";
  detail: string;
}

/**
 * Extract a concise progress summary from agent output.
 * Looks for git commits, file changes, and recent activity.
 */
function extractProgressSummary(output: string): string {
  const lines = output.split("\n");
  const summary: string[] = [];

  // Find git commit messages
  const commitLines = lines.filter(
    (l) => l.includes("commit ") || l.match(/^\s*(feat|fix|test|refactor|docs):/),
  );
  if (commitLines.length > 0) {
    summary.push("## Commits made so far");
    for (const line of commitLines.slice(-10)) {
      summary.push(`- ${line.trim()}`);
    }
  }

  // Find file modifications
  const fileLines = lines.filter(
    (l) => l.includes("modified:") || l.includes("new file:") || l.includes("created"),
  );
  if (fileLines.length > 0) {
    summary.push("", "## Files modified");
    const seen = new Set<string>();
    for (const line of fileLines) {
      const trimmed = line.trim();
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        summary.push(`- ${trimmed}`);
      }
    }
  }

  // Get the last 20 lines of output for recent context
  summary.push("", "## Recent output (last 20 lines)");
  for (const line of lines.slice(-20)) {
    summary.push(line);
  }

  return summary.join("\n");
}
