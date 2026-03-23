#!/usr/bin/env node
/**
 * Agent Sidecar — runs alongside Claude Code inside Docker containers.
 *
 * Responsibilities:
 * 1. Watches /tmp/ao-inbox for orchestrator→agent messages
 * 2. Publishes heartbeats to Redis so the monitor knows we're alive
 * 3. Parses Claude Code stream-json output for real-time telemetry
 * 4. Detects long-running tool calls and subprocess hangs
 * 5. When the agent process exits, publishes TASK_COMPLETE or TASK_FAILED
 * 6. Forwards ABORT messages by sending SIGTERM to the agent process
 *
 * Environment variables (set by the runtime plugin):
 *   REDIS_URL        — Redis connection string (default: redis://ao-redis:6379)
 *   AO_SESSION_ID    — This agent's session ID (used as message sender)
 *   AO_PLAN_ID       — The plan this task belongs to
 *   AO_TASK_ID       — The task ID within the plan
 *   AO_SKILL         — The skill assigned to this agent
 */

import { randomUUID } from "node:crypto";
import { spawn, execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

// ioredis is installed globally — resolve from global node_modules
const require = createRequire(import.meta.url);
let Redis;
try {
  const RedisModule = require("ioredis");
  Redis = RedisModule.default ?? RedisModule;
} catch {
  // Fallback: try dynamic import (works if NODE_PATH includes global modules)
  const RedisModule = await import("ioredis");
  Redis = RedisModule.default ?? RedisModule;
}

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const REDIS_URL = process.env.REDIS_URL ?? "redis://ao-redis:6379";
// AO_SESSION_NAME is the short user-facing ID (e.g. "om-21") that matches
// what the planner stores as assignedTo. AO_SESSION_ID is the runtime ID
// (e.g. "1838b7eb0585-om-21") which includes the tmux/config hash prefix.
// Use the short name for Redis pub/sub channels so the SSE route can subscribe.
const SESSION_ID = process.env.AO_SESSION_NAME ?? process.env.AO_SESSION_ID ?? "unknown";
const PLAN_ID = process.env.AO_PLAN_ID ?? "";
const TASK_ID = process.env.AO_TASK_ID ?? "";
const SKILL = process.env.AO_SKILL ?? "fullstack";

const HEARTBEAT_INTERVAL_MS = 15_000;
const PROCESS_MONITOR_INTERVAL_MS = 10_000;
const TOOL_LONG_RUNNING_MS = 5 * 60 * 1000; // 5 minutes
const INBOX_PATH = "/tmp/ao-inbox";
const INBOX_POLL_MS = 2_000;
const USAGE_KEY = `ao:usage:${PLAN_ID}`;

// ---------------------------------------------------------------------------
// Token usage tracking
// ---------------------------------------------------------------------------
let sessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

// ---------------------------------------------------------------------------
// Tool call tracking (from stream-json events)
// ---------------------------------------------------------------------------
/** @type {Map<string, {name: string, startedAt: number, input: string}>} */
const activeToolCalls = new Map();

/** @type {{name: string, durationMs: number}|null} */
let lastCompletedTool = null;

/** Current agent phase derived from stream-json events */
let agentPhase = "starting"; // starting | thinking | tool_use | idle

// Keep last few activity descriptions for heartbeat
const recentActivities = [];
const MAX_RECENT_ACTIVITIES = 5;

function pushActivity(desc) {
  recentActivities.push(desc);
  if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
    recentActivities.shift();
  }
}

// ---------------------------------------------------------------------------
// Process monitoring
// ---------------------------------------------------------------------------
let agentPid = null;

/** Get child processes of the agent, looking for long-running ones */
function getChildProcesses() {
  if (!agentPid) return [];
  try {
    // ps -o pid,etime,comm for child processes
    const output = execSync(
      `ps --ppid ${agentPid} -o pid=,etimes=,comm= 2>/dev/null || ps -o pid=,etime=,comm= -p $(pgrep -P ${agentPid} 2>/dev/null | tr '\\n' ',') 2>/dev/null || true`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim();
    if (!output) return [];

    return output.split("\n").filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const elapsedSec = parseInt(parts[1], 10) || 0;
      const comm = parts.slice(2).join(" ");
      return { pid, elapsedSec, comm };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Redis helpers — minimal, no dependency on @composio/ao-message-bus
// ---------------------------------------------------------------------------
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
let redisConnected = false;

async function ensureRedis() {
  if (!redisConnected) {
    await redis.connect();
    redisConnected = true;
  }
}

/** Publish a message to the orchestrator's Redis Stream inbox */
async function publishToOrchestrator(type, payload) {
  try {
    await ensureRedis();

    const msg = {
      id: randomUUID(),
      type,
      from: SESSION_ID,
      to: "orchestrator",
      timestamp: String(Date.now()),
      payload: JSON.stringify({ planId: PLAN_ID, taskId: TASK_ID, ...payload }),
    };

    await redis.xadd(
      "ao:inbox:orchestrator",
      "MAXLEN", "~", "1000",
      "*",
      ...Object.entries(msg).flat(),
    );
  } catch (err) {
    console.error(`[sidecar] Failed to publish ${type}:`, err.message);
  }
}

/** Publish a line of agent output to Redis pub/sub for real-time streaming */
async function publishOutput(channel, line) {
  try {
    await ensureRedis();
    await redis.publish(channel, JSON.stringify({
      sessionId: SESSION_ID,
      timestamp: Date.now(),
      line,
    }));
  } catch {
    // Non-critical — don't let output streaming failures affect the agent
  }
}

/** Update cumulative token usage for this plan in Redis */
async function updatePlanUsage() {
  if (!PLAN_ID) return;
  try {
    await ensureRedis();
    // Store per-session usage as a hash field, and increment plan totals
    await redis.hset(USAGE_KEY, SESSION_ID, JSON.stringify({
      taskId: TASK_ID,
      skill: SKILL,
      ...sessionUsage,
      updatedAt: Date.now(),
    }));
  } catch {
    // Non-critical
  }
}

// ---------------------------------------------------------------------------
// stream-json event parser
// ---------------------------------------------------------------------------

/**
 * Parse a stream-json event line from Claude Code and extract telemetry.
 * Returns a human-readable description for the output stream, or null to skip.
 */
function parseStreamEvent(line) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    // Not JSON — raw text output, pass through
    return line;
  }

  switch (data.type) {
    case "system": {
      if (data.subtype === "init") {
        agentPhase = "idle";
        return `[init] session=${data.session_id} model=${data.model}`;
      }
      return null;
    }

    case "assistant": {
      const content = data.message?.content;
      if (!Array.isArray(content)) return null;

      const parts = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          // Track tool call start
          activeToolCalls.set(block.id, {
            name: block.name,
            startedAt: Date.now(),
            input: summarizeToolInput(block.name, block.input),
          });
          agentPhase = "tool_use";
          const desc = `[tool] ${block.name}: ${summarizeToolInput(block.name, block.input)}`;
          pushActivity(desc);
          parts.push(desc);
        } else if (block.type === "thinking" && block.thinking) {
          agentPhase = "thinking";
          const preview = block.thinking.length > 200 ? block.thinking.slice(0, 200) + "..." : block.thinking;
          parts.push(`[thinking] ${preview}`);
          pushActivity(preview.slice(0, 80));
        } else if (block.type === "text" && block.text) {
          agentPhase = "responding";
          const preview = block.text.length > 200 ? block.text.slice(0, 200) + "..." : block.text;
          parts.push(preview);
          pushActivity(preview.slice(0, 80));
        }
      }

      // Update usage from the message if available
      if (data.message?.usage) {
        const u = data.message.usage;
        sessionUsage.inputTokens += u.input_tokens ?? 0;
        sessionUsage.outputTokens += u.output_tokens ?? 0;
        sessionUsage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        sessionUsage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      }

      return parts.join("\n") || null;
    }

    case "user": {
      // Tool result — mark tool call as complete
      const toolUseId = data.message?.content?.[0]?.tool_use_id
        ?? data.message?.content?.find?.(c => c.tool_use_id)?.tool_use_id;
      if (toolUseId && activeToolCalls.has(toolUseId)) {
        const tc = activeToolCalls.get(toolUseId);
        const durationMs = Date.now() - tc.startedAt;
        lastCompletedTool = { name: tc.name, durationMs };
        activeToolCalls.delete(toolUseId);

        if (activeToolCalls.size === 0) {
          agentPhase = "thinking";
        }

        // Summarize the tool result
        const result = data.tool_use_result;
        if (result) {
          const desc = `[result] ${tc.name} (${(durationMs / 1000).toFixed(1)}s)`;
          pushActivity(desc);
          // Include abbreviated result for streaming
          if (result.stdout) {
            const lines = result.stdout.split("\n").filter(Boolean);
            if (lines.length <= 3) {
              return `${desc}: ${result.stdout.slice(0, 200)}`;
            }
            return `${desc}: ${lines.length} lines`;
          }
          return desc;
        }
        return `[result] ${tc.name} (${(durationMs / 1000).toFixed(1)}s)`;
      }
      return null;
    }

    case "result": {
      agentPhase = "complete";
      // Final result — extract usage totals
      if (data.usage) {
        sessionUsage = {
          inputTokens: data.usage.input_tokens ?? sessionUsage.inputTokens,
          outputTokens: data.usage.output_tokens ?? sessionUsage.outputTokens,
          cacheReadTokens: data.usage.cache_read_input_tokens ?? sessionUsage.cacheReadTokens,
          cacheCreationTokens: data.usage.cache_creation_input_tokens ?? sessionUsage.cacheCreationTokens,
          costUsd: data.total_cost_usd ?? sessionUsage.costUsd,
        };
      }
      return data.result
        ? `[complete] ${data.result.slice(0, 300)}`
        : `[complete] ${data.subtype}`;
    }

    default:
      return null;
  }
}

/** Create a short summary of tool input for display */
function summarizeToolInput(toolName, input) {
  if (!input) return "";
  switch (toolName) {
    case "Bash":
      return input.command?.slice(0, 120) ?? "";
    case "Read":
      return input.file_path?.split("/").pop() ?? "";
    case "Write":
    case "Edit":
      return input.file_path?.split("/").pop() ?? "";
    case "Grep":
      return `/${input.pattern}/ in ${input.path?.split("/").pop() ?? "."}`;
    case "Glob":
      return input.pattern ?? "";
    case "Agent":
      return input.description ?? "";
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

// ---------------------------------------------------------------------------
// Inbox watcher — reads orchestrator messages from /tmp/ao-inbox
// ---------------------------------------------------------------------------
let lastInboxSize = 0;
let agentProcess = null;

function processInbox() {
  if (!existsSync(INBOX_PATH)) return;

  try {
    const content = readFileSync(INBOX_PATH, "utf-8");
    if (content.length <= lastInboxSize) return;

    // Process only new lines
    const newContent = content.slice(lastInboxSize);
    lastInboxSize = content.length;

    for (const line of newContent.split("\n").filter(Boolean)) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Not JSON — might be a raw text message, ignore
        continue;
      }

      console.log(`[sidecar] Received message: ${msg.type}`);

      if (msg.type === "ABORT" && agentProcess) {
        console.log("[sidecar] Aborting agent process...");
        agentProcess.kill("SIGTERM");
      }
    }
  } catch (err) {
    // File might be mid-write, try again next poll
  }
}

// ---------------------------------------------------------------------------
// Agent process launcher
// ---------------------------------------------------------------------------
function launchAgent() {
  // The actual command is passed as arguments to this script
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("[sidecar] No agent command provided");
    process.exit(1);
  }

  // If AO_PROMPT is set, write it to a file and inject --print flag for one-shot mode.
  // This is needed because Docker containers can't receive post-launch prompts
  // the way tmux sessions can.
  const prompt = process.env.AO_PROMPT;
  if (prompt) {
    const promptFile = "/tmp/ao-prompt.txt";
    writeFileSync(promptFile, prompt);

    // The launch command comes as: bash -c "claude --dangerously-skip-permissions ..."
    // Inject the prompt file via -p flag and --output-format stream-json for telemetry
    if (args[0] === "bash" && args[1] === "-c" && args[2]?.includes("claude")) {
      args[2] = `${args[2]} --output-format stream-json --verbose -p "$(cat /tmp/ao-prompt.txt)"`;
      console.log(`[sidecar] Injected prompt (${prompt.length} chars) via -p flag with stream-json output`);
    }
  }

  console.log(`[sidecar] Launching agent: ${args[0]} ...${args.length > 1 ? ` (${args.length - 1} args)` : ""}`);

  // Capture stdout/stderr and publish lines to Redis pub/sub for real-time streaming.
  // Also pipe to our own stdout so `docker logs` still works.
  agentProcess = spawn(args[0], args.slice(1), {
    cwd: "/workspace",
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  agentPid = agentProcess.pid;
  const outputChannel = `ao:output:${SESSION_ID}`;

  // Track the last result data for completion reporting
  let lastResultData = null;

  function streamOutput(stream, label) {
    let buffer = "";
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      // Always mirror to our own stdout/stderr for docker logs
      process[label === "stderr" ? "stderr" : "stdout"].write(text);

      // Buffer and process complete lines
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;

        if (label === "stdout") {
          // Parse stream-json events for telemetry
          const parsed = parseStreamEvent(rawLine);
          if (parsed) {
            publishOutput(outputChannel, parsed);
          }

          // Check for final result to capture usage/summary
          try {
            const data = JSON.parse(rawLine);
            if (data.type === "result") {
              lastResultData = data;
            }
          } catch {
            // Not JSON — that's fine
          }
        } else {
          // stderr goes through as-is
          publishOutput(outputChannel, `[stderr] ${rawLine}`);
          pushActivity(`[stderr] ${rawLine.slice(0, 80)}`);
        }
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) {
        if (label === "stdout") {
          const parsed = parseStreamEvent(buffer);
          if (parsed) publishOutput(outputChannel, parsed);
          try {
            const data = JSON.parse(buffer);
            if (data.type === "result") lastResultData = data;
          } catch { /* ignore */ }
        } else {
          publishOutput(outputChannel, `[stderr] ${buffer}`);
        }
      }
    });
  }

  if (agentProcess.stdout) streamOutput(agentProcess.stdout, "stdout");
  if (agentProcess.stderr) streamOutput(agentProcess.stderr, "stderr");

  agentProcess.on("exit", async (code, signal) => {
    console.log(`[sidecar] Agent exited with code=${code} signal=${signal}`);

    // Stop timers
    clearInterval(heartbeatTimer);
    clearInterval(processMonitorTimer);

    // Extract usage from the final result event
    if (lastResultData) {
      if (lastResultData.usage) {
        sessionUsage = {
          inputTokens: lastResultData.usage.input_tokens ?? 0,
          outputTokens: lastResultData.usage.output_tokens ?? 0,
          cacheReadTokens: lastResultData.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: lastResultData.usage.cache_creation_input_tokens ?? 0,
          costUsd: lastResultData.total_cost_usd ?? 0,
        };
      }
      console.log(`[sidecar] Token usage — input: ${sessionUsage.inputTokens}, output: ${sessionUsage.outputTokens}, cost: $${sessionUsage.costUsd.toFixed(4)}`);
    }

    // Persist final usage to Redis
    await updatePlanUsage();

    // Collect git info for the completion report
    let gitInfo = { branch: "", commits: [] };
    try {
      gitInfo.branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: "/workspace", encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch { /* ignore */ }
    try {
      const log = execFileSync("git", ["log", "--oneline", "-5"], {
        cwd: "/workspace", encoding: "utf-8", timeout: 5000,
      }).trim();
      if (log) {
        gitInfo.commits = log.split("\n").map((l) => l.split(" ")[0]);
      }
    } catch { /* ignore */ }

    // Check for structured plan output (written by planner agents)
    let planOutput = undefined;
    const PLAN_OUTPUT_PATH = "/tmp/ao-plan-output.json";
    try {
      if (existsSync(PLAN_OUTPUT_PATH)) {
        const raw = readFileSync(PLAN_OUTPUT_PATH, "utf-8");
        planOutput = JSON.parse(raw);
        console.log(`[sidecar] Found plan output: ${Array.isArray(planOutput) ? planOutput.length : 0} tasks`);
      }
    } catch (err) {
      console.error(`[sidecar] Failed to read plan output: ${err.message}`);
    }

    if (code === 0) {
      await publishToOrchestrator("TASK_COMPLETE", {
        branch: gitInfo.branch,
        commits: gitInfo.commits,
        summary: lastResultData?.result
          ? lastResultData.result.slice(0, 500)
          : `Task ${TASK_ID} completed successfully (skill: ${SKILL})`,
        usage: sessionUsage,
        ...(planOutput && { tasks: planOutput }),
      });
    } else {
      await publishToOrchestrator("TASK_FAILED", {
        error: signal ? `Killed by ${signal}` : `Exit code ${code}`,
        branch: gitInfo.branch,
        commits: gitInfo.commits,
        usage: sessionUsage,
      });
    }

    // Give Redis time to flush, then exit with the agent's code
    setTimeout(() => {
      redis.quit().catch(() => {});
      process.exit(code ?? 1);
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// Heartbeat — includes telemetry from stream-json parsing
// ---------------------------------------------------------------------------
let heartbeatTimer;

function startHeartbeat() {
  heartbeatTimer = setInterval(async () => {
    // Build tool call state for the heartbeat
    const activeTools = [];
    const now = Date.now();
    for (const [id, tc] of activeToolCalls) {
      const runningMs = now - tc.startedAt;
      activeTools.push({
        name: tc.name,
        input: tc.input.slice(0, 100),
        runningMs,
      });
    }

    // Flag any tool running longer than the threshold
    const longRunningTool = activeTools.find((t) => t.runningMs > TOOL_LONG_RUNNING_MS);

    await publishToOrchestrator("PROGRESS_UPDATE", {
      status: longRunningTool ? "tool_hung" : "alive",
      skill: SKILL,
      agentPhase,
      usage: sessionUsage,
      activeTools,
      lastCompletedTool: lastCompletedTool
        ? { name: lastCompletedTool.name, durationMs: lastCompletedTool.durationMs }
        : null,
      recentActivity: recentActivities.slice(-3).join(" | "),
      longRunningTool: longRunningTool
        ? { name: longRunningTool.name, runningMs: longRunningTool.runningMs, input: longRunningTool.input }
        : null,
    });

    // Periodically persist usage
    await updatePlanUsage();
  }, HEARTBEAT_INTERVAL_MS);

  // Don't let the heartbeat timer prevent process exit
  heartbeatTimer.unref();
}

// ---------------------------------------------------------------------------
// Process monitor — detect hung subprocesses
// ---------------------------------------------------------------------------
let processMonitorTimer;

function startProcessMonitor() {
  processMonitorTimer = setInterval(async () => {
    const children = getChildProcesses();
    const longRunning = children.filter((p) => p.elapsedSec > 300); // >5 min

    if (longRunning.length > 0) {
      const procs = longRunning.map((p) => `${p.comm}(pid=${p.pid}, ${p.elapsedSec}s)`).join(", ");
      console.log(`[sidecar] Long-running subprocesses: ${procs}`);

      await publishToOrchestrator("PROGRESS_UPDATE", {
        status: "subprocess_hung",
        skill: SKILL,
        agentPhase,
        usage: sessionUsage,
        hungProcesses: longRunning.map((p) => ({
          pid: p.pid,
          command: p.comm,
          elapsedSeconds: p.elapsedSec,
        })),
        recentActivity: recentActivities.slice(-3).join(" | "),
      });
    }
  }, PROCESS_MONITOR_INTERVAL_MS);

  processMonitorTimer.unref();
}

// ---------------------------------------------------------------------------
// Inbox polling
// ---------------------------------------------------------------------------
let inboxTimer;

function startInboxWatcher() {
  // Initialize the inbox file
  if (!existsSync(INBOX_PATH)) {
    writeFileSync(INBOX_PATH, "");
  }

  inboxTimer = setInterval(processInbox, INBOX_POLL_MS);
  inboxTimer.unref();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[sidecar] Starting — session=${SESSION_ID} plan=${PLAN_ID} task=${TASK_ID}`);

  try {
    await ensureRedis();
    console.log("[sidecar] Redis connected");
  } catch (err) {
    console.error(`[sidecar] Redis connection failed: ${err.message}`);
    console.error("[sidecar] Continuing without Redis — agent will run but cannot report back");
  }

  // Publish initial status
  await publishToOrchestrator("PROGRESS_UPDATE", {
    status: "starting",
    skill: SKILL,
    usage: sessionUsage,
  });

  startHeartbeat();
  startInboxWatcher();
  startProcessMonitor();
  launchAgent();
}

main().catch((err) => {
  console.error("[sidecar] Fatal error:", err);
  process.exit(1);
});
