import type { TaskNode as BusTaskNode, TaskGraph } from "@composio/ao-message-bus";

// ============================================================================
// SKILL PROFILES
// ============================================================================

/** Agent skill — determines Docker image, CLAUDE.md, and tooling */
export type AgentSkill =
  | "frontend"
  | "backend"
  | "fullstack"
  | "testing"
  | "security"
  | "devops"
  | "database"
  | "doctor";

/** Model tier — maps to cost/capability tradeoff */
export type ModelTier = "opus" | "sonnet" | "haiku";

/** Resolved assignment for a single task */
export interface TaskAssignment {
  taskId: string;
  skill: AgentSkill;
  model: ModelTier;
  dockerImage: string;
  fileBoundary: string[];
  estimatedComplexity: "high" | "medium" | "low";
}

// ============================================================================
// PLANNER CONFIG
// ============================================================================

export interface PlannerConfig {
  /** Model for planning/decomposition (needs strong reasoning) */
  planningModel: string;
  /** Max decomposition depth */
  maxDepth: number;
  /** Require human approval before executing */
  requireApproval: boolean;
  /** Maximum concurrent agents */
  maxConcurrency: number;
  /** Model assignment policy */
  modelPolicy: ModelPolicy;
  /** Run per-task test agents before integration testing */
  perTaskTesting: boolean;
  /** Skip integration testing entirely (useful for docs-only changes) */
  skipIntegrationTest: boolean;
  /** Docker image mapping per skill */
  imageMap: Record<AgentSkill, string>;
}

export interface ModelPolicy {
  planning: ModelTier;
  implementation: {
    high: ModelTier;
    medium: ModelTier;
    low: ModelTier;
  };
  testing: ModelTier;
  security: ModelTier;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  planningModel:
    process.env.ANTHROPIC_MODEL_OPUS
    ?? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    ?? "claude-opus-4-0-20250514",
  maxDepth: 3,
  requireApproval: true,
  maxConcurrency: 5,
  perTaskTesting: false,
  skipIntegrationTest: false,
  modelPolicy: {
    planning: "opus",
    implementation: {
      high: "opus",
      medium: "sonnet",
      low: "haiku",
    },
    testing: "sonnet",
    security: "sonnet",
  },
  imageMap: {
    frontend: "ao-agent-frontend:latest",
    backend: "ao-agent:latest",
    fullstack: "ao-agent-frontend:latest",
    testing: "ao-agent-frontend:latest",
    security: "ao-agent-security:latest",
    devops: "ao-agent:latest",
    database: "ao-agent:latest",
    doctor: "ao-agent-frontend:latest",
  },
};

// ============================================================================
// WORKFLOW STEP SNAPSHOT (minimal subset for planner execution)
// ============================================================================

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
  };
  is_conditional: boolean;
  condition: unknown | null;
}

// ============================================================================
// PLAN EXECUTION STATE
// ============================================================================

export type PlanPhase =
  | "planning"
  | "review"
  | "step_executing"
  | "complete"
  | "failed"
  | "cancelled";

export interface ExecutionPlan {
  id: string;
  projectId: string;
  featureDescription: string;
  phase: PlanPhase;
  taskGraph: TaskGraph;
  assignments: Map<string, TaskAssignment>;
  activeSessions: Map<string, string>;
  createdAt: number;
  updatedAt: number;
  workflowId?: string;
  workflowVersionId?: string;
  workflowSnapshot?: WorkflowStepSnapshot[];
  currentStepIndex?: number;
}

// ============================================================================
// PLANNER EVENTS (emitted for monitoring/dashboard)
// ============================================================================

export type PlannerEventType =
  | "plan_created"
  | "plan_approved"
  | "task_assigned"
  | "task_started"
  | "task_complete"
  | "task_failed"
  | "task_reassigned"
  | "testing_started"
  | "testing_complete"
  | "testing_failed"
  | "verify_started"
  | "verify_complete"
  | "verify_failed"
  | "plan_complete"
  | "plan_failed"
  | "agent_stuck"
  | "agent_unstuck"
  | "doctor_started"
  | "doctor_complete"
  | "doctor_failed"
  | "deadlock_detected"
  | "plan_cancelled"
  | "step_started"
  | "step_complete"
  | "step_failed";

export interface PlannerEvent {
  type: PlannerEventType;
  planId: string;
  taskId?: string;
  sessionId?: string;
  detail: string;
  timestamp: number;
}

export type PlannerEventHandler = (event: PlannerEvent) => void | Promise<void>;
