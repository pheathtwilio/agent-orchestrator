import type { TaskState, StepState } from "./types.js";

export function evaluateStepExit(
  tasks: Map<string, TaskState>,
  stepIndex: number,
  programmaticCriteria: string[],
): boolean {
  const stepTasks = getTasksForStep(tasks, stepIndex);
  if (stepTasks.length === 0) return true;

  for (const criterion of programmaticCriteria) {
    switch (criterion) {
      case "all_tasks_complete":
        if (!stepTasks.every((t) => t.status === "complete")) return false;
        break;
      case "any_task_complete":
        if (!stepTasks.some((t) => t.status === "complete")) return false;
        break;
    }
  }

  return true;
}

export function getTasksForStep(tasks: Map<string, TaskState>, stepIndex: number): TaskState[] {
  const result: TaskState[] = [];
  for (const [, task] of tasks) {
    if (task.stepIndex === stepIndex) result.push(task);
  }
  return result;
}

export function getReadyTasks(tasks: Map<string, TaskState>, stepIndex: number): TaskState[] {
  const completedIds = new Set<string>();
  for (const [, task] of tasks) {
    if (task.status === "complete") completedIds.add(task.id);
  }

  return getTasksForStep(tasks, stepIndex).filter(
    (task) =>
      task.status === "pending" &&
      task.dependsOn.every((dep) => completedIds.has(dep)),
  );
}

export function shouldSkipStep(step: StepState, _tasks: Map<string, TaskState>): boolean {
  if (!step.snapshot.is_conditional) return false;

  const condition = step.snapshot.condition as { type: string } | null;
  if (!condition) return false;

  switch (condition.type) {
    case "never":
      return true;
    case "always":
      return false;
    default:
      return false;
  }
}
