import type { WorkflowEngine } from "@composio/ao-workflow-engine";

let engineInstance: WorkflowEngine | null = null;

export function setEngine(engine: WorkflowEngine): void {
  engineInstance = engine;
}

function getEngine(): WorkflowEngine {
  if (!engineInstance) throw new Error("WorkflowEngine not initialized");
  return engineInstance;
}

/** Returns true if the workflow engine is initialized and active. */
export function isEngineActive(): boolean {
  return engineInstance !== null;
}

export async function createPlan(params: {
  planId: string;
  projectId: string;
  featureDescription: string;
  workflowId: string;
  workflowVersionId: string;
  workflowSnapshot: unknown[];
}): Promise<void> {
  await getEngine().createPlan(params as any);
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
