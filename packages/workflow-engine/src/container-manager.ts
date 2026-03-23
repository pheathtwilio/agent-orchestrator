import { spawn, type ChildProcess } from "node:child_process";
import type { EngineEvent } from "./types.js";

const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function parseContainerName(name: string): { planId: string; taskId: string } | null {
  if (!name.startsWith("ao--")) return null;
  const parts = name.split("--");
  if (parts.length < 3) return null;
  return { planId: parts[1], taskId: parts.slice(2).join("--") };
}

export function containerName(planId: string, taskId: string): string {
  return `ao--${planId}--${taskId}`;
}

export interface ContainerInfo {
  name: string;
  state: string;
}

export interface ContainerManagerDeps {
  listContainers(): Promise<ContainerInfo[]>;
  lookupContainer(name: string): Promise<{ planId: string; taskId: string } | null>;
  getRunningTasks(): Promise<Map<string, { planId: string; taskId: string }>>;
  killContainer(name: string): Promise<void>;
  feedEvent(event: EngineEvent): void;
  getHeartbeats(): Promise<Record<string, number>>;
}

export class ContainerManager {
  private deps: ContainerManagerDeps;
  private dockerEventsProc: ChildProcess | null = null;

  constructor(deps: ContainerManagerDeps) {
    this.deps = deps;
  }

  async reconcile(): Promise<void> {
    const [containers, runningTasks, heartbeats] = await Promise.all([
      this.deps.listContainers(),
      this.deps.getRunningTasks(),
      this.deps.getHeartbeats(),
    ]);

    const containerSet = new Set<string>();
    const now = Date.now();

    for (const container of containers) {
      const parsed = parseContainerName(container.name);
      if (!parsed) continue;

      const taskKey = `${parsed.planId}:${parsed.taskId}`;
      containerSet.add(taskKey);

      // Container exists but no matching running task -> orphan container
      if (!runningTasks.has(taskKey)) {
        await this.deps.killContainer(container.name);
        continue;
      }

      // Check heartbeat timeout
      const lastHeartbeat = heartbeats[taskKey];
      if (lastHeartbeat && (now - lastHeartbeat) > HEARTBEAT_TIMEOUT_MS) {
        this.deps.feedEvent({
          type: "HEARTBEAT_TIMEOUT",
          planId: parsed.planId,
          taskId: parsed.taskId,
        });
      }
    }

    // Check each running task — if no container exists, feed CONTAINER_DIED
    for (const [taskKey, info] of runningTasks) {
      if (!containerSet.has(taskKey)) {
        this.deps.feedEvent({
          type: "CONTAINER_DIED",
          planId: info.planId,
          taskId: info.taskId,
          containerId: containerName(info.planId, info.taskId),
        });
      }
    }
  }

  startDockerEventStream(): void {
    const proc = spawn("docker", [
      "events", "--filter", "type=container", "--filter", "event=die",
      "--format", "{{.Actor.Attributes.name}}",
    ]);

    proc.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        const name = line.trim();
        if (!name) continue;
        const parsed = parseContainerName(name);
        if (parsed) {
          this.deps.feedEvent({
            type: "CONTAINER_DIED",
            planId: parsed.planId,
            taskId: parsed.taskId,
            containerId: name,
          });
        }
      }
    });

    proc.on("exit", () => {
      setTimeout(() => this.startDockerEventStream(), 5000);
    });

    this.dockerEventsProc = proc;
  }

  stop(): void {
    this.dockerEventsProc?.kill();
  }
}
