import type { WorkflowEngine } from "@composio/ao-workflow-engine";

function getEngine(): WorkflowEngine {
  // Access engine from the globalThis-cached services singleton.
  // This avoids module-scope variable issues with Next.js HMR/webpack.
  const globalForServices = globalThis as typeof globalThis & {
    _aoServices?: { engine?: WorkflowEngine };
  };
  const engine = globalForServices._aoServices?.engine;
  if (!engine) throw new Error("WorkflowEngine not initialized");
  return engine;
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
  const globalForServices = globalThis as typeof globalThis & {
    _aoServices?: { engine?: WorkflowEngine };
  };
  const engine = globalForServices._aoServices?.engine;
  if (!engine) return undefined;
  return engine.getPlanState(planId);
}

export async function resumePlan(planId: string): Promise<{ resumed: string[] }> {
  return getEngine().resumePlan(planId);
}

export async function retryPlan(planId: string): Promise<void> {
  return getEngine().retryPlan(planId);
}
