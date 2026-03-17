import type { AgentSkill } from "./types.js";
import { modelTierToId } from "./skill-classifier.js";
import type { PlannerConfig } from "./types.js";

// ============================================================================
// PER-TASK TEST TRIGGER
//
// Spawns a testing agent after each implementation task completes.
// Unlike the integration test (which runs after ALL tasks), this validates
// a single task's changes on its own branch before proceeding.
// ============================================================================

export interface TestTriggerDeps {
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
}

export interface TaskCompletionInfo {
  planId: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
  skill: string;
  branch: string;
  commits: string[];
  summary: string;
  fileBoundary: string[];
  acceptanceCriteria: string[];
}

export interface TestTrigger {
  /** Spawn a test agent for a completed task */
  triggerTaskTest(info: TaskCompletionInfo): Promise<string>;
}

export function createTestTrigger(
  deps: TestTriggerDeps,
  config: PlannerConfig,
): TestTrigger {
  function buildTestPrompt(info: TaskCompletionInfo): string {
    const lines = [
      `# Task Verification Test`,
      "",
      `## Task: ${info.taskTitle}`,
      `## Branch: ${info.branch}`,
      `## Skill: ${info.skill}`,
      "",
      `## What was implemented`,
      info.summary,
      "",
    ];

    if (info.commits.length > 0) {
      lines.push(`## Commits to verify`);
      for (const sha of info.commits) {
        lines.push(`- ${sha}`);
      }
      lines.push("");
    }

    if (info.fileBoundary.length > 0) {
      lines.push(`## Files that should have been modified`);
      for (const f of info.fileBoundary) {
        lines.push(`- ${f}`);
      }
      lines.push("");
    }

    if (info.acceptanceCriteria.length > 0) {
      lines.push(`## Acceptance Criteria to verify`);
      for (const c of info.acceptanceCriteria) {
        lines.push(`- [ ] ${c}`);
      }
      lines.push("");
    }

    lines.push(
      `## Instructions`,
      `1. Checkout the branch: ${info.branch}`,
      `2. Review the commits and verify they match the task description`,
      `3. Run the existing test suite — ensure nothing is broken`,
      `4. If the task added new functionality, verify it has tests`,
      `5. If tests are missing, write them`,
      `6. Run linting and type checking`,
      `7. Report results:`,
      `   - If all checks pass, exit with code 0`,
      `   - If checks fail, fix what you can and report remaining issues`,
    );

    return lines.join("\n");
  }

  return {
    async triggerTaskTest(info: TaskCompletionInfo): Promise<string> {
      const testTaskId = `${info.taskId}-test`;
      const prompt = buildTestPrompt(info);

      return deps.spawnSession({
        projectId: info.projectId,
        taskId: testTaskId,
        prompt,
        branch: info.branch,
        model: modelTierToId(config.modelPolicy.testing),
        skill: "testing",
        dockerImage: config.imageMap.testing,
        environment: {
          AO_PLAN_ID: info.planId,
          AO_TASK_ID: testTaskId,
          AO_MODEL: modelTierToId(config.modelPolicy.testing),
          AO_SKILL: "testing",
          AO_TRIGGER: "task-complete",
          AO_PARENT_TASK: info.taskId,
        },
      });
    },
  };
}
