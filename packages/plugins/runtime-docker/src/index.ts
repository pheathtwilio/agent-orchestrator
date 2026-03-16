import { execFile } from "node:child_process";
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

  return {
    name: "docker",

    async create(rtConfig: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(rtConfig.sessionId);
      const containerName = `ao-${rtConfig.sessionId}`;

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

      // Start container with workspace mounted
      // --init ensures signals propagate correctly to child processes
      await docker(
        "run", "-d",
        "--name", containerName,
        "--network", network,
        "--init",
        "-v", `${rtConfig.workspacePath}:/workspace`,
        "-w", "/workspace",
        ...envArgs,
        image,
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
      // Write the message to a file inside the container, then signal the agent.
      // This avoids stdin piping issues with docker exec.
      const escaped = message.replace(/'/g, "'\\''");
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
