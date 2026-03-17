import { createAnthropicClient } from "@composio/ao-core";
import { randomUUID } from "node:crypto";
import {
  decompose,
  getLeaves,
  type DecompositionPlan,
  type TaskNode as DecomposerTaskNode,
} from "@composio/ao-core/decomposer";
import type {
  MessageBus,
  BusMessage,
  FileLockRegistry,
  TaskStore,
  TaskGraph,
  TaskNode as BusTaskNode,
} from "@composio/ao-message-bus";
import { classifyTask, resolveModel, modelTierToId } from "./skill-classifier.js";
import { createTestTrigger } from "./test-trigger.js";
import type {
  PlannerConfig,
  TaskAssignment,
  ExecutionPlan,
  PlanPhase,
  PlannerEvent,
  PlannerEventHandler,
  AgentSkill,
} from "./types.js";
import { DEFAULT_PLANNER_CONFIG } from "./types.js";

// ============================================================================
// PLANNER SERVICE
// ============================================================================

export interface PlannerDeps {
  messageBus: MessageBus;
  fileLocks: FileLockRegistry;
  taskStore: TaskStore;
  /** Callback to actually spawn an agent session — wired to SessionManager.spawn() */
  spawnSession: (params: {
    projectId: string;
    taskId: string;
    prompt: string;
    branch: string;
    model: string;
    skill: AgentSkill;
    dockerImage: string;
    environment: Record<string, string>;
  }) => Promise<string>;
  /** Callback to kill a session */
  killSession: (sessionId: string) => Promise<void>;
}

export interface Planner {
  /** Plan and optionally execute a feature */
  planFeature(projectId: string, featureDescription: string): Promise<ExecutionPlan>;

  /** Approve a plan (if requireApproval is true) and start execution */
  approvePlan(planId: string): Promise<void>;

  /** Handle an incoming message from the bus (agent reports) */
  handleMessage(message: BusMessage): Promise<void>;

  /** Run the monitor loop (call periodically or on a timer) */
  monitor(): Promise<void>;

  /** Register an event handler for dashboard/logging */
  onEvent(handler: PlannerEventHandler): void;

  /** Load a plan from the task store into memory (for approve across process restarts) */
  loadPlan(planId: string, projectId: string): Promise<ExecutionPlan>;

  /** Get current state of a plan */
  getPlan(planId: string): ExecutionPlan | undefined;

  /** List all active plans */
  listPlans(): ExecutionPlan[];

  /** Cancel a plan — kills all active agents, releases locks, marks cancelled */
  cancelPlan(planId: string): Promise<{ killed: string[] }>;

  /** Shutdown */
  shutdown(): Promise<void>;
}

export function createPlanner(
  deps: PlannerDeps,
  config: Partial<PlannerConfig> = {},
): Planner {
  const cfg: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, ...config };
  const client = createAnthropicClient();
  const plans = new Map<string, ExecutionPlan>();
  const eventHandlers: PlannerEventHandler[] = [];

  // Per-task test trigger — spawns a testing agent after each implementation task
  const testTrigger = cfg.perTaskTesting
    ? createTestTrigger({ spawnSession: deps.spawnSession }, cfg)
    : null;

  // Track last activity per session for stuck detection
  const sessionActivity = new Map<string, number>();
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes no output change

  function emit(event: Omit<PlannerEvent, "timestamp">): void {
    const full: PlannerEvent = { ...event, timestamp: Date.now() };
    for (const handler of eventHandlers) {
      try {
        handler(full);
      } catch {
        // Don't let handler errors crash the planner
      }
    }
  }

  /** Convert decomposer tree leaves into a bus TaskGraph */
  async function buildTaskGraph(
    planId: string,
    featureId: string,
    featureTitle: string,
    leaves: DecomposerTaskNode[],
    projectContext?: string,
  ): Promise<{ graph: TaskGraph; assignments: Map<string, TaskAssignment> }> {
    const assignments = new Map<string, TaskAssignment>();

    // Classify all leaves in parallel
    const classifications = await Promise.all(
      leaves.map((leaf) =>
        classifyTask(client, cfg.planningModel, leaf.description, projectContext),
      ),
    );

    // Build dependency graph based on file boundary overlap
    // Tasks that touch the same files must run in series
    const filesToTask = new Map<string, string[]>();
    const taskDeps = new Map<string, string[]>();

    const nodes: BusTaskNode[] = leaves.map((leaf, i) => {
      const cls = classifications[i];
      const modelTier = resolveModel(cls.skill, cls.complexity, cfg.modelPolicy);
      const taskId = leaf.id;

      const assignment: TaskAssignment = {
        taskId,
        skill: cls.skill,
        model: modelTier,
        dockerImage: cfg.imageMap[cls.skill],
        fileBoundary: cls.fileBoundary,
        estimatedComplexity: cls.complexity,
      };
      assignments.set(taskId, assignment);

      // Track file ownership for dependency calculation
      for (const file of cls.fileBoundary) {
        if (!filesToTask.has(file)) filesToTask.set(file, []);
        filesToTask.get(file)!.push(taskId);
      }

      taskDeps.set(taskId, []);

      return {
        id: taskId,
        title: leaf.description.slice(0, 80),
        description: leaf.description,
        acceptanceCriteria: [],
        fileBoundary: cls.fileBoundary,
        status: "pending" as const,
        assignedTo: null,
        model: modelTierToId(modelTier),
        skill: cls.skill,
        dependsOn: [], // filled below
        branch: null,
        result: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });

    // Calculate dependencies: if two tasks share a file, the later one depends on the earlier
    for (const [, taskIds] of filesToTask) {
      if (taskIds.length <= 1) continue;
      for (let i = 1; i < taskIds.length; i++) {
        const deps = taskDeps.get(taskIds[i])!;
        if (!deps.includes(taskIds[i - 1])) {
          deps.push(taskIds[i - 1]);
        }
      }
    }

    // Apply dependencies to nodes
    for (const node of nodes) {
      node.dependsOn = taskDeps.get(node.id) ?? [];
    }

    const graph: TaskGraph = {
      id: planId,
      featureId,
      title: featureTitle,
      nodes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    return { graph, assignments };
  }

  /** Spawn agents for all ready tasks, up to concurrency limit */
  async function spawnReadyTasks(plan: ExecutionPlan): Promise<void> {
    const ready = await deps.taskStore.getReadyTasks(plan.taskGraph.id);
    const activeCount = plan.activeSessions.size;
    const budget = cfg.maxConcurrency - activeCount;

    if (budget <= 0 || ready.length === 0) return;

    const toSpawn = ready.slice(0, budget);

    for (const task of toSpawn) {
      const assignment = plan.assignments.get(task.id);
      if (!assignment) continue;

      // Acquire file locks
      let allLocked = true;
      for (const file of assignment.fileBoundary) {
        const acquired = await deps.fileLocks.acquire(file, task.id);
        if (!acquired) {
          allLocked = false;
          break;
        }
      }

      if (!allLocked) {
        // Can't get locks — skip this task for now, will retry on next monitor cycle
        // Release any locks we did acquire
        await deps.fileLocks.releaseAll(task.id);
        continue;
      }

      const branch = `feat/${plan.id}/${task.id.replace(/\./g, "-")}`;
      const modelId = modelTierToId(assignment.model);

      try {
        const sessionId = await deps.spawnSession({
          projectId: plan.projectId,
          taskId: task.id,
          prompt: buildAgentPrompt(task, assignment, plan),
          branch,
          model: modelId,
          skill: assignment.skill,
          dockerImage: assignment.dockerImage,
          environment: {
            AO_PLAN_ID: plan.id,
            AO_TASK_ID: task.id,
            AO_MODEL: modelId,
            AO_SKILL: assignment.skill,
          },
        });

        plan.activeSessions.set(task.id, sessionId);
        sessionActivity.set(sessionId, Date.now());

        await deps.taskStore.updateTask(plan.taskGraph.id, task.id, {
          status: "in_progress",
          assignedTo: sessionId,
          branch,
        });

        emit({
          type: "task_started",
          planId: plan.id,
          taskId: task.id,
          sessionId,
          detail: `Spawned ${assignment.skill} agent (${assignment.model}) for: ${task.title}`,
        });
      } catch (err) {
        await deps.fileLocks.releaseAll(task.id);
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "task_failed",
          planId: plan.id,
          taskId: task.id,
          detail: `Failed to spawn agent: ${msg}`,
        });
      }
    }
  }

  function buildAgentPrompt(
    task: BusTaskNode,
    assignment: TaskAssignment,
    plan: ExecutionPlan,
  ): string {
    const lines = [
      `# Task: ${task.title}`,
      "",
      task.description,
      "",
      "## File Boundary",
      "You should primarily work within these files/patterns:",
      ...assignment.fileBoundary.map((f) => `- ${f}`),
      "",
      "## Rules",
      "- Only modify files within your assigned boundary unless absolutely necessary",
      "- If you need to modify a file outside your boundary, explain why in your commit message",
      "- Write tests for any new functionality you add",
      "- Before finishing, run the tests relevant to your changes and fix any failures",
      "- Run linting and type checking on the files you modified",
      "- Do NOT run the full project test suite — only tests related to your changes",
      "- Use conventional commits (feat:, fix:, test:, etc.)",
      "- Commit early and often — each commit should be a logical unit",
      "- Push your branch and create a PR when done",
      "",
      `## Context`,
      `This is part of a larger feature: ${plan.featureDescription}`,
      `Your branch: feat/${plan.id}/${task.id.replace(/\./g, "-")}`,
    ];

    if (task.acceptanceCriteria.length > 0) {
      lines.push("", "## Acceptance Criteria");
      for (const criterion of task.acceptanceCriteria) {
        lines.push(`- [ ] ${criterion}`);
      }
    }

    return lines.join("\n");
  }

  /** Spawn a testing agent that merges all completed branches and runs tests */
  async function spawnTestingAgent(plan: ExecutionPlan): Promise<void> {
    plan.phase = "testing";
    plan.updatedAt = Date.now();

    const completedTasks = plan.taskGraph.nodes.filter((n) => n.status === "complete");
    const branches = completedTasks
      .map((t) => t.branch)
      .filter((b): b is string => b !== null);

    const testPrompt = [
      `# Integration Testing`,
      "",
      `## Feature: ${plan.featureDescription}`,
      "",
      `## Completed branches to merge and test:`,
      ...branches.map((b) => `- ${b}`),
      "",
      `## Instructions`,
      `1. Create a new integration branch from the default branch`,
      `2. Merge each of the above branches (resolve conflicts if any)`,
      `3. Run the full test suite`,
      `4. If tests pass, report success`,
      `5. If tests fail, report which tests failed and why`,
      `6. Write additional integration tests if the existing suite doesn't cover the new feature`,
    ].join("\n");

    try {
      const sessionId = await deps.spawnSession({
        projectId: plan.projectId,
        taskId: `${plan.id}-test`,
        prompt: testPrompt,
        branch: `test/${plan.id}/integration`,
        model: modelTierToId(cfg.modelPolicy.testing),
        skill: "testing",
        dockerImage: cfg.imageMap.testing,
        environment: {
          AO_PLAN_ID: plan.id,
          AO_TASK_ID: "integration-test",
          AO_MODEL: modelTierToId(cfg.modelPolicy.testing),
          AO_SKILL: "testing",
        },
      });

      plan.activeSessions.set("integration-test", sessionId);
      sessionActivity.set(sessionId, Date.now());

      emit({
        type: "testing_started",
        planId: plan.id,
        sessionId,
        detail: `Spawned testing agent to verify ${branches.length} branches`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({
        type: "testing_failed",
        planId: plan.id,
        detail: `Failed to spawn testing agent: ${msg}`,
      });
      plan.phase = "failed";
    }
  }

  /** Either spawn integration test or complete the plan directly */
  async function finalizePlan(plan: ExecutionPlan): Promise<void> {
    if (cfg.skipIntegrationTest) {
      plan.phase = "complete";
      plan.updatedAt = Date.now();
      emit({
        type: "plan_complete",
        planId: plan.id,
        detail: "All tasks complete (integration test skipped)",
      });
    } else {
      await spawnTestingAgent(plan);
    }
  }

  return {
    async planFeature(
      projectId: string,
      featureDescription: string,
    ): Promise<ExecutionPlan> {
      const planId = `plan-${randomUUID().slice(0, 8)}`;

      emit({
        type: "plan_created",
        planId,
        detail: `Decomposing feature: ${featureDescription}`,
      });

      // Use existing decomposer to break into atomic tasks
      const decomposition = await decompose(featureDescription, {
        enabled: true,
        maxDepth: cfg.maxDepth,
        model: cfg.planningModel,
        requireApproval: false,
      });

      const leaves = getLeaves(decomposition.tree);

      // Classify each leaf and build the task graph
      const { graph, assignments } = await buildTaskGraph(
        planId,
        planId,
        featureDescription.slice(0, 100),
        leaves,
      );

      // Persist to Redis
      await deps.taskStore.createGraph(graph);

      const plan: ExecutionPlan = {
        id: planId,
        projectId,
        featureDescription,
        phase: cfg.requireApproval ? "review" : "executing",
        taskGraph: graph,
        assignments,
        activeSessions: new Map(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      plans.set(planId, plan);

      emit({
        type: "plan_created",
        planId,
        detail: `Plan created with ${leaves.length} tasks (${assignments.size} classified)`,
      });

      // If no approval needed, start immediately
      if (!cfg.requireApproval) {
        await spawnReadyTasks(plan);
      }

      return plan;
    },

    async loadPlan(planId: string, projectId: string): Promise<ExecutionPlan> {
      const graph = await deps.taskStore.getGraph(planId);
      if (!graph) throw new Error(`Plan ${planId} not found in task store`);

      // Reconstruct assignments from task nodes
      const assignments = new Map<string, TaskAssignment>();
      for (const node of graph.nodes) {
        const skill = (node.skill as AgentSkill) || "fullstack";
        assignments.set(node.id, {
          taskId: node.id,
          skill,
          estimatedComplexity: "medium",
          model: resolveModel(skill, "medium", cfg.modelPolicy),
          dockerImage: cfg.imageMap[skill] ?? cfg.imageMap.fullstack,
          fileBoundary: node.fileBoundary,
        });
      }

      // Infer phase from task statuses
      const hasInProgress = graph.nodes.some((n) =>
        n.status === "in_progress" || n.status === "assigned" || n.status === "testing",
      );
      const allComplete = graph.nodes.every((n) => n.status === "complete");
      const hasFailed = graph.nodes.some((n) => n.status === "failed");
      let phase: PlanPhase;
      if (allComplete) phase = "complete";
      else if (hasFailed) phase = "failed";
      else if (hasInProgress || graph.nodes.some((n) => n.assignedTo !== null)) phase = "executing";
      else phase = "review";

      const plan: ExecutionPlan = {
        id: planId,
        projectId,
        featureDescription: graph.title,
        phase,
        taskGraph: graph,
        assignments,
        activeSessions: new Map(),
        createdAt: graph.createdAt,
        updatedAt: graph.updatedAt,
      };

      plans.set(planId, plan);
      return plan;
    },

    async approvePlan(planId: string): Promise<void> {
      const plan = plans.get(planId);
      if (!plan) throw new Error(`Plan ${planId} not found`);
      if (plan.phase !== "review") throw new Error(`Plan ${planId} is in phase ${plan.phase}, not review`);

      plan.phase = "executing";
      plan.updatedAt = Date.now();

      emit({
        type: "plan_approved",
        planId,
        detail: "Plan approved — spawning agents",
      });

      await spawnReadyTasks(plan);
    },

    async handleMessage(message: BusMessage): Promise<void> {
      // Find which plan this message relates to
      const planId = message.payload.planId as string | undefined;
      if (!planId) return;

      const plan = plans.get(planId);
      if (!plan) return;

      const taskId = message.payload.taskId as string | undefined;

      switch (message.type) {
        case "TASK_COMPLETE": {
          if (!taskId) break;

          // Release file locks
          await deps.fileLocks.releaseAll(taskId);

          const isPerTaskTest = taskId.endsWith("-test") && taskId !== "integration-test";
          const isIntegrationTest = taskId === "integration-test";
          const parentTaskId = isPerTaskTest ? taskId.replace(/-test$/, "") : null;

          if (isIntegrationTest) {
            // ── Integration test passed → plan complete ──
            plan.activeSessions.delete(taskId);
            plan.updatedAt = Date.now();

            emit({
              type: "task_complete",
              planId,
              taskId,
              sessionId: message.from,
              detail: (message.payload.summary as string) ?? "Integration test passed",
            });
            emit({
              type: "plan_complete",
              planId,
              detail: "All tasks and integration tests passed",
            });
            plan.phase = "complete";

          } else if (isPerTaskTest && parentTaskId) {
            // ── Per-task test passed → mark parent task as complete ──
            plan.activeSessions.delete(taskId);
            plan.updatedAt = Date.now();

            const parentNode = plan.taskGraph.nodes.find((n) => n.id === parentTaskId);
            if (parentNode) {
              parentNode.status = "complete";
              await deps.taskStore.updateTask(plan.taskGraph.id, parentTaskId, {
                status: "complete",
              });
            }

            emit({
              type: "task_complete",
              planId,
              taskId,
              sessionId: message.from,
              detail: `Per-task test passed for ${parentTaskId}`,
            });

            // Check if all implementation tasks are now verified (complete)
            const allVerified = plan.taskGraph.nodes.every((n) => n.status === "complete");
            if (allVerified && plan.phase === "executing") {
              await finalizePlan(plan);
            } else {
              await spawnReadyTasks(plan);
            }

          } else {
            // ── Implementation task completed ──
            const result = {
              taskId,
              sessionId: message.from,
              status: "complete" as const,
              branch: (message.payload.branch as string) ?? "",
              commits: (message.payload.commits as string[]) ?? [],
              summary: (message.payload.summary as string) ?? "",
            };

            const node = plan.taskGraph.nodes.find((n) => n.id === taskId);

            if (testTrigger && node) {
              // Per-task testing enabled: mark as "testing", spawn test agent
              node.status = "testing";
              node.result = result;
              await deps.taskStore.updateTask(plan.taskGraph.id, taskId, {
                status: "testing",
                result,
              });

              plan.activeSessions.delete(taskId);
              plan.updatedAt = Date.now();

              emit({
                type: "task_complete",
                planId,
                taskId,
                sessionId: message.from,
                detail: (message.payload.summary as string) ?? "Task completed — spawning per-task test",
              });

              // Spawn per-task test agent
              try {
                const testSessionId = await testTrigger.triggerTaskTest({
                  planId,
                  projectId: plan.projectId,
                  taskId,
                  taskTitle: node.title,
                  skill: node.skill,
                  branch: result.branch,
                  commits: result.commits,
                  summary: result.summary,
                  fileBoundary: node.fileBoundary,
                  acceptanceCriteria: node.acceptanceCriteria,
                });

                plan.activeSessions.set(`${taskId}-test`, testSessionId);
                sessionActivity.set(testSessionId, Date.now());

                emit({
                  type: "testing_started",
                  planId,
                  taskId: `${taskId}-test`,
                  sessionId: testSessionId,
                  detail: `Spawned per-task test for ${taskId}`,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                emit({
                  type: "testing_failed",
                  planId,
                  taskId: `${taskId}-test`,
                  detail: `Failed to spawn per-task test: ${msg}`,
                });
                // Fall back: mark task as complete without testing
                node.status = "complete";
                await deps.taskStore.updateTask(plan.taskGraph.id, taskId, {
                  status: "complete",
                  result,
                });
              }
            } else {
              // No per-task testing: mark as complete directly
              if (node) node.status = "complete";
              await deps.taskStore.updateTask(plan.taskGraph.id, taskId, {
                status: "complete",
                result,
              });

              plan.activeSessions.delete(taskId);
              plan.updatedAt = Date.now();

              emit({
                type: "task_complete",
                planId,
                taskId,
                sessionId: message.from,
                detail: (message.payload.summary as string) ?? "Task completed",
              });

              // Check if all tasks are complete → integration test
              const allComplete = plan.taskGraph.nodes.every((n) => n.status === "complete");
              if (allComplete && plan.phase === "executing") {
                await finalizePlan(plan);
              } else {
                await spawnReadyTasks(plan);
              }
            }
          }
          break;
        }

        case "TASK_FAILED": {
          if (!taskId) break;

          await deps.fileLocks.releaseAll(taskId);

          const error = (message.payload.error as string) ?? "Unknown error";
          const isFailedPerTaskTest = taskId.endsWith("-test") && taskId !== "integration-test";
          const failedParentId = isFailedPerTaskTest ? taskId.replace(/-test$/, "") : null;

          plan.activeSessions.delete(taskId);
          plan.updatedAt = Date.now();

          // Integration test failure → plan failed
          if (taskId === "integration-test") {
            emit({
              type: "task_failed",
              planId,
              taskId,
              sessionId: message.from,
              detail: `Integration test failed: ${error}`,
            });
            emit({
              type: "plan_failed",
              planId,
              detail: `Integration test failed: ${error}`,
            });
            plan.phase = "failed";
            break;
          }

          // Per-task test failure → mark parent task as failed for reassignment
          if (isFailedPerTaskTest && failedParentId) {
            const parentNode = plan.taskGraph.nodes.find((n) => n.id === failedParentId);

            emit({
              type: "task_failed",
              planId,
              taskId,
              sessionId: message.from,
              detail: `Per-task test failed for ${failedParentId}: ${error}`,
            });

            if (parentNode) {
              parentNode.status = "pending";
              await deps.taskStore.updateTask(plan.taskGraph.id, failedParentId, {
                status: "pending",
                assignedTo: null,
              });
            }

            await spawnReadyTasks(plan);
            break;
          }

          // Regular task failure → reassign
          await deps.taskStore.updateTask(plan.taskGraph.id, taskId, {
            status: "failed",
          });

          const failedNode = plan.taskGraph.nodes.find((n) => n.id === taskId);
          if (failedNode) failedNode.status = "failed";

          emit({
            type: "task_failed",
            planId,
            taskId,
            sessionId: message.from,
            detail: `Task failed: ${error}`,
          });

          // Reassign: reset to pending so it gets picked up again
          await deps.taskStore.updateTask(plan.taskGraph.id, taskId, {
            status: "pending",
            assignedTo: null,
          });
          if (failedNode) failedNode.status = "pending";

          await spawnReadyTasks(plan);
          break;
        }

        case "STUCK": {
          if (!taskId) break;

          emit({
            type: "agent_stuck",
            planId,
            taskId,
            sessionId: message.from,
            detail: (message.payload.reason as string) ?? "Agent reported stuck",
          });

          // Kill the stuck session and reassign
          const stuckSessionId = plan.activeSessions.get(taskId);
          if (stuckSessionId) {
            await deps.killSession(stuckSessionId);
            plan.activeSessions.delete(taskId);
          }
          await deps.fileLocks.releaseAll(taskId);

          await deps.taskStore.updateTask(plan.taskGraph.id, taskId, {
            status: "pending",
            assignedTo: null,
          });
          const stuckNode = plan.taskGraph.nodes.find((n) => n.id === taskId);
          if (stuckNode) stuckNode.status = "pending";

          emit({
            type: "task_reassigned",
            planId,
            taskId,
            detail: "Reassigning stuck task to new agent",
          });

          await spawnReadyTasks(plan);
          break;
        }

        case "TEST_RESULT": {
          const passed = message.payload.passed as boolean;

          if (passed) {
            plan.phase = "complete";
            plan.updatedAt = Date.now();

            emit({
              type: "plan_complete",
              planId,
              detail: "All tests passed — feature complete",
            });
          } else {
            const failedTests = (message.payload.failedTests as string[]) ?? [];

            emit({
              type: "testing_failed",
              planId,
              detail: `Tests failed: ${failedTests.join(", ")}`,
            });

            // Identify which tasks need rework based on failed test output
            // For now, reassign all tasks as pending
            // TODO: smarter failure attribution based on test output
            for (const node of plan.taskGraph.nodes) {
              if (node.status === "complete") {
                node.status = "pending";
                await deps.taskStore.updateTask(plan.taskGraph.id, node.id, {
                  status: "pending",
                  assignedTo: null,
                });
              }
            }

            plan.phase = "executing";
            plan.activeSessions.clear();
            await spawnReadyTasks(plan);
          }
          break;
        }

        case "FILE_LOCK_REQUEST": {
          const filePath = message.payload.filePath as string;
          const owner = message.payload.owner as string;

          if (filePath && owner) {
            const granted = await deps.fileLocks.acquire(filePath, owner);
            await deps.messageBus.publish({
              type: "CONTEXT_UPDATE",
              from: "orchestrator",
              to: message.from,
              payload: {
                lockResult: { filePath, granted },
              },
            });
          }
          break;
        }

        default:
          break;
      }
    },

    async monitor(): Promise<void> {
      for (const [planId, plan] of plans) {
        if (plan.phase !== "executing" && plan.phase !== "testing") continue;

        // Check for deadlocks
        const deadlocks = await deps.fileLocks.detectDeadlocks();
        if (deadlocks.length > 0) {
          for (const cycle of deadlocks) {
            emit({
              type: "deadlock_detected",
              planId,
              detail: `Deadlock detected between: ${cycle.join(" → ")}`,
            });

            // Preempt the last task in the cycle
            const victim = cycle[cycle.length - 1];
            const sessionId = plan.activeSessions.get(victim);
            if (sessionId) {
              await deps.killSession(sessionId);
              plan.activeSessions.delete(victim);
            }
            await deps.fileLocks.releaseAll(victim);
            await deps.taskStore.updateTask(plan.taskGraph.id, victim, {
              status: "pending",
              assignedTo: null,
            });

            emit({
              type: "agent_unstuck",
              planId,
              taskId: victim,
              detail: "Preempted deadlocked task — will retry after dependency completes",
            });
          }
        }

        // Try to spawn any newly ready tasks
        await spawnReadyTasks(plan);

        // Check for completely stalled plans
        if (plan.activeSessions.size === 0 && plan.phase === "executing") {
          const hasWork = plan.taskGraph.nodes.some(
            (n) => n.status === "pending" || n.status === "in_progress",
          );
          if (!hasWork) {
            const allComplete = plan.taskGraph.nodes.every((n) => n.status === "complete");
            if (allComplete) {
              await finalizePlan(plan);
            }
          }
        }
      }
    },

    onEvent(handler: PlannerEventHandler): void {
      eventHandlers.push(handler);
    },

    getPlan(planId: string): ExecutionPlan | undefined {
      return plans.get(planId);
    },

    listPlans(): ExecutionPlan[] {
      return Array.from(plans.values());
    },

    async cancelPlan(planId: string): Promise<{ killed: string[] }> {
      const plan = plans.get(planId);
      if (!plan) throw new Error(`Plan ${planId} not found`);

      const killed: string[] = [];

      // Kill all active sessions
      for (const [taskId, sessionId] of plan.activeSessions) {
        try {
          await deps.killSession(sessionId);
          killed.push(sessionId);
        } catch {
          // Container may already be gone
        }
        await deps.fileLocks.releaseAll(taskId);

        // Mark in-progress tasks as cancelled
        const node = plan.taskGraph.nodes.find((n) => n.id === taskId);
        if (node && (node.status === "in_progress" || node.status === "assigned" || node.status === "testing")) {
          node.status = "failed";
          await deps.taskStore.updateTask(plan.taskGraph.id, taskId, {
            status: "failed",
          });
        }
      }

      plan.activeSessions.clear();
      plan.phase = "cancelled";
      plan.updatedAt = Date.now();

      emit({
        type: "plan_cancelled",
        planId,
        detail: `Plan cancelled — killed ${killed.length} agent(s)`,
      });

      return { killed };
    },

    async shutdown(): Promise<void> {
      // Kill all active sessions
      for (const plan of plans.values()) {
        for (const [taskId, sessionId] of plan.activeSessions) {
          await deps.killSession(sessionId);
          await deps.fileLocks.releaseAll(taskId);
        }
      }
      plans.clear();
    },
  };
}
