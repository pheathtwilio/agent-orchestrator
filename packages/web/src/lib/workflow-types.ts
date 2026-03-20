export interface Workflow {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
}

export interface WorkflowVersion {
  id: string;
  workflow_id: string;
  version: number;
  is_active: boolean;
  created_at: number;
  snapshot: WorkflowStep[];
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  sort_order: number;
  name: string;
  description: string;
  exit_criteria: ExitCriteria;
  failure_policy: FailurePolicy;
  agent_config: AgentConfig;
  is_conditional: boolean;
  condition: StepCondition | null;
}

export interface ExitCriteria {
  programmatic: ProgrammaticCondition[];
  description: string;
}

export type ProgrammaticCondition =
  | "all_tasks_complete"
  | "tests_pass"
  | "no_failures"
  | "pr_created";

export interface FailurePolicy {
  action: "spawn_doctor" | "retry" | "fail_plan" | "skip" | "notify";
  max_retries?: number;
  description: string;
}

export interface AgentConfig {
  skill: string;
  model_tier: string;
  docker_image?: string;
  per_task_testing?: boolean;
}

export type StepCondition =
  | { type: "previous_step_had_failures" }
  | { type: "previous_step_all_passed" }
  | { type: "step_result_contains"; stepIndex: number; match: string }
  | { type: "always" }
  | { type: "never" };
