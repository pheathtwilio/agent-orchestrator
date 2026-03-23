import { describe, it, expect } from "vitest";
import { evaluateStepExit, getTasksForStep, getReadyTasks, shouldSkipStep } from "../step-runner.js";
import type { TaskState, StepState } from "../types.js";

function makeTask(id: string, status: string, stepIndex: number, dependsOn: string[] = []): TaskState {
  return {
    id, status: status as any, containerId: null, branch: null,
    result: null, error: null, stepIndex, retryCount: 0,
    doctorTaskId: null, healingTaskId: null, taskType: "implementation",
    title: id, description: "", acceptanceCriteria: [], fileBoundary: [],
    dependsOn, model: "sonnet", skill: "fullstack", dockerImage: "ao-agent:latest",
  };
}

describe("evaluateStepExit", () => {
  it("returns true when all tasks for step are complete", () => {
    const tasks = new Map([
      ["1.1", makeTask("1.1", "complete", 1)],
      ["1.2", makeTask("1.2", "complete", 1)],
      ["2.1", makeTask("2.1", "pending", 2)],
    ]);
    expect(evaluateStepExit(tasks, 1, ["all_tasks_complete"])).toBe(true);
  });

  it("returns false when some tasks still running", () => {
    const tasks = new Map([
      ["1.1", makeTask("1.1", "complete", 1)],
      ["1.2", makeTask("1.2", "running", 1)],
    ]);
    expect(evaluateStepExit(tasks, 1, ["all_tasks_complete"])).toBe(false);
  });

  it("returns true for empty step", () => {
    const tasks = new Map<string, TaskState>();
    expect(evaluateStepExit(tasks, 5, ["all_tasks_complete"])).toBe(true);
  });

  it("supports any_task_complete criterion", () => {
    const tasks = new Map([
      ["1.1", makeTask("1.1", "complete", 1)],
      ["1.2", makeTask("1.2", "running", 1)],
    ]);
    expect(evaluateStepExit(tasks, 1, ["any_task_complete"])).toBe(true);
  });
});

describe("getTasksForStep", () => {
  it("returns only tasks matching the step index", () => {
    const tasks = new Map([
      ["1.1", makeTask("1.1", "pending", 0)],
      ["1.2", makeTask("1.2", "pending", 0)],
      ["2.1", makeTask("2.1", "pending", 1)],
    ]);
    const step0 = getTasksForStep(tasks, 0);
    expect(step0).toHaveLength(2);
    expect(step0.map((t) => t.id)).toEqual(["1.1", "1.2"]);
  });
});

describe("getReadyTasks", () => {
  it("returns pending tasks with satisfied deps", () => {
    const tasks = new Map([
      ["1.1", makeTask("1.1", "complete", 0)],
      ["2.1", makeTask("2.1", "pending", 1, ["1.1"])],
      ["2.2", makeTask("2.2", "pending", 1, ["1.1", "99"])], // dep 99 not met
    ]);
    const ready = getReadyTasks(tasks, 1);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("2.1");
  });
});

describe("shouldSkipStep", () => {
  it("returns false for non-conditional steps", () => {
    const step: StepState = {
      index: 1, name: "Implement", status: "pending",
      snapshot: { is_conditional: false, condition: null } as any,
    };
    expect(shouldSkipStep(step, new Map())).toBe(false);
  });

  it("returns true for never condition", () => {
    const step: StepState = {
      index: 1, name: "Test", status: "pending",
      snapshot: { is_conditional: true, condition: { type: "never" } } as any,
    };
    expect(shouldSkipStep(step, new Map())).toBe(true);
  });
});
