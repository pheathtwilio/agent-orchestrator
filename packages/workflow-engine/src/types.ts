// Re-define WorkflowStepSnapshot locally to avoid circular dep on @composio/ao-planner.
// The planner package depends on this package, not the other way around.

// ============================================================================
// STATE TYPES
// ============================================================================

export type PlanPhase =
  | "created"
  | "planning"
  | "reviewing"
  | "executing"
  | "completing"
  | "complete"
  | "failed"
  | "cancelled";

export type EngineTaskStatus =
  | "pending"
  | "spawning"
  | "running"
  | "complete"
  | "failed"
  | "doctoring";

export type StepStatus = "pending" | "active" | "complete" | "failed" | "skipped";

export interface WorkflowStepSnapshot {
  name: string;
  description: string;
  sort_order: number;
  exit_criteria: {
    programmatic: string[];
    description: string;
  };
  failure_policy: {
    action: "spawn_doctor" | "retry" | "fail_plan" | "skip" | "notify";
    max_retries?: number;
    description: string;
  };
  agent_config: {
    skill: string;
    model_tier: string;
    docker_image?: string;
    per_task_testing?: boolean;
    mcp_services?: string[];
  };
  is_conditional: boolean;
  condition: unknown | null;
}

// ============================================================================
// STATE SHAPES
// ============================================================================

export interface TaskState {
  id: string;
  status: EngineTaskStatus;
  containerId: string | null;
  sessionId: string | null;
  branch: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  stepIndex: number;
  retryCount: number;
  doctorTaskId: string | null;
  healingTaskId: string | null;
  taskType: "implementation" | "planner" | "doctor" | "integration" | "verify";
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileBoundary: string[];
  dependsOn: string[];
  model: string;
  skill: string;
  dockerImage: string;
}

export interface StepState {
  index: number;
  name: string;
  status: StepStatus;
  snapshot: WorkflowStepSnapshot;
}

export interface PlanState {
  planId: string;
  projectId: string;
  featureDescription: string;
  phase: PlanPhase;
  currentStepIndex: number;
  workflowId: string;
  workflowVersionId: string;
  workflowSnapshot: WorkflowStepSnapshot[];
  tasks: Map<string, TaskState>;
  steps: StepState[];
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// EVENTS
// ============================================================================

export type EngineEvent =
  | { type: "PLAN_CREATED"; planId: string; projectId: string; featureDescription: string; workflowId: string; workflowVersionId: string; workflowSnapshot: WorkflowStepSnapshot[] }
  | { type: "TASK_COMPLETE"; planId: string; taskId: string; payload: Record<string, unknown> }
  | { type: "TASK_FAILED"; planId: string; taskId: string; error: string }
  | { type: "CONTAINER_DIED"; planId: string; taskId: string; containerId: string }
  | { type: "HEARTBEAT_TIMEOUT"; planId: string; taskId: string }
  | { type: "PLAN_APPROVED"; planId: string }
  | { type: "PLAN_CANCELLED"; planId: string }
  | { type: "SPAWN_FAILED"; planId: string; taskId: string; error: string }
  | { type: "CONTAINER_READY"; planId: string; taskId: string; sessionId: string }
  | { type: "DEPS_MET"; planId: string; taskId: string }
  | { type: "STEP_COMPLETE"; planId: string; stepIndex: number }
  | { type: "MERGE_FAILED"; planId: string; error: string }
  | { type: "CLEANUP_DONE"; planId: string };

// ============================================================================
// EFFECTS
// ============================================================================

export type Effect =
  | { type: "SPAWN_CONTAINER"; planId: string; taskId: string; config: SpawnConfig }
  | { type: "KILL_CONTAINER"; planId: string; taskId: string; containerId: string }
  | { type: "UPDATE_TASK"; planId: string; taskId: string; status: EngineTaskStatus; result?: Record<string, unknown>; error?: string }
  | { type: "UPDATE_PLAN"; planId: string; phase: PlanPhase; stepIndex?: number }
  | { type: "MERGE_PRS"; planId: string; branches: string[] }
  | { type: "EMIT_EVENT"; eventType: string; planId: string; taskId?: string; detail: string }
  | { type: "CLEANUP"; planId: string; resources: CleanupResource[] }
  | { type: "POPULATE_TASKS"; planId: string; tasks: TaskState[] }
  | { type: "FEED_EVENT"; event: EngineEvent }
  | { type: "ACQUIRE_LOCKS"; planId: string; taskId: string; files: string[] }
  | { type: "RELEASE_LOCKS"; planId: string; taskId: string };

export interface SpawnConfig {
  containerName: string;
  projectId: string;
  prompt: string;
  branch: string;
  model: string;
  skill: string;
  dockerImage: string;
  environment: Record<string, string>;
}

export interface CleanupResource {
  type: "container" | "worktree" | "branch";
  id: string;
}

// ============================================================================
// TRANSITION RESULT
// ============================================================================

export interface TransitionResult {
  nextState: PlanState;
  effects: Effect[];
}
