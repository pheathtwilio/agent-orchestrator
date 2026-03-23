# Workflow Engine Design Spec

**Date:** 2026-03-23
**Status:** Approved
**Scope:** Architectural overhaul — replace ad-hoc plan execution with a robust workflow state engine

## Problem Statement

The current plan execution system (`planner.ts` + `plan-executor.ts`) was built incrementally and suffers from structural issues:

- **Race conditions**: Multiple message handlers can process the same plan concurrently, causing duplicate container spawns and state corruption.
- **Split-brain state**: In-memory `plans` Map and Redis task graph diverge on crashes, leading to stuck or wedged plans.
- **Message replay corruption**: Replaying from Redis Stream offset "0" on every restart re-processes old messages (e.g., doctor completions resetting completed tasks to pending).
- **Container identity mismatch**: Session IDs (`om-84`), tmux names (`1838b7eb0585-om-84`), and Docker container names (`ao-1838b7eb0585-om-84`) are different. `destroyContainer` used the wrong name, so containers were never cleaned up.
- **Orphan accumulation**: Failed tasks don't trigger container cleanup. The orphan detector checked metadata existence, not container running state.
- **Connection leaks**: Each watcher restart creates new Redis connections without disconnecting old ones.
- **Tangled responsibilities**: `planner.ts` (2000 lines) mixes decomposition, execution, message handling, container management, doctor logic, workflow steps, and monitoring.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Planner / Engine boundary | Split apart | Engine is reusable and testable without LLM mocking |
| Planner execution model | Container (first task) | Visible in UI, same healing mechanisms, uniform pipeline |
| Message delivery | Redis consumer groups (XREADGROUP) | Exactly-once processing, no replay-from-0, crash recovery via XAUTOCLAIM |
| Container naming | Deterministic `ao-{planId}-{taskId}` | Derivable from task graph, no lookup needed |
| Container lifecycle ownership | Engine controls identity, session manager handles mechanics | Leverages existing worktree/git/auth setup |
| Container death detection | Docker events + heartbeats + reconciliation sweep | Covers crashes (immediate), hangs (5 min), missed events (60s safety net) |
| MCP services | Architected in (agent_config.mcp_services), built in Phase 3 | Containers need this in their build config |

## Architecture

### Component Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     Web UI / CLI                          │
└────────────────────────┬─────────────────────────────────┘
                         │ commands (create, resume, cancel)
                         ▼
┌──────────────────────────────────────────────────────────┐
│                   WORKFLOW ENGINE (new)                    │
│                                                            │
│  ┌────────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │ State Machine  │  │ Message       │  │ Container    │ │
│  │                │  │ Processor     │  │ Lifecycle    │ │
│  │ Plan FSM       │  │               │  │ Manager      │ │
│  │ Task FSM       │  │ Consumer      │  │              │ │
│  │ Step FSM       │  │ group         │  │ Docker events│ │
│  │                │  │ (XREADGROUP)  │  │ Heartbeats   │ │
│  │ Pure function  │  │ Per-plan      │  │ Reconcile    │ │
│  │ transition()   │  │ sequential    │  │ sweep        │ │
│  │                │  │ queues        │  │              │ │
│  └───────┬────────┘  └──────┬────────┘  └──────┬───────┘ │
│          └──────────────────┴──────────────────┘          │
│                             │                              │
│                    ┌────────┴────────┐                     │
│                    │ Effect Executor │                     │
│                    └────────┬────────┘                     │
└─────────────────────────────┼────────────────────────────┘
                              │ delegates spawn/kill
                              ▼
┌──────────────────────────────────────────────────────────┐
│              SESSION MANAGER (extended)                    │
│  Accepts containerName override from engine               │
│  Handles worktrees, git auth, agent plugins, prompts      │
└──────────────────────────────────────────────────────────┘
```

### Package Structure

```
packages/
  workflow-engine/          ← NEW — core of this redesign
    src/
      engine.ts             WorkflowEngine class (main entry point)
      state-machine.ts      Pure transition function + state types
      effect-executor.ts    Executes side effects (spawn, kill, update)
      message-processor.ts  Consumer group subscription + per-plan queues
      container-manager.ts  Docker events, heartbeats, reconciliation
      step-runner.ts        Workflow step advancement + exit criteria
      types.ts              PlanState, EngineEvent, Effect, etc.
      __tests__/            Comprehensive test suite

  planner/                  ← SLIMMED — only decomposition
    src/
      decompose.ts          LLM-powered task decomposition
      prompt-templates.ts   Prompts for decomposition
      types.ts              DecompositionResult, TaskDefinition

  message-bus/              ← EXTENDED
    src/
      bus.ts                Add XREADGROUP/XACK support
      task-store.ts         Atomic operations (Redis MULTI/EXEC), HASH-per-task

  core/                     ← EXTENDED
    src/
      session-manager.ts    Add containerName to SessionSpawnConfig

  web/                      ← SIMPLIFIED
    src/lib/
      engine-bridge.ts      Thin adapter: API routes → WorkflowEngine
```

## State Machines

### Plan Lifecycle

```
States: created → planning → reviewing → executing → completing → complete
                     │                       │
                     ▼                       ▼
                   failed                  failed

Any non-terminal state → cancelled (on user cancel)
```

**Transitions:**

| Current State | Event | Next State | Effects |
|---|---|---|---|
| created | PLAN_CREATED | planning | SPAWN_CONTAINER (planner) |
| planning | TASK_COMPLETE (planner) | reviewing | UPDATE_PLAN, populate task graph from payload |
| planning | TASK_FAILED (planner) | failed | CLEANUP |
| reviewing | PLAN_APPROVED | executing | Evaluate first step, SPAWN_CONTAINERs |
| executing | TASK_COMPLETE | executing | UPDATE_TASK, check step exit criteria |
| executing | STEP_COMPLETE | executing | Advance currentStepIndex, spawn next step's tasks |
| executing | ALL_STEPS_COMPLETE | completing | MERGE_PRS, CLEANUP |
| executing | UNRECOVERABLE_FAILURE | failed | KILL_ALL, CLEANUP |
| completing | CLEANUP_DONE | complete | EMIT_EVENT (plan_complete) |
| * (non-terminal) | PLAN_CANCELLED | cancelled | KILL_ALL, CLEANUP |

### Task Lifecycle

```
States: pending → spawning → running → complete
                    │          │
                    ▼          ▼
                  failed ← ──┘
                    │
                    ▼
                 doctoring (doctor is its own task with same FSM)
```

**Transitions:**

| Current State | Event | Next State | Effects |
|---|---|---|---|
| pending | DEPS_MET | spawning | SPAWN_CONTAINER |
| spawning | CONTAINER_READY | running | UPDATE_TASK |
| spawning | SPAWN_FAILED | failed | Apply failure policy |
| running | TASK_COMPLETE | complete | UPDATE_TASK, KILL_CONTAINER, release file locks |
| running | TASK_FAILED | failed | UPDATE_TASK, KILL_CONTAINER, apply failure policy |
| running | CONTAINER_DIED | failed | UPDATE_TASK, apply failure policy |
| running | HEARTBEAT_TIMEOUT | failed | KILL_CONTAINER, apply failure policy |
| failed | RETRY (policy) | pending | UPDATE_TASK (reset) |
| failed | DOCTOR (policy) | doctoring | SPAWN_CONTAINER (doctor task) |

Special task types (planner, doctor, integration, verify) use the same FSM with different spawn configs. Doctor completion resets the original task to pending.

### Workflow Step Lifecycle

```
States: pending → active → complete
                    │
                    ▼
                  failed

pending → skipped (condition evaluates false)
```

## Core Transition Function

The heart of the engine is a pure function:

```typescript
function transition(
  state: PlanState,
  event: EngineEvent
): { nextState: PlanState; effects: Effect[] }
```

**Events:**

External (from agents/Docker/user):
- `TASK_COMPLETE { taskId, payload }` — agent finished successfully
- `TASK_FAILED { taskId, error }` — agent reported failure
- `CONTAINER_DIED { containerId }` — Docker event: container exited
- `HEARTBEAT_TIMEOUT { taskId }` — no heartbeat within threshold
- `PLAN_APPROVED { planId }` — user approved the plan
- `PLAN_CANCELLED { planId }` — user cancelled the plan

Internal (generated by Effect Executor feedback):
- `SPAWN_FAILED { taskId, error }` — container spawn failed (Effect Executor reports back)
- `STEP_COMPLETE { stepIndex }` — derived when all tasks in step meet exit criteria
- `CLEANUP_DONE { planId }` — Effect Executor completed merge/cleanup effects

Note: `PLANNER_COMPLETE` is not a separate event. The planner is a task; its completion is a `TASK_COMPLETE` where `taskId == "plan"`. The transition function checks for this special taskId and populates the task graph from the payload. `MONITOR_TICK` is not an event passed to `transition()` — the reconciliation sweep generates concrete events (`CONTAINER_DIED`, `HEARTBEAT_TIMEOUT`) which are then fed to the state machine.

**Effects:**

- `SPAWN_CONTAINER { planId, taskId, config }` — create agent container
- `KILL_CONTAINER { containerId }` — destroy container
- `UPDATE_TASK { planId, taskId, status, result? }` — persist task state
- `UPDATE_PLAN { planId, phase, stepIndex? }` — persist plan state
- `MERGE_PRS { planId, branches }` — merge completed PRs
- `EMIT_EVENT { type, detail }` — notify UI/webhooks
- `CLEANUP { planId, resources }` — destroy worktrees, branches, containers

The transition function is pure — no I/O, no side effects. The Effect Executor handles all side effects after the transition completes. This makes every transition testable with simple assertions.

### Effect Failure Policy

When the Effect Executor encounters a failure:

- **`UPDATE_TASK` / `UPDATE_PLAN` failure** (Redis down): Retry with exponential backoff. If retries exhausted, crash the engine process. State divergence between memory and Redis is unrecoverable — a crash triggers restart recovery which rebuilds from Redis.
- **`SPAWN_CONTAINER` failure** (Docker error, image pull fail): Do not retry. Feed a `SPAWN_FAILED { taskId, error }` event back into the state machine, which transitions the task to `failed` and applies the failure policy.
- **`KILL_CONTAINER` failure** (container already gone): Log and ignore. Container destruction is idempotent — the reconciliation sweep will catch any that persist.
- **`MERGE_PRS` failure** (conflicts, GitHub API down): Feed a `MERGE_FAILED { planId, error }` event. The plan transitions to `failed` with a user-visible error. Partial merge state (some PRs merged, some not) is recorded in the plan metadata for manual resolution.
- **`CLEANUP` failure**: Log and continue. Cleanup entries remain in the registry and will be retried by the reconciliation sweep.

### File Locks

The engine manages file locks through the Effect Executor. When a task is spawned, the effect includes acquiring file locks for the task's file boundary. On task completion or failure, locks are released. The `FileLockRegistry` (existing Redis-based implementation) is used unchanged. Deadlock detection runs during the reconciliation sweep — if two tasks hold locks the other needs and neither has progressed, both are failed and retried.

## Message Processing

### Consumer Group Model

```
Stream: ao:engine:stream
Group:  engine
Consumer: engine-{processId}

Agent sends TASK_COMPLETE → XADD ao:engine:stream
Engine reads             → XREADGROUP GROUP engine engine-1 BLOCK 5000
Engine processes          → transition(state, event) → execute effects
Engine acknowledges       → XACK ao:engine:stream engine {messageId}
```

On crash recovery: `XAUTOCLAIM ao:engine:stream engine engine-1 60000` reclaims messages that were delivered but not acknowledged within 60 seconds.

**Consumer group creation**: Created once on first engine startup via `XGROUP CREATE ao:engine:stream engine $ MKSTREAM`. Using `$` means only new messages are delivered — old messages from the previous system are ignored. This is part of the Phase 2 switchover procedure.

**Stream compatibility**: During migration, the engine subscribes to the existing `ao:inbox:orchestrator` stream (reusing the current stream key) rather than creating a new one. This avoids the problem of old agent containers sending to the wrong stream. The stream key can be renamed later once all containers are rebuilt.

### Per-Plan Sequential Processing

Messages are routed by `payload.planId` to per-plan queues. Each queue drains sequentially:

```typescript
class PlanMessageQueue {
  private queue: EngineEvent[] = [];
  private draining = false;

  async enqueue(event: EngineEvent, ackFn: () => Promise<void>): Promise<void> {
    this.queue.push({ event, ackFn });
    if (!this.draining) await this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      const { event, ackFn } = this.queue.shift()!;
      const { nextState, effects } = transition(this.state, event);
      await this.effectExecutor.execute(effects);
      this.state = nextState;
      await ackFn(); // XACK only after effects succeed
    }
    this.draining = false;
  }
}
```

**XACK timing**: Messages are acknowledged only after `transition() + effects` succeeds. If the process crashes mid-processing, the unacknowledged message is reclaimed via XAUTOCLAIM on restart. This is the standard at-least-once delivery pattern — combined with the idempotent transition function, it provides effectively-once processing.

This eliminates race conditions: two TASK_COMPLETE messages for different tasks in the same plan are never processed concurrently.

## Container Lifecycle Manager

### Deterministic Naming

Container name: `ao--{planId}--{taskId}`
Example: `ao--plan-44c00107--1.4`

Double-hyphen `--` is used as the delimiter because both planId and taskId can contain single hyphens and dots. This makes parsing unambiguous: split on `--` to get `[ao, planId, taskId]`.

The name is derivable from the task graph alone. No `resolveContainerName` fallback chain. Session manager accepts a `containerName` override in `SessionSpawnConfig`.

A reverse-lookup HASH (`ao:engine:containers`) maps container names to `{planId, taskId}` for fast lookup from Docker events. Populated at spawn time, removed at cleanup.

### Three-Layer Detection

**Layer 1: Docker Events (immediate)**

Subscribe to `docker events --filter type=container --filter event=die` as a streaming subprocess. When a container dies, look up the container name in `ao:engine:containers` to resolve planId + taskId, and feed a `CONTAINER_DIED` event to the state machine. The Docker events subprocess is supervised — if it crashes or Docker restarts, the engine detects the broken pipe and restarts the subscription with backoff. The reconciliation sweep (Layer 3) covers any events missed during the restart gap.

**Layer 2: Heartbeat Absence (5 minute threshold)**

Agents send `PROGRESS_UPDATE` messages periodically while active. The existing agent sidecar already sends these at ~30 second intervals with telemetry data (tool activity, cost, phase). The engine tracks the last heartbeat timestamp per task in a Redis HASH (`ao:engine:heartbeats`). During the reconciliation sweep, if a container is running but has no heartbeat within 5 minutes, the engine feeds a `HEARTBEAT_TIMEOUT` event to the state machine.

Note: Some agents may have legitimately long-running operations (e.g., large builds, test suites) where the sidecar continues sending heartbeats even though no tool calls are completing. The heartbeat threshold detects agent process death (sidecar stops), not agent idleness. Idle/stuck detection remains based on the `tool_hung`/`subprocess_hung` telemetry in PROGRESS_UPDATE payloads, handled by the transition function.

**Layer 3: Reconciliation Sweep (60 second safety net)**

A single `docker ps -a --filter name=ao- --format '{{.Names}} {{.State}}'` call. Compare against all tasks with `running` status:
- Container exists, no matching running task → destroy container
- Task running, no container → feed `CONTAINER_DIED` event
- Both match → healthy

### Cleanup Registry

On container spawn: register `{ type: "container", name, planId, taskId }` in a Redis SET (`ao:plan:{planId}:cleanup`). When a task reaches a terminal state, the effect executor removes the container and the cleanup entry. The reconciliation sweep catches any entries for terminal tasks whose cleanup was missed.

## State Persistence

### Redis Schema

Moving from a single JSON blob to structured hashes:

```
ao:plan:{planId}              HASH — plan metadata
  phase, currentStepIndex, workflowId, workflowVersionId,
  workflowSnapshot (frozen JSON), createdAt, updatedAt

ao:plan:{planId}:tasks        HASH — one field per task
  {taskId} → JSON { status, containerId, branch, result, ... }

ao:plan:{planId}:cleanup      SET — pending cleanup actions

ao:engine:stream              STREAM — agent messages (consumer group)
ao:engine:heartbeats          HASH — last heartbeat per task
ao:engine:plans               SET — active plan IDs (removed on complete/cancel/fail)
ao:engine:containers          HASH — container name → {planId, taskId} reverse lookup
```

### Atomic Updates

Every state mutation uses Redis MULTI/EXEC:

```
MULTI
  HSET ao:plan:{planId}:tasks {taskId} {updatedJSON}
  HSET ao:plan:{planId} phase {newPhase}
  HSET ao:plan:{planId} updatedAt {now}
EXEC
```

In-memory projection updated only after transaction succeeds. Individual task updates are atomic — no more read-modify-write race on the full graph.

**Concurrency guarantee**: MULTI/EXEC provides atomic persistence of a single transition's effects. The per-plan sequential message queue provides serialized evaluation — only one transition runs per plan at a time. Both are required. If the sequential queue guarantee is ever relaxed (e.g., for cross-plan parallelism), add `WATCH ao:plan:{planId}` before `MULTI` for optimistic locking.

### Restart Recovery

1. `SMEMBERS ao:engine:plans` → list active plan IDs
2. For each plan: `HGETALL ao:plan:{planId}` + `HGETALL ao:plan:{planId}:tasks`
3. Rebuild in-memory PlanState projections
4. `XAUTOCLAIM ao:engine:stream` → reclaim unacked messages
5. Resume processing — no replay-from-0, no lost messages

## Workflow Steps

### Snapshot Binding

When a plan is created, the chosen workflow version is frozen into `workflowSnapshot` on the plan. The engine reads `plan.workflowSnapshot[currentStepIndex]` during execution. Editing the workflow later does not affect existing plans.

The engine interface accepts `workflowId + versionId + snapshot`. Today the UI picks the single workflow. Multiple workflows require no engine changes.

### Default Workflow

The legacy pipeline (implement → test → verify → merge) becomes a built-in default workflow definition:

- Step 0: **Plan** — planner container decomposes feature
- Step 1: **Implement** — implementation agents (parallel)
- Step 2: **Test** — integration test agent
- Step 3: **Verify** — verify build agent
- Step 4: **Complete** — merge PRs, cleanup resources

This eliminates the "workflow path" vs "legacy path" code split.

### Step Advancement

When a task completes, the engine evaluates the current step's exit criteria. If all criteria are met, it advances `currentStepIndex` and spawns tasks for the next step. Conditional steps are evaluated and skipped if their condition is false.

## MCP Services (Phase 3 — Architected Now)

### Interface

Workflow step `agent_config` includes an optional `mcp_services` array:

```typescript
agent_config: {
  skill: "frontend",
  docker_image: "ao-agent-frontend:latest",
  mcp_services: ["playwright", "database"]  // Phase 3
}
```

### Engine Hook

Before spawning a step's agents, the engine:
1. Reads `step.agent_config.mcp_services`
2. Ensures each MCP service container is running on `ao-network`
3. Passes `MCP_{SERVICE}_URL` environment variables to agent containers
4. On step completion: optionally tears down step-scoped MCP services

### Container Build

Agent Docker images need MCP client libraries in their build. This is a Phase 3 build concern but affects Dockerfile design now.

## Testing Strategy

### State Machine Unit Tests (~50 tests)

Pure function tests. Given state X and event Y, assert nextState and effects. No Docker, no Redis, no mocks. Covers every transition in the tables above.

### Container Lifecycle Tests

Mock Docker CLI. Test: crash detection via event parsing, heartbeat timeout detection, reconciliation scenarios (orphan container, orphan task, healthy match).

### Message Processor Tests

Uses real Redis (testcontainers or local). Test: consumer group creation, message routing by planId, XACK on success, crash recovery via XAUTOCLAIM, per-plan sequential ordering guarantee.

### Integration / Scenario Tests (~20 tests)

Full engine with mock containers. Scenarios:
- Happy path: plan → decompose → implement → test → verify → merge → complete
- Planner container fails → plan marked failed
- Agent crashes mid-task → container died event → failure policy applied
- Doctor heals and retries → original task reset to pending → respawned
- Stuck agent (no heartbeat) → killed → doctor spawned
- Plan cancellation → all containers killed → cleanup
- Step advancement with conditional steps
- Concurrent plans with independent processing
- Engine restart mid-execution → recovery via XAUTOCLAIM

### Regression Tests (from real bugs)

Each bug encountered during development becomes a test:
- Replayed doctor TASK_COMPLETE resetting completed task (prevented by consumer groups)
- Container name mismatch causing cleanup failure (prevented by deterministic naming)
- All tasks complete but plan stuck (tested as explicit transition)
- Containers spawned out of control (tested: sequential per-plan processing)
- Orphaned containers accumulating (tested: reconciliation sweep)

## Migration Path

### Phase 1: Foundation

- New `workflow-engine` package with state machine + effect executor
- Consumer group support in `message-bus`
- Atomic task updates in `task-store` (HASH per task)
- Container lifecycle manager (Docker events + heartbeats + reconciliation)
- State machine unit tests + integration tests
- Engine can run alongside old system behind a feature flag

### Phase 2: Switchover

- `plan-executor.ts` replaced by `engine-bridge.ts`
- Session manager extended with `containerName` override
- Planner becomes a container (first task in every plan)
- Default workflow definition replaces legacy pipeline
- Old planner execution logic removed
- Regression test suite validates all known bug scenarios
- **Data migration**: A migration script reads old `ao:taskgraph:*` STRING keys and writes them into the new HASH schema (`ao:plan:{planId}` + `ao:plan:{planId}:tasks`). Active plans should be drained (completed or cancelled) before switchover to avoid mid-flight migration. Archived plans are migrated for history but not loaded by the engine.
- Consumer group created on `ao:inbox:orchestrator` (reusing existing stream) with starting ID `$` (new messages only)

### Phase 3: MCP Services (Future)

- `mcp_services` field on `agent_config`
- MCP service container management in engine
- Agent Docker images built with MCP client support
- Workflow designer UI for MCP service selection
