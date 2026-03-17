import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;

export const manifest = {
  name: "docker",
  slot: "runtime" as const,
  description: "Runtime plugin: Docker containers with isolated agent environments",
  version: "0.1.0",
};

/** Extract GitHub token from gh CLI (cached, non-fatal) */
let cachedGhToken: string | null | undefined;
async function getGhToken(): Promise<string | null> {
  if (cachedGhToken !== undefined) return cachedGhToken;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 5_000,
    });
    cachedGhToken = stdout.trim() || null;
  } catch {
    cachedGhToken = null;
  }
  return cachedGhToken;
}

/**
 * If workspacePath is a git worktree, resolve the parent repo's .git directory.
 * Worktrees have a `.git` file (not directory) containing `gitdir: /path/to/.git/worktrees/<name>`.
 * We need to mount the parent `.git` dir at the same host path inside the container
 * so git operations work correctly.
 */
function resolveWorktreeGitDir(workspacePath: string): string | null {
  const dotGit = join(workspacePath, ".git");
  try {
    if (!existsSync(dotGit)) return null;
    const content = readFileSync(dotGit, "utf-8").trim();
    // .git file format: "gitdir: /abs/path/to/.git/worktrees/<name>"
    if (!content.startsWith("gitdir:")) return null;
    const gitdir = content.replace("gitdir:", "").trim();
    // Walk up from .git/worktrees/<name> to .git
    // gitdir = /path/to/repo/.git/worktrees/ao-83
    const parts = gitdir.split("/");
    const worktreesIdx = parts.lastIndexOf("worktrees");
    if (worktreesIdx < 1) return null;
    return parts.slice(0, worktreesIdx).join("/"); // /path/to/repo/.git
  } catch {
    return null;
  }
}

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

/** Default Docker image for agent containers */
const DEFAULT_IMAGE = "ao-agent:latest";

/** Run a docker command and return stdout */
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

export function create(config?: Record<string, unknown>): Runtime {
  const image = (config?.image as string) ?? DEFAULT_IMAGE;
  const network = (config?.network as string) ?? "ao-network";
  const authMode = (config?.authMode as string) ?? "auto";

  return {
    name: "docker",

    async create(rtConfig: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(rtConfig.sessionId);
      const containerName = `ao-${rtConfig.sessionId}`;
      // Per-session image override (e.g. skill-specific Dockerfiles)
      const sessionImage = (rtConfig.runtimeConfig?.image as string) ?? image;

      // Build environment flags
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(rtConfig.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Always pass the session ID and Redis URL so the agent sidecar can connect
      envArgs.push("-e", `AO_SESSION_ID=${rtConfig.sessionId}`);
      if (!rtConfig.environment?.REDIS_URL) {
        envArgs.push("-e", "REDIS_URL=redis://ao-redis:6379");
      }

      // Auth mode: detect and configure
      const volumeArgs: string[] = [
        "-v", `${rtConfig.workspacePath}:/workspace`,
      ];

      // If workspace is a git worktree, mount the parent .git directory
      // so git can resolve the worktree reference inside the container
      const parentGitDir = resolveWorktreeGitDir(rtConfig.workspacePath);
      if (parentGitDir) {
        volumeArgs.push("-v", `${parentGitDir}:${parentGitDir}`);
      }

      const useBedrock =
        authMode === "bedrock" ||
        (authMode === "auto" && (
          process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
          (!process.env.ANTHROPIC_API_KEY && existsSync(join(homedir(), ".aws", "config")))
        ));

      if (useBedrock) {
        // Mount AWS credentials read-only for Bedrock SSO
        const awsDir = join(homedir(), ".aws");
        volumeArgs.push("-v", `${awsDir}:/home/agent/.aws:ro`);
        envArgs.push("-e", "CLAUDE_CODE_USE_BEDROCK=1");
        if (process.env.AWS_PROFILE) {
          envArgs.push("-e", `AWS_PROFILE=${process.env.AWS_PROFILE}`);
        }
        if (process.env.AWS_REGION) {
          envArgs.push("-e", `AWS_REGION=${process.env.AWS_REGION}`);
        }
        // Pass Bedrock model overrides if set
        for (const key of [
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ]) {
          if (process.env[key]) {
            envArgs.push("-e", `${key}=${process.env[key]}`);
          }
        }
      } else if (process.env.ANTHROPIC_API_KEY) {
        // Pass API key directly
        envArgs.push("-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
      }

      // GitHub auth — pass GH_TOKEN so agents can push and create PRs.
      // Sourced from: explicit env var > gh CLI token extraction
      const ghToken = process.env.GH_TOKEN ?? await getGhToken();
      if (ghToken) {
        envArgs.push("-e", `GH_TOKEN=${ghToken}`);
      }

      // Always pass model overrides if set (works in both auth modes)
      for (const key of [
        "ANTHROPIC_MODEL_OPUS",
        "ANTHROPIC_MODEL_SONNET",
        "ANTHROPIC_MODEL_HAIKU",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
      ]) {
        if (process.env[key] && !envArgs.includes(`${key}=${process.env[key]}`)) {
          envArgs.push("-e", `${key}=${process.env[key]}`);
        }
      }

      // Remove any leftover container with the same name (from a previous
      // failed/cancelled run) so docker run doesn't fail with "name already in use"
      try {
        await docker("rm", "-f", containerName);
      } catch {
        // Container doesn't exist — expected path
      }

      // Start container with workspace mounted
      // --init ensures signals propagate correctly to child processes
      await docker(
        "run", "-d",
        "--name", containerName,
        "--network", network,
        "--init",
        ...volumeArgs,
        "-w", "/workspace",
        ...envArgs,
        sessionImage,
        "bash", "-c", rtConfig.launchCommand,
      );

      // Get the container ID for the handle
      const containerId = await docker(
        "inspect", "--format", "{{.Id}}", containerName,
      );

      return {
        id: containerName,
        runtimeName: "docker",
        data: {
          containerId,
          createdAt: Date.now(),
          workspacePath: rtConfig.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        // Stop gracefully (10s timeout), then force remove
        await docker("stop", "-t", "10", handle.id);
      } catch {
        // Container may already be stopped
      }
      try {
        await docker("rm", "-f", handle.id);
      } catch {
        // Container may already be removed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      // Write a JSON envelope to the sidecar inbox file.
      // The sidecar polls this file and acts on structured messages (ABORT, etc).
      const envelope = JSON.stringify({ type: "TEXT", content: message, timestamp: Date.now() });
      const escaped = envelope.replace(/'/g, "'\\''");
      await docker(
        "exec", handle.id,
        "bash", "-c", `echo '${escaped}' >> /tmp/ao-inbox`,
      );
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await docker("logs", "--tail", String(lines), handle.id);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const state = await docker(
          "inspect", "--format", "{{.State.Running}}", handle.id,
        );
        return state === "true";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      const result: RuntimeMetrics = {
        uptimeMs: Date.now() - createdAt,
      };

      try {
        // Get memory usage from docker stats (single snapshot, no stream)
        const stats = await docker(
          "stats", "--no-stream", "--format", "{{.MemUsage}}\t{{.CPUPerc}}", handle.id,
        );
        const [memUsage, cpuPerc] = stats.split("\t");
        // Parse memory like "150.4MiB / 7.773GiB"
        const memMatch = memUsage?.match(/([\d.]+)([A-Za-z]+)/);
        if (memMatch) {
          const value = parseFloat(memMatch[1]);
          const unit = memMatch[2].toLowerCase();
          if (unit.startsWith("gib")) {
            result.memoryMb = value * 1024;
          } else {
            result.memoryMb = value;
          }
        }
        // Parse CPU like "0.50%"
        if (cpuPerc) {
          result.cpuPercent = parseFloat(cpuPerc);
        }
      } catch {
        // Stats not available — return what we have
      }

      return result;
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "docker",
        target: handle.id,
        command: `docker exec -it ${handle.id} bash`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
