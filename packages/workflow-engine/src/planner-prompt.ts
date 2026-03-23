import type { WorkflowStepSnapshot } from "./types.js";

/**
 * Build the prompt for the planner agent.
 *
 * The planner decomposes a feature description into a structured task graph
 * that the workflow engine can execute. Each task is assigned to a workflow
 * step and includes enough detail for an independent agent to implement it.
 *
 * The planner writes its output to /tmp/ao-plan-output.json which the sidecar
 * picks up and includes in the TASK_COMPLETE payload.
 */
export function buildPlannerPrompt(
  featureDescription: string,
  workflowSteps: WorkflowStepSnapshot[],
  planId: string,
): string {
  const stepsSection = workflowSteps.length > 0
    ? workflowSteps.map((step, i) => [
        `### Step ${i}: ${step.name}`,
        step.description,
        `- Skill: ${step.agent_config.skill}`,
        `- Model tier: ${step.agent_config.model_tier}`,
        step.agent_config.docker_image ? `- Docker image: ${step.agent_config.docker_image}` : null,
        `- Exit criteria: ${step.exit_criteria.programmatic.join(", ")}`,
        `- On failure: ${step.failure_policy.action}`,
      ].filter(Boolean).join("\n")).join("\n\n")
    : "No workflow steps defined. Create all tasks at stepIndex 0.";

  return `You are a planning agent for the Agent Orchestrator. Your job is to decompose a feature into a task graph that independent coding agents can execute in parallel.

## Feature to Implement

${featureDescription}

## Workflow Steps

The plan follows these workflow steps. Assign each task to the appropriate step by its index:

${stepsSection}

## Your Task

Analyze the feature and the codebase, then decompose it into concrete implementation tasks. For each task:

1. **Explore the codebase first** — understand the project structure, existing patterns, and relevant files before planning tasks.
2. **Create focused tasks** — each task should be implementable by a single agent in one session. If a task touches too many files or concepts, split it.
3. **Define clear boundaries** — specify which files each task owns via \`fileBoundary\` so agents don't conflict.
4. **Set dependencies** — if task B needs task A's output, add A's ID to B's \`dependsOn\` array. Tasks without dependencies run in parallel.
5. **Write detailed descriptions** — each description should contain everything an agent needs: what to build, which files to modify, what patterns to follow, and how to test it.

## Output Format

Write your task graph as JSON to \`/tmp/ao-plan-output.json\`. Use this exact schema:

\`\`\`json
[
  {
    "id": "1.1",
    "title": "Short descriptive title",
    "description": "Detailed implementation instructions for the agent. Include: what to build, which files to create/modify, what patterns to follow, what tests to write, and acceptance criteria.",
    "stepIndex": 0,
    "skill": "fullstack",
    "model": "sonnet",
    "dependsOn": [],
    "fileBoundary": ["src/auth/**", "tests/auth/**"],
    "acceptanceCriteria": ["User can log in", "Tests pass"]
  }
]
\`\`\`

Field reference:
- **id**: Unique task identifier. Use "N.M" format where N is the step index and M is the task number within that step (e.g. "0.1", "0.2", "1.1").
- **title**: Short human-readable title (under 80 chars).
- **description**: Full implementation instructions. Be specific — the agent has no other context.
- **stepIndex**: Which workflow step this task belongs to (0-indexed). Tasks in the same step can run in parallel. Step N+1 tasks only start after all step N tasks complete.
- **skill**: Agent skill — typically "fullstack", "backend", "frontend", "testing", "security", or "devops".
- **model**: Model to use — "sonnet" for most tasks, "opus" for complex architectural work.
- **dependsOn**: Array of task IDs that must complete before this task can start (within the same step).
- **fileBoundary**: Glob patterns for files this task owns. Prevents agents from conflicting.
- **acceptanceCriteria**: List of concrete conditions that must be true when the task is done.

## Important Rules

- Write the JSON file using the Bash tool: write it with a single command like \`cat > /tmp/ao-plan-output.json << 'PLAN_EOF'\n...\nPLAN_EOF\`
- The JSON must be valid — the engine parses it programmatically.
- Every task must have a stepIndex that matches one of the workflow steps above (or 0 if no steps are defined).
- Tasks in step 0 run first, then step 1, etc. Use dependsOn only for ordering within a step.
- Plan ID for reference: ${planId}
- Do NOT implement anything yourself. Your only job is to create the plan file.
- After writing the plan file, verify it's valid JSON by running: \`cat /tmp/ao-plan-output.json | python3 -m json.tool > /dev/null && echo "Valid JSON" || echo "Invalid JSON"\`
`;
}
