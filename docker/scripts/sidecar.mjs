#!/usr/bin/env node
/**
 * Agent Sidecar — runs alongside Claude Code inside Docker containers.
 *
 * Responsibilities:
 * 1. Watches /tmp/ao-inbox for orchestrator→agent messages
 * 2. Publishes heartbeats to Redis so the monitor knows we're alive
 * 3. Captures token usage from Claude Code JSON output
 * 4. When the agent process exits, publishes TASK_COMPLETE or TASK_FAILED
 * 5. Forwards ABORT messages by sending SIGTERM to the agent process
 *
 * Environment variables (set by the runtime plugin):
 *   REDIS_URL        — Redis connection string (default: redis://ao-redis:6379)
 *   AO_SESSION_ID    — This agent's session ID (used as message sender)
 *   AO_PLAN_ID       — The plan this task belongs to
 *   AO_TASK_ID       — The task ID within the plan
 *   AO_SKILL         — The skill assigned to this agent
 */

import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
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
const SESSION_ID = process.env.AO_SESSION_ID ?? "unknown";
const PLAN_ID = process.env.AO_PLAN_ID ?? "";
const TASK_ID = process.env.AO_TASK_ID ?? "";
const SKILL = process.env.AO_SKILL ?? "fullstack";

const HEARTBEAT_INTERVAL_MS = 15_000;
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

// Keep track of the last few output lines for activity reporting
const recentLines = [];
const MAX_RECENT_LINES = 5;

function trackLine(line) {
  recentLines.push(line);
  if (recentLines.length > MAX_RECENT_LINES) {
    recentLines.shift();
  }
}

/** Try to parse a JSON result line from Claude Code --output-format json */
function tryParseUsage(line) {
  try {
    const data = JSON.parse(line);
    if (data.type === "result" && data.usage) {
      sessionUsage = {
        inputTokens: data.usage.input_tokens ?? 0,
        outputTokens: data.usage.output_tokens ?? 0,
        cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
        costUsd: data.total_cost_usd ?? 0,
      };
      return data;
    }
  } catch {
    // Not JSON or not a result — that's fine
  }
  return null;
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
    // Inject the prompt file via -p flag and --output-format json for token tracking
    if (args[0] === "bash" && args[1] === "-c" && args[2]?.includes("claude")) {
      args[2] = `${args[2]} --output-format json -p "$(cat /tmp/ao-prompt.txt)"`;
      console.log(`[sidecar] Injected prompt (${prompt.length} chars) via -p flag with JSON output`);
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

  const outputChannel = `ao:output:${SESSION_ID}`;

  // Track the last stdout line — Claude Code JSON result will be the final line
  let lastStdoutLine = "";

  function streamOutput(stream, label) {
    let buffer = "";
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      process[label === "stderr" ? "stderr" : "stdout"].write(text);

      // Buffer and publish complete lines
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          publishOutput(outputChannel, line);
          trackLine(line.trim());
          if (label === "stdout") {
            lastStdoutLine = line.trim();
          }
        }
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) {
        publishOutput(outputChannel, buffer);
        trackLine(buffer.trim());
        if (label === "stdout") {
          lastStdoutLine = buffer.trim();
        }
      }
    });
  }

  if (agentProcess.stdout) streamOutput(agentProcess.stdout, "stdout");
  if (agentProcess.stderr) streamOutput(agentProcess.stderr, "stderr");

  agentProcess.on("exit", async (code, signal) => {
    console.log(`[sidecar] Agent exited with code=${code} signal=${signal}`);

    // Stop heartbeat
    clearInterval(heartbeatTimer);

    // Try to parse token usage from the last stdout line (JSON output)
    const resultData = tryParseUsage(lastStdoutLine);
    if (resultData) {
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

    if (code === 0) {
      await publishToOrchestrator("TASK_COMPLETE", {
        branch: gitInfo.branch,
        commits: gitInfo.commits,
        summary: resultData?.result
          ? resultData.result.slice(0, 500)
          : `Task ${TASK_ID} completed successfully (skill: ${SKILL})`,
        usage: sessionUsage,
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
// Heartbeat
// ---------------------------------------------------------------------------
let heartbeatTimer;

function startHeartbeat() {
  heartbeatTimer = setInterval(async () => {
    await publishToOrchestrator("PROGRESS_UPDATE", {
      status: "alive",
      skill: SKILL,
      usage: sessionUsage,
      recentActivity: recentLines.slice(-3).join(" | "),
    });

    // Periodically persist usage
    await updatePlanUsage();
  }, HEARTBEAT_INTERVAL_MS);

  // Don't let the heartbeat timer prevent process exit
  heartbeatTimer.unref();
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
  launchAgent();
}

main().catch((err) => {
  console.error("[sidecar] Fatal error:", err);
  process.exit(1);
});
