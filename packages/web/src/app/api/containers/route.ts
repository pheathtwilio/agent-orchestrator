import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

interface ContainerInfo {
  name: string;
  status: string;
  state: "running" | "exited" | "dead" | "created" | "unknown";
  createdAt: string;
  uptime: string;
}

export async function GET(): Promise<Response> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter", "name=ao-",
      "--format", "{{.Names}}\t{{.Status}}\t{{.State}}\t{{.CreatedAt}}\t{{.RunningFor}}",
    ], { timeout: 10_000 });

    const containers: ContainerInfo[] = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, status, state, createdAt, uptime] = line.split("\t");
        return {
          name: name ?? "",
          status: status ?? "",
          state: (state as ContainerInfo["state"]) ?? "unknown",
          createdAt: createdAt ?? "",
          uptime: uptime ?? "",
        };
      })
      .filter((c) => c.name !== "ao-redis");

    return NextResponse.json({ containers });
  } catch {
    return NextResponse.json({ containers: [] });
  }
}
