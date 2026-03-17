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
  | "database";

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
  },
};

// ============================================================================
// PLAN EXECUTION STATE
// ============================================================================

export type PlanPhase =
  | "planning"
  | "review"
  | "executing"
  | "testing"
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
  | "plan_complete"
  | "plan_failed"
  | "agent_stuck"
  | "agent_unstuck"
  | "deadlock_detected"
  | "plan_cancelled";

export interface PlannerEvent {
  type: PlannerEventType;
  planId: string;
  taskId?: string;
  sessionId?: string;
  detail: string;
  timestamp: number;
}

export type PlannerEventHandler = (event: PlannerEvent) => void | Promise<void>;
