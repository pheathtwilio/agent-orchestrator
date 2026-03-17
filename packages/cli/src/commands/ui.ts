/**
 * `ao ui` — lightweight command to start the web dashboard + Redis.
 *
 * Unlike `ao start`, this does NOT create an orchestrator tmux session
 * or lifecycle worker. It only ensures Redis is running and starts the
 * Next.js dashboard. Plans are created and executed from the web UI.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { execSilent } from "../lib/shell.js";
import {
  findWebDir,
  buildDashboardEnv,
  waitForPortAndOpen,
  isPortAvailable,
  findFreePort,
  MAX_PORT_SCAN,
} from "../lib/web-dir.js";
import { cleanNextCache } from "../lib/dashboard-rebuild.js";
import { preflight } from "../lib/preflight.js";

const DEFAULT_PORT = 3000;
const REDIS_CONTAINER_NAME = "ao-redis";
const REDIS_PORT = 6379;
const DOCKER_NETWORK = "ao-network";

/**
 * Ensure the ao-network Docker network exists.
 * Agent containers and Redis need to be on the same network
 * so agents can reach Redis via container DNS (redis://ao-redis:6379).
 */
async function ensureDockerNetwork(): Promise<void> {
  const exists = await execSilent("docker", [
    "network", "inspect", DOCKER_NETWORK,
  ]);
  if (exists === null) {
    await execSilent("docker", ["network", "create", DOCKER_NETWORK]);
  }
}

/**
 * Ensure a Redis container is running on ao-network. Starts one if needed.
 * Returns true if Redis is confirmed available.
 */
async function ensureRedis(): Promise<boolean> {
  // Check if something is already listening on the Redis port
  const redisAvailable = !(await isPortAvailable(REDIS_PORT));
  if (redisAvailable) {
    // Ensure the existing Redis container is on ao-network (best effort)
    await execSilent("docker", [
      "network", "connect", DOCKER_NETWORK, REDIS_CONTAINER_NAME,
    ]);
    return true;
  }

  // Check if Docker is available
  const hasDocker = (await execSilent("docker", ["info"])) !== null;
  if (!hasDocker) {
    return false;
  }

  // Ensure the network exists before creating/starting the container
  await ensureDockerNetwork();

  // Check if container exists but is stopped
  const inspectResult = await execSilent("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    REDIS_CONTAINER_NAME,
  ]);

  if (inspectResult !== null) {
    if (inspectResult.trim() === "true") {
      // Container exists and is running — ensure it's on the network
      await execSilent("docker", [
        "network", "connect", DOCKER_NETWORK, REDIS_CONTAINER_NAME,
      ]);
      return true;
    }
    // Container exists but stopped — restart it
    await execSilent("docker", ["start", REDIS_CONTAINER_NAME]);
    // Wait briefly for Redis to accept connections
    for (let i = 0; i < 10; i++) {
      if (!(await isPortAvailable(REDIS_PORT))) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return !(await isPortAvailable(REDIS_PORT));
  }

  // No container exists — create one on ao-network
  const result = await execSilent("docker", [
    "run",
    "-d",
    "--name",
    REDIS_CONTAINER_NAME,
    "--network",
    DOCKER_NETWORK,
    "-p",
    `${REDIS_PORT}:6379`,
    "--restart",
    "unless-stopped",
    "redis:7-alpine",
  ]);

  if (result === null) {
    return false;
  }

  // Wait for Redis to be ready
  for (let i = 0; i < 10; i++) {
    if (!(await isPortAvailable(REDIS_PORT))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }

  return !(await isPortAvailable(REDIS_PORT));
}

export function registerUI(program: Command): void {
  program
    .command("ui")
    .description("Start Redis and the web dashboard (lightweight — no orchestrator session)")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .option("--rebuild", "Clean stale build artifacts before starting")
    .action(async (opts: { port?: string; open?: boolean; rebuild?: boolean }) => {
      try {
        const config = loadConfig();
        const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? DEFAULT_PORT);

        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(chalk.red("Invalid port number. Must be 1-65535."));
          process.exit(1);
        }

        const projectIds = Object.keys(config.projects);
        const projectName = projectIds[0]
          ? config.projects[projectIds[0]].name
          : "unknown";
        const repo = projectIds[0]
          ? config.projects[projectIds[0]].repo
          : "";

        console.log(chalk.bold.cyan(`\n  Agent Orchestrator — ${projectName}\n`));
        if (repo) {
          console.log(chalk.dim(`  ${repo}\n`));
        }

        const spinner = ora();

        // 1. Ensure Redis
        spinner.start("Ensuring Redis is running");
        const redisOk = await ensureRedis();
        if (redisOk) {
          spinner.succeed("Redis is running");
        } else {
          spinner.fail("Redis is not available");
          console.error(
            chalk.red("\nCould not start Redis. Options:\n") +
            chalk.dim("  • Install Docker and try again\n") +
            chalk.dim("  • Start Redis manually: redis-server\n") +
            chalk.dim("  • Or: docker run -d --name ao-redis -p 6379:6379 redis:7-alpine\n"),
          );
          process.exit(1);
        }

        // 2. Check port
        if (!(await isPortAvailable(port))) {
          const freePort = await findFreePort(port + 1);
          if (freePort) {
            console.log(chalk.yellow(`  Port ${port} is busy — using ${freePort}`));
            await startDashboard(config.configPath, freePort, opts, config.terminalPort, config.directTerminalPort);
          } else {
            console.error(chalk.red(`No free port found in range ${port}–${port + MAX_PORT_SCAN - 1}.`));
            process.exit(1);
          }
        } else {
          await startDashboard(config.configPath, port, opts, config.terminalPort, config.directTerminalPort);
        }
      } catch (err) {
        if (err instanceof Error) {
          if (err.message.includes("No agent-orchestrator.yaml found")) {
            console.error(chalk.red("\nNo config found. Run:"));
            console.error(chalk.cyan("  ao init --auto\n"));
          } else {
            console.error(chalk.red("\nError:"), err.message);
          }
        } else {
          console.error(chalk.red("\nError:"), String(err));
        }
        process.exit(1);
      }
    });
}

async function startDashboard(
  configPath: string,
  port: number,
  opts: { open?: boolean; rebuild?: boolean },
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<void> {
  const spinner = ora();
  const webDir = findWebDir();

  if (!existsSync(resolve(webDir, "package.json"))) {
    console.error(
      chalk.red("Could not find @composio/ao-web package.\nEnsure it is installed: pnpm install"),
    );
    process.exit(1);
  }

  await preflight.checkBuilt(webDir);

  if (opts.rebuild) {
    await cleanNextCache(webDir);
  }

  spinner.start("Starting dashboard");
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  const child: ChildProcess = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: webDir,
    stdio: "inherit",
    detached: false,
    env,
  });

  spinner.succeed(`Dashboard running at ${chalk.cyan(`http://localhost:${port}`)}`);
  console.log(chalk.dim("  Press Ctrl+C to stop\n"));

  let openAbort: AbortController | undefined;
  if (opts.open !== false) {
    openAbort = new AbortController();
    void waitForPortAndOpen(port, `http://localhost:${port}/plans`, openAbort.signal);
  }

  child.on("error", (err) => {
    console.error(chalk.red("Dashboard failed:"), err.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    if (openAbort) openAbort.abort();
    process.exit(code ?? 0);
  });
}
