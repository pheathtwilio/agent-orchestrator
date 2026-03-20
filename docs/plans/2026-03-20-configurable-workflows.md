# Configurable SDLC Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded SDLC workflow in the planner with a configurable workflow engine backed by SQLite, editable via a visual pipeline builder admin UI.

**Architecture:** SQLite stores workflow definitions with draft/publish versioning. The planner's hardcoded phase transitions become a generic step runner that iterates workflow steps. Plans snapshot the active workflow version at creation time, making in-flight plans immune to edits. A new admin page at `/admin/workflows` provides a visual pipeline builder for creating and editing workflows.

**Tech Stack:** SQLite via `better-sqlite3`, Next.js App Router, React, existing zinc/cyan design system, Redis (unchanged for task/plan state)

**Spec:** `docs/superpowers/specs/2026-03-20-configurable-workflows-design.md`

---

## File Structure

### New Files
- `packages/web/src/lib/workflow-store.ts` — SQLite access layer (schema, migrations, CRUD)
- `packages/web/src/lib/workflow-types.ts` — Shared TypeScript types for workflows
- `packages/web/src/app/api/admin/workflows/route.ts` — GET/POST workflows
- `packages/web/src/app/api/admin/workflows/[id]/route.ts` — GET/PUT/DELETE single workflow
- `packages/web/src/app/api/admin/workflows/[id]/steps/route.ts` — GET/POST steps
- `packages/web/src/app/api/admin/workflows/[id]/steps/[stepId]/route.ts` — PUT/DELETE step
- `packages/web/src/app/api/admin/workflows/[id]/steps/reorder/route.ts` — POST reorder
- `packages/web/src/app/api/admin/workflows/[id]/publish/route.ts` — POST publish version
- `packages/web/src/app/api/admin/workflows/[id]/versions/route.ts` — GET version history
- `packages/web/src/app/api/admin/workflows/[id]/versions/[version]/route.ts` — GET specific version
- `packages/web/src/app/api/admin/workflows/[id]/versions/[version]/restore/route.ts` — POST restore
- `packages/web/src/app/api/admin/workflows/[id]/active/route.ts` — GET active snapshot
- `packages/web/src/app/admin/workflows/page.tsx` — Admin workflows page
- `packages/web/src/components/admin/WorkflowPipelineEditor.tsx` — Pipeline canvas
- `packages/web/src/components/admin/WorkflowStepNode.tsx` — Individual step node
- `packages/web/src/components/admin/WorkflowStepEditPanel.tsx` — Right-side edit panel
- `packages/planner/src/step-runner.ts` — Generic step runner (extracted from planner)
- `packages/planner/src/step-failure-handler.ts` — Per-step failure policy executor
- `packages/planner/src/step-exit-criteria.ts` — Exit criteria evaluator

### Modified Files
- `packages/web/package.json` — Add `better-sqlite3` dependency
- `packages/message-bus/src/types.ts` — Add `workflowStepIndex` to `TaskNode`
- `packages/planner/src/types.ts` — Update `PlanPhase`, add `WorkflowStep` type, update event types
- `packages/planner/src/planner.ts` — Replace hardcoded phases with step runner calls
- `packages/planner/src/index.ts` — Export new modules
- `packages/web/src/lib/plan-executor.ts` — Pass workflow snapshot to planner
- `packages/web/src/app/api/plans/create/route.ts` — Resolve workflow at plan creation
- `packages/web/src/components/PlansDashboard.tsx` — Show workflow step progress

---

## Tasks

### Task 1: Add `better-sqlite3` and Create Workflow Types

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/src/lib/workflow-types.ts`
- Modify: `packages/message-bus/src/types.ts`
- Modify: `packages/planner/src/types.ts`

- [ ] **Step 1: Install better-sqlite3**

```bash
cd packages/web && npm install better-sqlite3 && npm install -D @types/better-sqlite3
```

- [ ] **Step 2: Create workflow-types.ts**

```typescript
// packages/web/src/lib/workflow-types.ts

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
```

- [ ] **Step 3: Add workflowStepIndex to TaskNode**

In `packages/message-bus/src/types.ts`, add to the `TaskNode` interface:

```typescript
workflowStepIndex: number;  // which workflow step this task belongs to
```

Default to `0` for backward compatibility. Update `makeCleanupNode` and any factory functions to include `workflowStepIndex: 0`.

- [ ] **Step 4: Update PlanPhase and event types in planner types**

In `packages/planner/src/types.ts`:

```typescript
// Replace existing PlanPhase
export type PlanPhase =
  | "planning"
  | "review"
  | "step_executing"
  | "complete"
  | "failed"
  | "cancelled";

// Add to PlannerEventType union:
// "step_started" | "step_complete" | "step_failed"

// Add to ExecutionPlan interface:
//   workflowId: string;
//   workflowVersionId: string;
//   workflowSnapshot: WorkflowStep[];
//   currentStepIndex: number;
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add workflow types and better-sqlite3 dependency"
```

---

### Task 2: Create SQLite Workflow Store

**Files:**
- Create: `packages/web/src/lib/workflow-store.ts`

- [ ] **Step 1: Write the workflow store with schema migration**

Create `packages/web/src/lib/workflow-store.ts` with:

1. `getDb()` — singleton that opens/creates `data/ao-workflows.db`, runs `CREATE TABLE IF NOT EXISTS` for `workflows`, `workflow_versions`, `workflow_steps`. Creates the partial unique index `idx_one_active` on `workflow_versions(workflow_id) WHERE is_active = 1`. Ensures `data/` directory exists.

2. Workflow CRUD:
   - `getWorkflows(): Workflow[]`
   - `getWorkflow(id: string): Workflow | null`
   - `createWorkflow(id: string, name: string, description: string): Workflow`
   - `updateWorkflow(id: string, updates: { name?: string; description?: string }): Workflow | null`
   - `deleteWorkflow(id: string): boolean` — fails if any plans reference this workflow

3. Step CRUD:
   - `getSteps(workflowId: string): WorkflowStep[]` — ordered by `sort_order`
   - `addStep(workflowId: string, step: Omit<WorkflowStep, "id" | "workflow_id">): WorkflowStep`
   - `updateStep(stepId: string, updates: Partial<WorkflowStep>): WorkflowStep | null`
   - `removeStep(stepId: string): boolean`
   - `reorderSteps(workflowId: string, stepIds: string[]): void` — updates `sort_order` based on array position

4. Versioning:
   - `publishVersion(workflowId: string): WorkflowVersion` — serialize current steps → snapshot JSON, create version row, deactivate old active version + activate new in a transaction
   - `getVersions(workflowId: string): WorkflowVersion[]`
   - `getVersion(workflowId: string, version: number): WorkflowVersion | null`
   - `getActiveSnapshot(workflowId: string): WorkflowStep[] | null`
   - `restoreVersion(workflowId: string, version: number): void` — copy snapshot back to draft steps

Use `crypto.randomUUID()` for IDs. Store JSON fields via `JSON.stringify` / `JSON.parse`. All writes use `db.transaction()` for atomicity.

- [ ] **Step 2: Add default workflow seeding**

Add `seedDefaultWorkflow()` function that checks if `"default-sdlc"` exists, and if not, creates it with the three default steps (Implementation, Integration Test, Verify Build) from the spec, then publishes version 1. Call this from `getDb()` after schema creation.

- [ ] **Step 3: Verify the store works**

```bash
cd packages/web && node -e "
  const { getWorkflows, getSteps, getActiveSnapshot } = require('./src/lib/workflow-store');
  console.log('Workflows:', getWorkflows());
  console.log('Steps:', getSteps('default-sdlc'));
  console.log('Active snapshot:', getActiveSnapshot('default-sdlc'));
"
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add SQLite workflow store with default SDLC workflow"
```

---

### Task 3: Workflow CRUD API Routes

**Files:**
- Create: `packages/web/src/app/api/admin/workflows/route.ts`
- Create: `packages/web/src/app/api/admin/workflows/[id]/route.ts`

- [ ] **Step 1: Create list/create route**

`GET /api/admin/workflows` — returns `{ workflows: Workflow[] }` via `getWorkflows()`
`POST /api/admin/workflows` — body `{ id, name, description }`, returns created workflow

- [ ] **Step 2: Create single workflow route**

`GET /api/admin/workflows/:id` — returns workflow with draft steps: `{ workflow, steps }`
`PUT /api/admin/workflows/:id` — body `{ name?, description? }`, returns updated workflow
`DELETE /api/admin/workflows/:id` — deletes if no plans reference it

- [ ] **Step 3: Verify routes**

```bash
curl http://localhost:3000/api/admin/workflows | jq
curl http://localhost:3000/api/admin/workflows/default-sdlc | jq
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add workflow CRUD API routes"
```

---

### Task 4: Step CRUD and Reorder API Routes

**Files:**
- Create: `packages/web/src/app/api/admin/workflows/[id]/steps/route.ts`
- Create: `packages/web/src/app/api/admin/workflows/[id]/steps/[stepId]/route.ts`
- Create: `packages/web/src/app/api/admin/workflows/[id]/steps/reorder/route.ts`

- [ ] **Step 1: Create steps list/add route**

`GET /api/admin/workflows/:id/steps` — returns `{ steps: WorkflowStep[] }`
`POST /api/admin/workflows/:id/steps` — body with step fields, returns created step

- [ ] **Step 2: Create single step route**

`PUT /api/admin/workflows/:id/steps/:stepId` — update step fields
`DELETE /api/admin/workflows/:id/steps/:stepId` — remove step

- [ ] **Step 3: Create reorder route**

`POST /api/admin/workflows/:id/steps/reorder` — body `{ stepIds: string[] }`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add step CRUD and reorder API routes"
```

---

### Task 5: Publish and Version API Routes

**Files:**
- Create: `packages/web/src/app/api/admin/workflows/[id]/publish/route.ts`
- Create: `packages/web/src/app/api/admin/workflows/[id]/versions/route.ts`
- Create: `packages/web/src/app/api/admin/workflows/[id]/versions/[version]/route.ts`
- Create: `packages/web/src/app/api/admin/workflows/[id]/versions/[version]/restore/route.ts`
- Create: `packages/web/src/app/api/admin/workflows/[id]/active/route.ts`

- [ ] **Step 1: Create publish route**

`POST /api/admin/workflows/:id/publish` — calls `publishVersion()`, returns new version

- [ ] **Step 2: Create version history routes**

`GET /api/admin/workflows/:id/versions` — list all versions
`GET /api/admin/workflows/:id/versions/:version` — get specific version snapshot
`POST /api/admin/workflows/:id/versions/:version/restore` — restore to draft

- [ ] **Step 3: Create active snapshot route**

`GET /api/admin/workflows/:id/active` — returns active version's step snapshot (used by planner)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add workflow publish and version API routes"
```

---

### Task 6: Step Runner, Exit Criteria, and Failure Handler

**Files:**
- Create: `packages/planner/src/step-runner.ts`
- Create: `packages/planner/src/step-exit-criteria.ts`
- Create: `packages/planner/src/step-failure-handler.ts`
- Modify: `packages/planner/src/index.ts`

- [ ] **Step 1: Create exit criteria evaluator**

`packages/planner/src/step-exit-criteria.ts`:
- `checkExitCriteria(conditions: ProgrammaticCondition[], tasks: TaskNode[]): boolean`
- Evaluates each condition against the filtered task list:
  - `all_tasks_complete` — every task status is "complete"
  - `tests_pass` — all task results exist and none have errors mentioning test failures
  - `no_failures` — no task has status "failed"
  - `pr_created` — every task result includes a branch (proxy for PR)
- All conditions must be true (AND logic)

- [ ] **Step 2: Create failure handler**

`packages/planner/src/step-failure-handler.ts`:
- `handleStepFailure(plan, taskId, step, callbacks): Promise<void>`
- Reads `step.failure_policy.action` and dispatches:
  - `spawn_doctor` — create doctor task with same `workflowStepIndex`, skill "doctor"
  - `retry` — reset task to pending if under `max_retries`
  - `fail_plan` — set plan phase to "failed"
  - `skip` — mark task as skipped
  - `notify` — emit event only
- Track retry count in task metadata or a Map

- [ ] **Step 3: Create step runner**

`packages/planner/src/step-runner.ts`:
- `evaluateStepCompletion(plan, taskStore, callbacks): Promise<void>` — filter tasks by `workflowStepIndex`, check exit criteria, advance if met, persist to Redis atomically
- `beginStep(plan, step, taskStore, callbacks): Promise<void>` — gather prior context, build prompt, decompose step, spawn agents
- `evaluateCondition(condition, plan): boolean` — evaluate conditional step conditions
- `gatherPriorStepContext(plan): StepContext` — collect branches, PRs, test results from prior steps
- `buildStepPrompt(step, context): string` — combine step description with prior context

- [ ] **Step 4: Export new modules from index.ts**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add generic step runner, exit criteria, and failure handler"
```

---

### Task 7: Refactor Planner to Use Step Runner

**Files:**
- Modify: `packages/planner/src/planner.ts`

This is the largest task — replacing hardcoded phase logic with step runner calls.

- [ ] **Step 1: Update plan creation to attach workflow snapshot**

In `planFeature()`: accept `workflowSnapshot`, `workflowId`, `workflowVersionId` parameters. Store them on the `ExecutionPlan`. Set `currentStepIndex: 0`. Set initial task nodes' `workflowStepIndex: 0`.

- [ ] **Step 2: Replace `finalizePlan()` with step advancement**

Remove `finalizePlan()`. In the task completion handler, after marking a task complete, call `evaluateStepCompletion()` from the step runner instead.

- [ ] **Step 3: Replace hardcoded TASK_COMPLETE handlers**

Remove special-case checks for `"integration-test"`, `"verify-build"`, `"doctor-*"` task IDs in `handleMessage()`. Replace with:
- Look up task's `workflowStepIndex`
- If doctor task (track via metadata), reset original task to pending
- Otherwise, call `evaluateStepCompletion()`

- [ ] **Step 4: Replace hardcoded TASK_FAILED handlers**

Remove special-case failure logic. Replace with:
- Look up current step's `failure_policy`
- Call `handleStepFailure()` from the failure handler

- [ ] **Step 5: Update phase checks**

Replace all `plan.phase === "executing"`, `"testing"`, `"verifying"` checks with `plan.phase === "step_executing"`. Update `monitor()` accordingly.

- [ ] **Step 6: Update `approvePlan()` to use step runner**

Instead of directly spawning ready tasks, call `beginStep(plan, plan.workflowSnapshot[0], ...)`.

- [ ] **Step 7: Remove `spawnTestingAgent()`, `spawnVerifyAgent()`, `spawnDoctorAgent()`**

These are now handled by the step runner's `beginStep()` and the failure handler. Remove the functions.

- [ ] **Step 8: Update event emissions**

Replace `testing_started`/`verify_started` etc. with generic `step_started`, `step_complete`, `step_failed` events that include `stepIndex` and `stepName`.

- [ ] **Step 9: Add legacy fallback**

In `loadPlan()`: if the loaded plan has no `workflowSnapshot`, log a warning and continue with the old hardcoded logic. This preserves in-flight plans created before the migration.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "refactor: replace hardcoded planner phases with generic step runner"
```

---

### Task 8: Update Plan Executor and Create Route

**Files:**
- Modify: `packages/web/src/lib/plan-executor.ts`
- Modify: `packages/web/src/app/api/plans/create/route.ts`

- [ ] **Step 1: Update create route to resolve workflow**

In `packages/web/src/app/api/plans/create/route.ts`:
- Import `getActiveSnapshot` from workflow store
- Before calling `createAndExecutePlan`, fetch the active workflow snapshot
- Pass `workflowId`, `workflowVersionId`, `workflowSnapshot` to the executor

- [ ] **Step 2: Update plan executor to pass workflow to planner**

In `createAndExecutePlan()`:
- Accept `workflowId`, `workflowVersionId`, `workflowSnapshot` in options
- Pass them through to `planner.planFeature()`

- [ ] **Step 3: Update resume/retry to read workflow from plan**

In `resumePlan()` and `retryPlan()`:
- After `loadPlan()`, the workflow snapshot is already in the plan's Redis data
- `resumePlan()` resets failed tasks in the current step only
- `retryPlan()` resets `currentStepIndex` to 0 and clears tasks from steps > 0

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: wire workflow resolution into plan creation and execution"
```

---

### Task 9: Admin UI — Workflow Pipeline Editor Page

**Files:**
- Create: `packages/web/src/app/admin/workflows/page.tsx`
- Create: `packages/web/src/components/admin/WorkflowPipelineEditor.tsx`
- Create: `packages/web/src/components/admin/WorkflowStepNode.tsx`

- [ ] **Step 1: Create the admin page**

`packages/web/src/app/admin/workflows/page.tsx`:
- Fetches workflows list from API on mount
- Left sidebar with workflow list (name, version, draft indicator)
- Clicking a workflow loads its draft steps and renders the pipeline editor
- "Create Workflow" button in sidebar

- [ ] **Step 2: Create WorkflowPipelineEditor component**

`packages/web/src/components/admin/WorkflowPipelineEditor.tsx`:
- Horizontal pipeline layout using CSS flexbox
- Renders `WorkflowStepNode` for each step, connected by SVG arrows
- "+" buttons between nodes and at the end to insert new steps
- Top bar with: workflow name, "Publish" button, "Version History" dropdown
- Drag-and-drop reorder (use native HTML drag or lightweight `@dnd-kit/core`)
- On step click, emits `onSelectStep(stepId)` to parent

- [ ] **Step 3: Create WorkflowStepNode component**

`packages/web/src/components/admin/WorkflowStepNode.tsx`:
- Card displaying: step name (bold), description preview (truncated), failure policy badge
- Visual indicators: conditional steps shown with dashed border
- Drag handle, delete button (with confirmation)
- Selected state styling (cyan border)

- [ ] **Step 4: Verify the pipeline canvas renders**

Start dev server, navigate to `/admin/workflows`, verify the default SDLC workflow shows 3 connected step nodes.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add admin workflows page with pipeline canvas"
```

---

### Task 10: Admin UI — Step Edit Panel

**Files:**
- Create: `packages/web/src/components/admin/WorkflowStepEditPanel.tsx`
- Modify: `packages/web/src/app/admin/workflows/page.tsx`

- [ ] **Step 1: Create WorkflowStepEditPanel component**

Right-side slide-out panel with fields:
- **Name** — text input
- **Description** — textarea (plain English duties)
- **Exit Criteria** — checkboxes for `all_tasks_complete`, `tests_pass`, `no_failures`, `pr_created` + description textarea
- **Failure Policy** — dropdown for action type + `max_retries` number input (shown when action is `spawn_doctor` or `retry`) + description textarea
- **Agent Config** — dropdowns for skill and model tier, optional docker image text input, `per_task_testing` toggle
- **Conditional** — toggle switch, condition type dropdown when enabled
- Auto-saves on change via `PUT /api/admin/workflows/:id/steps/:stepId`

- [ ] **Step 2: Wire panel into the page**

In the admin page, when `onSelectStep` fires, show the edit panel on the right. Pass step data and update handler.

- [ ] **Step 3: Add Publish flow**

"Publish" button in the top bar:
- Confirmation dialog showing current draft changes
- Calls `POST /api/admin/workflows/:id/publish`
- Shows success toast with new version number

- [ ] **Step 4: Add Version History**

Dropdown showing version list from `GET /api/admin/workflows/:id/versions`. Each entry shows version number and date. "Restore" button calls the restore API and reloads draft steps.

- [ ] **Step 5: Verify full edit flow**

Navigate to `/admin/workflows`, select Implementation step, change description, publish, verify new version appears in history.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add step edit panel with publish and version history"
```

---

### Task 11: Dashboard — Workflow Step Progress

**Files:**
- Modify: `packages/web/src/components/PlansDashboard.tsx`
- Modify: `packages/web/src/app/api/plans/[id]/route.ts` (if needed to expose workflow metadata)

- [ ] **Step 1: Update plan detail view**

In `PlansDashboard.tsx`, when displaying a plan's phase:
- If the plan has `workflowSnapshot`, show a mini step progress bar: circles/pills for each workflow step, current step highlighted in cyan, completed steps in green
- Display the current step name (e.g. "Integration Test") instead of generic phase text
- Show step description on hover

- [ ] **Step 2: Handle legacy plans**

Plans without `workflowSnapshot` continue showing the old phase names as-is.

- [ ] **Step 3: Verify in the UI**

Create a test plan, verify the step progress bar renders with the default SDLC workflow steps.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: show workflow step progress in plan dashboard"
```

---

### Task 12: Add `better-sqlite3` to Next.js Server External Packages

**Files:**
- Modify: `packages/web/next.config.js`

- [ ] **Step 1: Add to serverExternalPackages**

Add `"better-sqlite3"` to the `serverExternalPackages` array in `next.config.js` (same pattern as `@composio/core` and the AWS SDK packages). This prevents webpack from trying to bundle the native module.

- [ ] **Step 2: Verify dev server starts without errors**

```bash
cd packages/web && npm run dev
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "fix: add better-sqlite3 to serverExternalPackages"
```
