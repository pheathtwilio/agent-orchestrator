import type { WorkflowEngine } from "@composio/ao-workflow-engine";

let engineInstance: WorkflowEngine | null = null;

export function setEngine(engine: WorkflowEngine): void {
  engineInstance = engine;
}

function getEngine(): WorkflowEngine {
  if (!engineInstance) throw new Error("WorkflowEngine not initialized");
  return engineInstance;
}

export async function createPlan(params: Parameters<WorkflowEngine["createPlan"]>[0]): Promise<void> {
  await getEngine().createPlan(params);
}

export async function approvePlan(planId: string): Promise<void> {
  await getEngine().processEvent({ type: "PLAN_APPROVED", planId });
}

export async function cancelPlan(planId: string): Promise<void> {
  await getEngine().processEvent({ type: "PLAN_CANCELLED", planId });
}

export function getPlanState(planId: string) {
  return getEngine().getPlanState(planId);
}

export async function resumePlan(planId: string): Promise<{ resumed: string[] }> {
  return getEngine().resumePlan(planId);
}

export async function retryPlan(planId: string): Promise<void> {
  return getEngine().retryPlan(planId);
}
