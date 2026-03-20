import type { TaskNode } from "@composio/ao-message-bus";

// ============================================================================
// STEP EXIT CRITERIA EVALUATOR
// ============================================================================

/**
 * Known programmatic conditions that can appear in a workflow step's
 * exit_criteria.programmatic array.  We accept plain strings so we
 * don't need a cross-package import of ProgrammaticCondition.
 */
const KNOWN_CONDITIONS = new Set([
  "all_tasks_complete",
  "tests_pass",
  "no_failures",
  "pr_created",
]);

/**
 * Evaluate ALL programmatic exit conditions (AND logic).
 *
 * Returns `true` only when every condition in `conditions` is satisfied
 * by the given set of tasks.  Unknown condition strings are ignored
 * (treated as satisfied) so that forward-compatible workflow definitions
 * don't block execution.
 */
export function checkExitCriteria(
  conditions: string[],
  tasks: TaskNode[],
): boolean {
  for (const condition of conditions) {
    if (!KNOWN_CONDITIONS.has(condition)) {
      // Unknown condition — skip rather than block.
      continue;
    }

    switch (condition) {
      case "all_tasks_complete": {
        if (!tasks.every((t) => t.status === "complete")) return false;
        break;
      }

      case "tests_pass": {
        // Every task that has a result must not contain test/fail errors.
        // If no tasks have results yet, vacuously true.
        const tasksWithResults = tasks.filter((t) => t.result !== null);
        if (tasksWithResults.length > 0) {
          const hasFailing = tasksWithResults.some((t) => {
            const error = t.result?.error;
            if (!error) return false;
            const lower = error.toLowerCase();
            return lower.includes("test") || lower.includes("fail");
          });
          if (hasFailing) return false;
        }
        break;
      }

      case "no_failures": {
        if (tasks.some((t) => t.status === "failed")) return false;
        break;
      }

      case "pr_created": {
        // Every complete task must have a result with a non-empty branch.
        const completeTasks = tasks.filter((t) => t.status === "complete");
        if (completeTasks.length === 0) return false;
        const allHaveBranch = completeTasks.every(
          (t) => t.result && t.result.branch && t.result.branch.length > 0,
        );
        if (!allHaveBranch) return false;
        break;
      }
    }
  }

  return true;
}
