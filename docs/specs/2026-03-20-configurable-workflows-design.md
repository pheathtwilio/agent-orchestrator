# Configurable SDLC Workflows

**Date:** 2026-03-20
**Status:** Draft

## Problem

The agent orchestrator has a hardcoded SDLC workflow: implementation -> integration test -> verify build -> complete. The phase transitions, agent prompts, exit criteria, and failure handling are all baked into `planner.ts`. This makes it impossible to customize the pipeline without code changes. Additionally, the verify-build step completes its work but doesn't trigger plan completion properly.

## Solution

Replace the hardcoded phase logic with a configurable workflow engine. Workflows are defined via an admin UI (visual pipeline builder), stored in SQLite, versioned for in-flight plan safety, and consumed by a generic step runner in the planner.

## Data Model (SQLite)

Three tables in `data/ao-workflows.db`:

### `workflows`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | e.g. `"default-sdlc"` |
| name | TEXT | Display name |
| description | TEXT | What this workflow is for |
| created_at | INTEGER | Timestamp |
| updated_at | INTEGER | Timestamp |

### `workflow_versions`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| workflow_id | TEXT FK | References `workflows.id` |
| version | INTEGER | Auto-incrementing per workflow |
| is_active | INTEGER | 0 or 1 — enforced via `CREATE UNIQUE INDEX idx_one_active ON workflow_versions(workflow_id) WHERE is_active = 1` |
| created_at | INTEGER | Timestamp |
| snapshot | TEXT (JSON) | Full serialized step definitions — immutable record |

Publishing a new version deactivates the old one and activates the new one in a single transaction.

### `workflow_steps`

Mutable draft steps edited via the admin UI. Become a snapshot when "published."

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| workflow_id | TEXT FK | References `workflows.id` |
| sort_order | INTEGER | Position in pipeline |
| name | TEXT | e.g. "Implementation" |
| description | TEXT | Plain English duties for the agent |
| exit_criteria | TEXT (JSON) | Structured + free-text conditions |
| failure_policy | TEXT (JSON) | What to do on failure |
| agent_config | TEXT (JSON) | Skill, model tier, docker image overrides |
| is_conditional | INTEGER | 0 or 1 |
| condition | TEXT (JSON) | When to run (e.g. "previous step had failures") |

### Exit Criteria Structure

```json
{
  "programmatic": ["all_tasks_complete", "tests_pass"],
  "description": "All implementation agents must have their changes committed, tests passing, and PR created"
}
```

Programmatic conditions: `all_tasks_complete`, `tests_pass`, `no_failures`, `pr_created`. These are composable — all must be true.

### Failure Policy Structure

```json
{
  "action": "spawn_doctor",
  "max_retries": 2,
  "description": "Spawn a diagnostic agent to investigate and fix the failure"
}
```

Actions: `spawn_doctor`, `retry`, `fail_plan`, `skip`, `notify`.

### Versioning Model

1. Admin edits steps in the UI (modifies `workflow_steps` — the draft)
2. Admin clicks "Publish" — system serializes current steps into a JSON snapshot, creates a new `workflow_versions` row, marks it `is_active`
3. On plan creation, the planner resolves the workflow: if the project has an assigned workflow, use it; otherwise use `"default-sdlc"`. It reads the active version's `snapshot` and stores it in the plan's Redis data along with `workflowId` and `workflowVersionId` for traceability.
4. In-flight plans always reference their stored snapshot, never the live draft

**Agent config precedence:** Step-level `agent_config` provides defaults. The planner's `PlannerConfig.modelPolicy` and `imageMap` can override these at the system level. Order: system config > step config > built-in defaults.

## Planner Refactor — Generic Step Runner

### Plan State Changes

The plan object in Redis gains:

```typescript
interface Plan {
  // ... existing fields ...
  workflowId: string;                // which workflow this plan uses
  workflowVersionId: string;         // which version was snapshotted
  workflowSnapshot: WorkflowStep[];  // from version snapshot at creation time
  currentStepIndex: number;          // which step we're on
}
```

`PlanPhase` simplifies from `"planning" | "review" | "executing" | "testing" | "verifying" | "complete"` to:

```typescript
type PlanPhase = "planning" | "review" | "step_executing" | "complete" | "failed" | "cancelled";
```

The `planning` phase is retained for the brief period during initial decomposition (before the plan enters review or execution). The dashboard displays the step name (e.g. "Integration Test") rather than a generic phase label.

Each task node gains a `workflowStepIndex` field to associate it with the workflow step that spawned it:

```typescript
interface TaskNode {
  // ... existing fields ...
  workflowStepIndex: number;  // which workflow step this task belongs to
}
```

This allows the step runner to filter tasks by step when evaluating exit criteria like `all_tasks_complete` — it only considers tasks where `workflowStepIndex === plan.currentStepIndex`.

### Step Runner Loop

```
1. Plan created -> workflowSnapshot attached, currentStepIndex = 0
2. Plan approved -> begin step[0] (e.g. "Implementation")
3. Step[0] exit criteria met -> advance to step[1] (e.g. "Integration Test")
4. Step[1] exit criteria met -> advance to step[2] (e.g. "Verify Build")
5. No more steps -> plan phase = "complete", run cleanup
```

### Exit Criteria Evaluation

After each task completion message, the orchestrator checks the current step's programmatic conditions:

| Condition | Evaluation |
|-----------|-----------|
| `all_tasks_complete` | Every task node for this step has status "complete" |
| `tests_pass` | Agent's TASK_COMPLETE includes test results with no failures |
| `no_failures` | No task in this step has status "failed" |
| `pr_created` | Task result includes a PR URL |

### Step Advancement

```typescript
async function evaluateStepCompletion(plan: Plan): Promise<void> {
  const step = plan.workflowSnapshot[plan.currentStepIndex];
  if (!step) return;

  // Only evaluate tasks belonging to the current step
  const stepTasks = plan.taskGraph.nodes.filter(
    (n) => n.workflowStepIndex === plan.currentStepIndex
  );
  const met = checkExitCriteria(step.exit_criteria.programmatic, stepTasks);
  if (!met) return;

  const nextIndex = plan.currentStepIndex + 1;
  if (nextIndex >= plan.workflowSnapshot.length) {
    await completePlan(plan);
    return;
  }

  // Persist step advancement to Redis atomically before proceeding
  plan.currentStepIndex = nextIndex;
  await taskStore.setPlanMetadata(plan.id, { currentStepIndex: nextIndex });

  const nextStep = plan.workflowSnapshot[nextIndex];

  if (nextStep.is_conditional && !evaluateCondition(nextStep.condition, plan)) {
    await evaluateStepCompletion(plan); // skip, check next
    return;
  }

  await beginStep(plan, nextStep);
}
```

Step advancement is persisted to Redis before spawning the next step's agents. If the process crashes between persistence and spawning, the watch loop restarts and picks up from the correct step index.

### Agent Spawning Per Step

```typescript
async function beginStep(plan: Plan, step: WorkflowStep): Promise<void> {
  const context = gatherPriorStepContext(plan);
  const prompt = buildStepPrompt(step, context);
  const tasks = await decomposeStep(plan, step, prompt);

  for (const task of tasks) {
    await taskStore.addTask(plan.id, task);
    await spawnSession(task);
  }
}
```

- For implementation (step 0): runs the full AI decomposer to create the task graph with dependencies
- For later steps: the decomposer sees a single-purpose step and creates one or few task nodes

The orchestrator retains its intelligence for determining cardinality and dependencies — the workflow defines *what* each step does, the decomposer decides *how many* agents.

### Prior Step Context

`gatherPriorStepContext()` collects from completed steps:
- Branches created by implementation agents
- PR URLs
- Test results
- Error summaries from doctor interventions

This context is injected into the next step's prompt.

### Failure Handling Per Step

When a task fails, the runner checks the current step's `failure_policy`:
- `spawn_doctor` — create a diagnostic task for investigation (current behavior)
- `retry` — reset task to pending, up to `max_retries`
- `fail_plan` — immediately mark plan as failed
- `skip` — mark task as skipped, continue evaluating exit criteria
- `notify` — emit event but don't block

Doctor-type reactive behavior is configurable per step. An explicit diagnostic step can also be added to the workflow sequence.

### Message Handler Refactor

The current `handleMessage()` (~600 lines) is a monolithic router with hardcoded task ID checks (`"integration-test"`, `"verify-build"`, `"doctor-*"`). This becomes a generic dispatcher that routes messages based on task-to-step associations.

**Message type mapping:**

| Message | Current behavior | New behavior |
|---------|-----------------|-------------|
| `TASK_COMPLETE` | Hardcoded checks for `integration-test`, `verify-build`, doctor tasks | Look up task's `workflowStepIndex`, evaluate that step's exit criteria. If doctor task, reset original task to pending. |
| `TASK_FAILED` | Special cases for `integration-test`/`verify-build` (immediate plan fail) vs impl tasks (spawn doctor) | Look up the current step's `failure_policy` and execute it. No special-cased task IDs. |
| `PROGRESS_UPDATE` | Stuck detection (>15min idle), tool/subprocess hung detection | Unchanged — step-agnostic, applies to any task regardless of step. |
| `TEST_RESULT` | Per-task test pass/fail with task reset on failure | Preserved. Per-task testing is orthogonal to workflow steps — it's a within-step behavior. The `failure_policy` determines whether failed per-task tests trigger a doctor or retry. |
| `FILE_LOCK_REQUEST` | Grant/deny file locks | Unchanged — step-agnostic. |

**Doctor task association:** Doctor tasks spawned by a step's `spawn_doctor` failure policy inherit the same `workflowStepIndex` as the failed task. When a doctor task completes, the runner resets the original failed task to pending (same as current behavior), without checking hardcoded task ID prefixes.

**Per-task testing:** The `createTestTrigger` mechanism is preserved within steps. It's a within-step behavior: when a task in step N completes, a per-task test may run before the step's exit criteria are evaluated. The step's `agent_config` can include a `per_task_testing: boolean` flag to enable/disable this per step. The default workflow's implementation step has it enabled.

### Conditional Step Schema

The `condition` field uses a structured schema, not free-text:

```json
{
  "type": "previous_step_had_failures",
}
```

Supported condition types:
- `previous_step_had_failures` — true if any task in the previous step failed (even if retried successfully)
- `previous_step_all_passed` — true if previous step completed with no failures at all
- `step_result_contains` — `{ "type": "step_result_contains", "stepIndex": 0, "match": "merge conflict" }` — substring match on any task result summary in the referenced step
- `always` — always true (useful for debugging)
- `never` — always false (useful for disabling a step without deleting it)

### Resume and Retry Refactor

The current `resumePlan()` resets failed tasks and removes hardcoded `integration-test`/`verify-build` nodes by ID. With generic steps:

- `resumePlan()` identifies the failing step via `currentStepIndex`, resets failed tasks in that step to pending, and removes any doctor tasks for that step. It does not reference task IDs by name.
- `retryPlan()` resets `currentStepIndex` to 0, resets all tasks to pending, and removes tasks from steps > 0 (since they'll be re-created when those steps begin).
- Both functions read the `workflowSnapshot` from the plan's Redis data to understand step boundaries.

### Event Type Refactor

The current `PlannerEventType` includes hardcoded event names like `testing_started`, `verify_complete`. These become generic:

- `step_started` — includes `stepIndex` and `stepName`
- `step_complete` — includes `stepIndex` and `stepName`
- `step_failed` — includes `stepIndex`, `stepName`, and failure details

The dashboard subscribes to these generic events and renders the step name from the workflow snapshot.

### Monitor Updates

The `monitor()` function currently checks `plan.phase !== "executing" && plan.phase !== "testing" && plan.phase !== "verifying"`. This simplifies to `plan.phase !== "step_executing"` since all active steps use the same phase.

### What Gets Removed From planner.ts

- `finalizePlan()` — replaced by step advancement logic
- `spawnTestingAgent()` — becomes a step definition in default workflow
- `spawnVerifyAgent()` — becomes a step definition in default workflow
- `spawnDoctorAgent()` — moves to generic failure handler
- Hardcoded `PlanPhase` transitions

### What Stays The Same

- Decomposer creates task graphs for implementation
- `spawnSession()` / `killSession()` callbacks
- Message bus, task store, file locks
- Monitor and stuck detection
- Watch loop in `plan-executor.ts`

## Default Workflow — Migration Path

The system ships with a "Default SDLC" workflow replicating current behavior exactly.

### Default Steps

**Step 0: Implementation**
- Description: "Each agent must implement their assigned sub-feature, write tests for their changes, and verify tests pass. Create a PR with a clear description of changes."
- Exit criteria: `["all_tasks_complete"]` — "All implementation agents have committed, tested, and created PRs"
- Failure policy: `spawn_doctor`, max_retries: 2
- Agent config: skill "developer", model tier "primary"

**Step 1: Integration Test**
- Description: "Merge all implementation branches together and run the full test suite. Verify that all features work together without conflicts. Fix any merge conflicts or integration issues."
- Exit criteria: `["all_tasks_complete", "tests_pass"]` — "All branches merged cleanly and full test suite passes"
- Failure policy: `fail_plan`
- Agent config: skill "testing", model tier "testing"

**Step 2: Verify Build**
- Description: "Run a final production build and full test suite. Verify no regressions. Generate a summary of all changes, PRs merged, and test results. Clean up any temporary resources."
- Exit criteria: `["all_tasks_complete"]` — "Production build succeeds and all tests pass"
- Failure policy: `fail_plan`
- Agent config: skill "testing", model tier "testing"

### Migration Strategy

1. On first server start with new code, a migration creates the SQLite database, tables, and seeds the default workflow with version 1 active
2. Existing in-flight plans in Redis have no `workflowSnapshot` — the planner detects this and falls back to legacy hardcoded path
3. New plans use the workflow system
4. Legacy fallback removed in a future cleanup pass after all old plans complete

## Admin UI — Visual Pipeline Builder

New page at `/admin/workflows`.

### Layout

- **Left sidebar:** Workflow list (name, active version, draft status)
- **Main area:** Pipeline canvas — steps as connected nodes, horizontal left-to-right flow with arrows
- **Right panel:** Step edit form (opens on node click)

### Pipeline Canvas

Each step node shows:
- Name (bold), description preview, failure policy indicator
- Drag handle for reordering
- "+" buttons between nodes and at the end for inserting new steps

Connections rendered as directional arrows between nodes.

### Node Edit Panel

Fields:
- Name (text input)
- Description (textarea — plain English duties)
- Exit Criteria — checkboxes for programmatic conditions + description textarea
- Failure Policy — dropdown (spawn_doctor, retry, fail_plan, skip, notify) + max_retries + description
- Agent Config — dropdowns for skill, model tier, optional docker image
- Conditional toggle + condition editor

### Workflow Actions (top bar)

- **Publish** — snapshot draft to new version, confirm dialog
- **Version History** — view/compare/restore previous versions
- **Delete** — only if no plans reference the workflow

### Tech Approach

- React component using existing zinc/cyan design system
- CSS grid/flexbox for horizontal pipeline layout with SVG arrows (no heavy library needed for a linear pipeline)
- Drag-and-drop via `@dnd-kit/core` or native HTML drag
- Draft edits save via API calls to `PUT /api/admin/workflows/:id/steps`
- Publish via `POST /api/admin/workflows/:id/publish`

### Dashboard Changes

Plan detail view shows:
- Current step name instead of generic phase
- Mini progress indicator showing all workflow steps with current one highlighted
- Step descriptions visible on hover/expand

## API Routes

### Workflow CRUD — `/api/admin/workflows`

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/workflows` | List all workflows |
| POST | `/api/admin/workflows` | Create a new workflow |
| GET | `/api/admin/workflows/:id` | Get workflow with draft steps |
| PUT | `/api/admin/workflows/:id` | Update workflow name/description |
| DELETE | `/api/admin/workflows/:id` | Delete (only if no plans reference it) |

### Step CRUD — `/api/admin/workflows/:id/steps`

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/workflows/:id/steps` | List draft steps in order |
| POST | `/api/admin/workflows/:id/steps` | Add a new step |
| PUT | `/api/admin/workflows/:id/steps/:stepId` | Update a step |
| DELETE | `/api/admin/workflows/:id/steps/:stepId` | Remove a step |
| POST | `/api/admin/workflows/:id/steps/reorder` | Reorder steps (array of step IDs) |

### Versioning — `/api/admin/workflows/:id/versions`

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/admin/workflows/:id/publish` | Snapshot draft to new version |
| GET | `/api/admin/workflows/:id/versions` | List version history |
| GET | `/api/admin/workflows/:id/versions/:version` | Get specific version snapshot |
| POST | `/api/admin/workflows/:id/versions/:version/restore` | Copy version back to draft |

### Planner Integration

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/workflows/:id/active` | Get active version snapshot |

### Project Assignment (future)

| Method | Route | Description |
|--------|-------|-------------|
| PUT | `/api/admin/projects/:projectId/workflow` | Assign workflow to project |

### Storage Layer

New `packages/web/src/lib/workflow-store.ts` wraps SQLite with typed functions:
- `getWorkflows()`, `getWorkflow(id)`, `createWorkflow(...)`, `updateWorkflow(...)`
- `getSteps(workflowId)`, `addStep(...)`, `updateStep(...)`, `removeStep(...)`, `reorderSteps(...)`
- `publishVersion(workflowId)`, `getVersions(workflowId)`, `getActiveSnapshot(workflowId)`

## Scope

### In Scope
- SQLite storage for workflow definitions with versioning
- Generic step runner replacing hardcoded planner phases
- Default SDLC workflow replicating current behavior
- Visual pipeline builder admin UI
- Admin API routes for workflow CRUD and publishing
- Migration path preserving in-flight plans
- Per-step failure policies (spawn_doctor, retry, fail_plan, skip, notify)
- Conditional steps
- Dashboard updates showing current workflow step

### Out of Scope
- Multiple workflows per project (data model supports it, UI deferred)
- Workflow templates / marketplace
- Step-level permissions or approval gates
- Parallel step execution (steps always run sequentially)
- Workflow analytics / metrics
