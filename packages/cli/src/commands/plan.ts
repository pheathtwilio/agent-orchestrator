import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import {
  createPlanner,
  createMonitor,
  createTestTrigger,
  DEFAULT_PLANNER_CONFIG,
  type ExecutionPlan,
  type PlannerEvent,
  type TaskCompletionInfo,
} from "@composio/ao-planner";
import {
  createMessageBus,
  createFileLockRegistry,
  createTaskStore,
} from "@composio/ao-message-bus";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";

function formatPhase(phase: string): string {
  const colors: Record<string, (s: string) => string> = {
    planning: chalk.blue,
    review: chalk.yellow,
    executing: chalk.cyan,
    testing: chalk.magenta,
    complete: chalk.green,
    failed: chalk.red,
  };
  return (colors[phase] ?? chalk.white)(phase);
}

function formatTaskStatus(status: string): string {
  const colors: Record<string, (s: string) => string> = {
    pending: chalk.dim,
    assigned: chalk.yellow,
    in_progress: chalk.cyan,
    testing: chalk.magenta,
    complete: chalk.green,
    failed: chalk.red,
    blocked: chalk.red,
  };
  return (colors[status] ?? chalk.white)(status);
}

function printPlan(plan: ExecutionPlan): void {
  console.log();
  console.log(`  Plan:    ${chalk.bold(plan.id)}`);
  console.log(`  Feature: ${plan.featureDescription}`);
  console.log(`  Phase:   ${formatPhase(plan.phase)}`);
  console.log(`  Tasks:   ${plan.taskGraph.nodes.length}`);
  console.log(`  Active:  ${plan.activeSessions.size}`);
  console.log();

  // Task table
  const maxTitle = Math.max(
    ...plan.taskGraph.nodes.map((n) => n.title.length),
    5,
  );

  console.log(
    `  ${chalk.dim("ID".padEnd(8))} ${chalk.dim("Status".padEnd(14))} ${chalk.dim("Skill".padEnd(12))} ${chalk.dim("Title")}`,
  );
  console.log(chalk.dim("  " + "─".repeat(8 + 14 + 12 + maxTitle + 3)));

  for (const node of plan.taskGraph.nodes) {
    const id = node.id.padEnd(8);
    const status = formatTaskStatus(node.status).padEnd(14 + 10); // +10 for chalk escape codes
    const skill = (node.skill ?? "—").padEnd(12);
    const deps = node.dependsOn.length > 0
      ? chalk.dim(` ← [${node.dependsOn.join(", ")}]`)
      : "";

    console.log(`  ${id} ${status} ${skill} ${node.title}${deps}`);
  }
  console.log();
}

function printEvent(event: PlannerEvent): void {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const prefix = chalk.dim(`[${time}]`);
  const taskStr = event.taskId ? chalk.dim(` (${event.taskId})`) : "";

  const typeColors: Record<string, (s: string) => string> = {
    plan_created: chalk.blue,
    plan_approved: chalk.green,
    task_started: chalk.cyan,
    task_complete: chalk.green,
    task_failed: chalk.red,
    task_reassigned: chalk.yellow,
    testing_started: chalk.magenta,
    testing_complete: chalk.green,
    testing_failed: chalk.red,
    plan_complete: chalk.green.bold,
    plan_failed: chalk.red.bold,
    agent_stuck: chalk.yellow,
    agent_unstuck: chalk.green,
    deadlock_detected: chalk.red,
  };

  const colorFn = typeColors[event.type] ?? chalk.white;
  console.log(`${prefix} ${colorFn(event.type)}${taskStr} ${event.detail}`);
}

export function registerPlan(program: Command): void {
  const plan = program
    .command("plan")
    .description("Plan and execute features with multi-agent orchestration");

  // ao plan <project> <description>
  plan
    .command("create <project> <description>")
    .description("Decompose a feature into tasks, classify skills, and create an execution plan")
    .option("--auto-approve", "Skip approval and start executing immediately")
    .option("--max-concurrency <n>", "Max parallel agents", "5")
    .option("--model <model>", "Planning model", DEFAULT_PLANNER_CONFIG.planningModel)
    .action(async (projectId: string, description: string, opts: {
      autoApprove?: boolean;
      maxConcurrency?: string;
      model?: string;
    }) => {
      banner("Plan Feature");
      const config = loadConfig();

      if (!config.projects[projectId]) {
        console.error(chalk.red(`Project "${projectId}" not found in config`));
        process.exit(1);
      }

      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
      const messageBus = createMessageBus(redisUrl);
      const fileLocks = createFileLockRegistry(redisUrl);
      const taskStore = createTaskStore(redisUrl);
      const sm = await getSessionManager(config);

      const planner = createPlanner(
        {
          messageBus,
          fileLocks,
          taskStore,
          spawnSession: async (params) => {
            const session = await sm.spawn({
              projectId: params.projectId,
              prompt: params.prompt,
              branch: params.branch,
              runtime: "docker",
              runtimeConfig: { image: params.dockerImage },
              environment: {
                ...params.environment,
                AO_SKILL: params.skill,
                AO_MODEL: params.model,
              },
            });
            return session.id;
          },
          killSession: async (sessionId) => {
            await sm.kill(sessionId);
          },
        },
        {
          planningModel: opts.model,
          maxConcurrency: parseInt(opts.maxConcurrency ?? "5", 10),
          requireApproval: !opts.autoApprove,
        },
      );

      planner.onEvent(printEvent);

      const spinner = ora("Decomposing feature and classifying tasks...").start();

      try {
        const result = await planner.planFeature(projectId, description);
        spinner.succeed("Plan created");
        printPlan(result);

        if (result.phase === "review") {
          console.log(
            chalk.yellow("  Plan requires approval. Run:"),
          );
          console.log(
            chalk.bold(`  ao plan approve ${result.id}`),
          );
        } else {
          console.log(chalk.green("  Agents are being spawned..."));
        }
      } catch (err) {
        spinner.fail("Planning failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      } finally {
        await messageBus.disconnect();
        await fileLocks.disconnect();
        await taskStore.disconnect();
      }
    });

  // ao plan approve <plan-id>
  plan
    .command("approve <project> <plan-id>")
    .description("Approve a plan and start spawning agents")
    .action(async (projectId: string, planId: string) => {
      banner("Approve Plan");

      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
      const messageBus = createMessageBus(redisUrl);
      const fileLocks = createFileLockRegistry(redisUrl);
      const taskStore = createTaskStore(redisUrl);
      const config = loadConfig();

      if (!config.projects[projectId]) {
        console.error(chalk.red(`Project "${projectId}" not found in config`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);

      const planner = createPlanner(
        {
          messageBus,
          fileLocks,
          taskStore,
          spawnSession: async (params) => {
            const session = await sm.spawn({
              projectId: params.projectId,
              prompt: params.prompt,
              branch: params.branch,
              runtime: "docker",
              runtimeConfig: { image: params.dockerImage },
              environment: {
                ...params.environment,
                AO_SKILL: params.skill,
                AO_MODEL: params.model,
              },
            });
            return session.id;
          },
          killSession: async (sessionId) => {
            await sm.kill(sessionId);
          },
        },
      );

      planner.onEvent(printEvent);

      try {
        // Load the plan from Redis into the planner's in-memory state
        await planner.loadPlan(planId, projectId);
        await planner.approvePlan(planId);
        console.log(chalk.green(`\n  Plan ${planId} approved — agents spawning\n`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      } finally {
        await messageBus.disconnect();
        await fileLocks.disconnect();
        await taskStore.disconnect();
      }
    });

  // ao plan status [plan-id]
  plan
    .command("status [plan-id]")
    .description("Show plan status (all plans if no ID given)")
    .action(async (planId?: string) => {
      banner("Plan Status");

      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
      const taskStore = createTaskStore(redisUrl);

      try {
        if (planId) {
          const graph = await taskStore.getGraph(planId);
          if (!graph) {
            console.error(chalk.red(`Plan "${planId}" not found`));
            process.exit(1);
          }

          console.log();
          console.log(`  Plan:    ${chalk.bold(graph.id)}`);
          console.log(`  Feature: ${graph.title}`);
          console.log(`  Tasks:   ${graph.nodes.length}`);
          console.log();

          const complete = graph.nodes.filter((n) => n.status === "complete").length;
          const inProgress = graph.nodes.filter((n) => n.status === "in_progress").length;
          const pending = graph.nodes.filter((n) => n.status === "pending").length;
          const failed = graph.nodes.filter((n) => n.status === "failed").length;

          console.log(`  ${chalk.green("●")} Complete:    ${complete}`);
          console.log(`  ${chalk.cyan("●")} In Progress: ${inProgress}`);
          console.log(`  ${chalk.dim("●")} Pending:     ${pending}`);
          if (failed > 0) {
            console.log(`  ${chalk.red("●")} Failed:      ${failed}`);
          }
          console.log();

          // Task table
          console.log(
            `  ${chalk.dim("ID".padEnd(8))} ${chalk.dim("Status".padEnd(14))} ${chalk.dim("Skill".padEnd(12))} ${chalk.dim("Assigned To".padEnd(16))} ${chalk.dim("Title")}`,
          );
          console.log(chalk.dim("  " + "─".repeat(70)));

          for (const node of graph.nodes) {
            const id = node.id.padEnd(8);
            const status = formatTaskStatus(node.status);
            const skill = (node.skill ?? "—").padEnd(12);
            const assigned = (node.assignedTo ?? "—").padEnd(16);

            console.log(`  ${id} ${status.padEnd(24)} ${skill} ${assigned} ${node.title}`);
          }
        } else {
          // List all plans
          const graphs = await taskStore.listGraphs();
          if (graphs.length === 0) {
            console.log(chalk.dim("\n  No active plans\n"));
            return;
          }

          for (const graph of graphs) {
            const complete = graph.nodes.filter((n) => n.status === "complete").length;
            const total = graph.nodes.length;
            const pct = total > 0 ? Math.round((complete / total) * 100) : 0;

            console.log(
              `  ${chalk.bold(graph.id)} ${chalk.dim("—")} ${graph.title} ${chalk.dim(`[${complete}/${total} ${pct}%]`)}`,
            );
          }
        }
        console.log();
      } finally {
        await taskStore.disconnect();
      }
    });

  // ao plan locks
  plan
    .command("locks")
    .description("Show active file locks across all plans")
    .action(async () => {
      banner("File Locks");

      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
      const fileLocks = createFileLockRegistry(redisUrl);

      try {
        const locks = await fileLocks.listAll();

        if (locks.length === 0) {
          console.log(chalk.dim("\n  No active file locks\n"));
          return;
        }

        console.log();
        console.log(
          `  ${chalk.dim("File".padEnd(40))} ${chalk.dim("Owner".padEnd(16))} ${chalk.dim("Age")}`,
        );
        console.log(chalk.dim("  " + "─".repeat(65)));

        for (const lock of locks) {
          const age = Math.round((Date.now() - lock.acquiredAt) / 1000);
          const ageStr = age > 60 ? `${Math.round(age / 60)}m` : `${age}s`;
          console.log(
            `  ${lock.filePath.padEnd(40)} ${lock.owner.padEnd(16)} ${ageStr}`,
          );
        }

        // Check for deadlocks
        const deadlocks = await fileLocks.detectDeadlocks();
        if (deadlocks.length > 0) {
          console.log();
          console.log(chalk.red.bold("  ⚠ Deadlocks detected:"));
          for (const cycle of deadlocks) {
            console.log(chalk.red(`    ${cycle.join(" → ")} → ${cycle[0]}`));
          }
        }

        console.log();
      } finally {
        await fileLocks.disconnect();
      }
    });

  // ao plan watch <project> <plan-id>
  plan
    .command("watch <project> <plan-id>")
    .description("Long-running process: subscribe to agent messages, trigger tests, stream events")
    .option("--no-test", "Skip per-task test agents")
    .option("--follow", "Follow real-time output from all agents")
    .action(async (projectId: string, planId: string, opts: { test: boolean; follow?: boolean }) => {
      banner("Plan Watch");

      const config = loadConfig();
      if (!config.projects[projectId]) {
        console.error(chalk.red(`Project "${projectId}" not found in config`));
        process.exit(1);
      }

      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
      const messageBus = createMessageBus(redisUrl);
      const fileLocks = createFileLockRegistry(redisUrl);
      const taskStore = createTaskStore(redisUrl);
      const sm = await getSessionManager(config);

      const spawnSession = async (params: Parameters<typeof sm.spawn>[0] extends infer T ? {
        projectId: string; taskId: string; prompt: string; branch: string;
        model: string; skill: string; dockerImage: string;
        environment: Record<string, string>;
      } : never) => {
        const session = await sm.spawn({
          projectId: params.projectId,
          prompt: params.prompt,
          branch: params.branch,
          runtime: "docker",
          runtimeConfig: { image: params.dockerImage },
          environment: {
            ...params.environment,
            AO_SKILL: params.skill,
            AO_MODEL: params.model,
          },
        });
        return session.id;
      };

      const planner = createPlanner(
        {
          messageBus,
          fileLocks,
          taskStore,
          spawnSession,
          killSession: async (sessionId) => { await sm.kill(sessionId); },
        },
      );

      // Load the plan from Redis
      const planData = await planner.loadPlan(planId, projectId);

      // Set up test trigger
      const testTrigger = opts.test
        ? createTestTrigger({ spawnSession }, DEFAULT_PLANNER_CONFIG)
        : null;

      // Track which sessions we're following output from
      const followedSessions = new Set<string>();

      planner.onEvent(async (event) => {
        printEvent(event);

        // Follow output from newly spawned agents
        if (opts.follow && event.sessionId) {
          if (event.type === "task_started" && !followedSessions.has(event.sessionId)) {
            followedSessions.add(event.sessionId);
            const sid = event.sessionId;
            await messageBus.subscribeOutput(sid, (data) => {
              const time = new Date(data.timestamp).toLocaleTimeString();
              console.log(chalk.dim(`[${time}] ${sid.slice(-8)}`) + ` ${data.line}`);
            });
          }

          // Unsubscribe when task completes/fails
          if ((event.type === "task_complete" || event.type === "task_failed") && event.sessionId) {
            if (followedSessions.has(event.sessionId)) {
              followedSessions.delete(event.sessionId);
              await messageBus.unsubscribeOutput(event.sessionId);
            }
          }
        }

        // Trigger per-task test on completion
        if (event.type === "task_complete" && event.taskId && testTrigger) {
          const node = planData.taskGraph.nodes.find((n) => n.id === event.taskId);
          if (node && node.result) {
            try {
              const testSessionId = await testTrigger.triggerTaskTest({
                planId,
                projectId,
                taskId: event.taskId,
                taskTitle: node.title,
                skill: node.skill,
                branch: node.result.branch,
                commits: node.result.commits,
                summary: node.result.summary,
                fileBoundary: node.fileBoundary,
                acceptanceCriteria: node.acceptanceCriteria,
              });
              console.log(chalk.magenta(`  [test] Spawned test agent ${testSessionId} for task ${event.taskId}`));
            } catch (err) {
              console.error(chalk.yellow(`  [test] Failed to spawn test agent: ${err instanceof Error ? err.message : err}`));
            }
          }
        }

        // Exit when plan completes or fails
        if (event.type === "plan_complete" || event.type === "plan_failed") {
          console.log();
          if (event.type === "plan_complete") {
            console.log(chalk.green.bold("  Plan complete!"));
          } else {
            console.log(chalk.red.bold("  Plan failed."));
          }
          cleanup();
        }
      });

      // Subscribe to orchestrator inbox
      console.log(chalk.dim(`  Watching plan ${planId}...`));
      console.log(chalk.dim(`  Press Ctrl+C to stop\n`));

      await messageBus.subscribe("orchestrator", async (message) => {
        await planner.handleMessage(message);
      });

      // Graceful shutdown
      let shuttingDown = false;
      async function cleanup() {
        if (shuttingDown) return;
        shuttingDown = true;

        // Unsubscribe from all output streams
        for (const sid of followedSessions) {
          await messageBus.unsubscribeOutput(sid).catch(() => {});
        }

        await messageBus.disconnect();
        await fileLocks.disconnect();
        await taskStore.disconnect();
        process.exit(0);
      }

      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    });

  // ao plan logs <session-id>
  plan
    .command("logs <session-id>")
    .description("Stream real-time output from an agent session")
    .action(async (sessionId: string) => {
      banner("Agent Logs");

      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
      const messageBus = createMessageBus(redisUrl);

      console.log(chalk.dim(`  Streaming output from ${sessionId}...`));
      console.log(chalk.dim(`  Press Ctrl+C to stop\n`));

      await messageBus.subscribeOutput(sessionId, (data) => {
        const time = new Date(data.timestamp).toLocaleTimeString();
        console.log(chalk.dim(`[${time}]`) + ` ${data.line}`);
      });

      async function cleanup() {
        await messageBus.unsubscribeOutput(sessionId);
        await messageBus.disconnect();
        process.exit(0);
      }

      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    });
}
