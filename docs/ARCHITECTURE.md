# Architecture

Agent Orchestrator is built as a TypeScript monorepo with a plugin-based architecture that enables parallel AI coding agents to work on separate issues across isolated workspaces.

## Monorepo Structure

The project uses **pnpm workspaces** with packages organized into three categories:

### Core Packages

Located in `packages/*`:

- **`core`** — Core types, config loader, session manager, lifecycle manager, and event bus. All other packages depend on this.
- **`cli`** — The `ao` command-line interface. Loads all built-in plugins and provides spawn, status, kill, and session management commands.
- **`agent-orchestrator`** — Global CLI wrapper package that delegates to `@composio/ao-cli`.
- **`message-bus`** — Redis-backed message bus for inter-agent communication, task coordination, and real-time output streaming.
- **`planner`** — Feature decomposition service that breaks down complex features into task graphs with dependencies, skills, and file boundaries.
- **`web`** — Dashboard UI (Next.js) for monitoring sessions, viewing logs, and controlling agents.
- **`integration-tests`** — End-to-end tests across the entire system.
- **`mobile`** — Mobile companion app (excluded from workspace builds).

### Plugin Packages

Located in `packages/plugins/*`:

Plugins are organized by slot (see Plugin System section). Each plugin is a standalone package with a standard structure:

```
packages/plugins/<slot>-<name>/
├── package.json
├── src/
│   └── index.ts     # exports { manifest, create }
└── tsconfig.json
```

**Current plugins:**

| Slot     | Plugins                                                                 |
| -------- | ----------------------------------------------------------------------- |
| Runtime  | `runtime-tmux`, `runtime-docker`, `runtime-process`                    |
| Agent    | `agent-claude-code`, `agent-codex`, `agent-aider`, `agent-opencode`    |
| Workspace| `workspace-worktree`, `workspace-clone`                                 |
| Tracker  | `tracker-github`, `tracker-linear`, `tracker-gitlab`                   |
| SCM      | `scm-github`, `scm-gitlab`                                              |
| Notifier | `notifier-desktop`, `notifier-slack`, `notifier-webhook`, `notifier-composio`, `notifier-openclaw` |
| Terminal | `terminal-iterm2`, `terminal-web`                                       |

### Workspace Configuration

Defined in `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "packages/plugins/*"
  - "!packages/mobile"
```

All packages use `workspace:*` protocol for internal dependencies, ensuring monorepo packages always resolve to the local version during development.

## Plugin System

The plugin architecture provides **8 swappable slots** that define how agents run, where they run, what they build with, and how they interact with external systems.

### Plugin Slots

Every plugin implements one of these interfaces (defined in `packages/core/src/types.ts`):

1. **`Runtime`** — WHERE sessions execute (tmux, Docker, Kubernetes, process)
   - Methods: `create()`, `destroy()`, `sendMessage()`, `getOutput()`, `isAlive()`
   - Example: `runtime-tmux` creates detached tmux sessions; `runtime-docker` spawns containerized agents

2. **`Agent`** — WHAT AI tool runs (Claude Code, Codex, Aider, OpenCode)
   - Methods: `launch()`, `detectActivity()`, `buildPrompt()`
   - Responsible for agent-specific launch commands, activity detection, and prompt construction

3. **`Workspace`** — CODE isolation strategy (worktree, clone)
   - Methods: `create()`, `destroy()`, `getBranch()`
   - `worktree` creates git worktrees for zero-copy isolation; `clone` creates full repo clones

4. **`Tracker`** — ISSUE tracking integration (GitHub Issues, Linear, Jira)
   - Methods: `getIssue()`, `updateIssue()`, `listIssues()`
   - Fetches issue details, updates status, and syncs state

5. **`SCM`** — SOURCE platform for PRs, CI, reviews (GitHub, GitLab)
   - Methods: `createPR()`, `getPR()`, `getCIStatus()`, `getReviews()`
   - Manages PR lifecycle, CI checks, and review comments

6. **`Notifier`** — PUSH notifications (desktop, Slack, webhook)
   - Methods: `notify()`
   - Sends alerts when human input is needed

7. **`Terminal`** — HUMAN interaction UI (iTerm2, web, none)
   - Methods: `attach()`
   - Provides terminal access to running agent sessions

8. **`Lifecycle Manager`** — State machine + reaction engine (core, not pluggable)
   - Polls session state, detects transitions, triggers reactions
   - Handles CI failures, review comments, and merge workflows

### Plugin Interface

Every plugin exports a `PluginModule`:

```typescript
export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
}

export interface PluginManifest {
  name: string;           // e.g. "tmux", "claude-code"
  slot: PluginSlot;       // e.g. "runtime", "agent"
  description: string;
  version: string;
}
```

**Example** (`packages/plugins/runtime-tmux/src/index.ts`):

```typescript
export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "tmux",
    async create(config) { /* ... */ },
    async destroy(handle) { /* ... */ },
    // ... other Runtime methods
  };
}
```

### Plugin Registry

The `PluginRegistry` (in `@composio/ao-core`) discovers and loads plugins:

- **Built-in plugins** are auto-loaded from `packages/plugins/*`
- **External plugins** can be loaded from npm packages or local paths via config
- Plugins are registered by slot and name, then retrieved with `registry.get<T>(slot, name)`

CLI and orchestrator instantiate plugins at startup based on `agent-orchestrator.yaml` config.

## Message Bus Design

The message bus (`@composio/ao-message-bus`) provides **inter-agent communication** and **real-time coordination** via Redis.

### Architecture

Three Redis-backed primitives:

1. **Message Bus** (Redis Streams)
2. **File Lock Registry** (Redis hashes + Lua scripts)
3. **Task Store** (Redis hashes for task graphs)

### 1. Message Bus — Redis Streams

**Purpose:** Durable, ordered message delivery between orchestrator and agents.

**Implementation:**
- Each recipient has an inbox stream: `ao:inbox:<recipient>`
- Messages are published with `XADD`, consumed with `XREAD`
- Supports message history via `getHistory()`
- Separate pub/sub channel for **real-time agent output streaming** (`ao:output:<sessionId>`)

**Message Types:**

| Type              | Direction            | Purpose                                      |
| ----------------- | -------------------- | -------------------------------------------- |
| `ASSIGN_TASK`     | Orchestrator → Agent | Assign a task from the decomposed plan       |
| `TASK_COMPLETE`   | Agent → Orchestrator | Report task completion with commits/summary  |
| `TASK_FAILED`     | Agent → Orchestrator | Report task failure with error details       |
| `STUCK`           | Agent → Orchestrator | Signal that agent is blocked                 |
| `QUESTION`        | Agent → Orchestrator | Ask for human input or clarification         |
| `FILE_LOCK_REQUEST` | Agent → Orchestrator | Request exclusive lock on a file           |
| `ABORT`           | Orchestrator → Agent | Cancel current task                          |
| `RUN_TESTS`       | Orchestrator → Testing | Trigger test execution for a task         |
| `TEST_RESULT`     | Testing → Orchestrator | Report test pass/fail                      |

**Why Streams over Pub/Sub?**
- Messages persist even if recipient is temporarily down
- History is queryable for debugging and replays
- Consumer groups enable future horizontal scaling

**Output Streaming:**
Agents publish real-time output lines to `ao:output:<sessionId>` using Redis pub/sub. Dashboard and CLI subscribe to this channel for live logs.

### 2. File Lock Registry — Redis Hashes + Lua

**Purpose:** Prevent merge conflicts when multiple agents work on overlapping files.

**Implementation:**
- Lock key: `ao:lock:<filePath>` → `{ owner: sessionId, acquiredAt: timestamp }`
- Atomic acquire/release via Lua scripts
- Auto-release when session is destroyed
- Deadlock detection via dependency graph analysis

**Operations:**
```typescript
acquire(filePath, owner) → boolean
release(filePath, owner) → boolean
releaseAll(owner) → number
getOwner(filePath) → string | null
detectDeadlocks() → string[][]
```

### 3. Task Store — Redis Hashes

**Purpose:** Persist task graphs from feature decomposition, track task status and dependencies.

**Schema:**
- Graph: `ao:graph:<graphId>` → `{ id, featureId, title, nodes[], createdAt, updatedAt }`
- Task node: `{ id, title, description, acceptanceCriteria[], fileBoundary[], status, assignedTo, dependsOn[], branch, result }`

**Operations:**
```typescript
createGraph(graph) → TaskGraph
getGraph(graphId) → TaskGraph | null
updateTask(graphId, taskId, update) → TaskNode | null
getReadyTasks(graphId) → TaskNode[]  // status=pending, dependencies satisfied
listGraphs() → TaskGraph[]
```

**Workflow:**
1. Planner decomposes a feature into tasks → `createGraph()`
2. Orchestrator assigns ready tasks → `getReadyTasks()` → `ASSIGN_TASK` message
3. Agent completes task → `TASK_COMPLETE` message → `updateTask(status: "complete")`
4. Orchestrator checks if new tasks are unblocked → repeat step 2

### Redis Connection

All three components share Redis configuration via `process.env.REDIS_URL` (default: `redis://localhost:6379`).

Each component maintains separate Redis clients:
- **Publisher** — for publishing messages/locks
- **Subscriber** — for polling streams (uses `XREAD BLOCK`)
- **Output subscriber** — dedicated for pub/sub output streaming

Graceful shutdown via `disconnect()` closes all connections cleanly.

## Data Flow

```
┌─────────────┐
│ ao spawn    │
│   (CLI)     │
└──────┬──────┘
       │
       ▼
┌─────────────────┐     ┌──────────────────┐
│ Session Manager │────▶│ Plugin Registry  │
│   (@ao-core)    │     │  (loads plugins) │
└────────┬────────┘     └──────────────────┘
         │
         │ 1. Workspace plugin creates worktree/clone
         │ 2. Runtime plugin spawns tmux/docker session
         │ 3. Agent plugin launches AI tool with prompt
         │
         ▼
┌─────────────────────┐
│  Lifecycle Manager  │◀────Redis────▶┌──────────────┐
│ (polls status loop) │               │ Message Bus  │
└──────────┬──────────┘               │ (ao-message) │
           │                          └──────────────┘
           │                                 ▲
           ▼                                 │
   Session transitions:                     │
   working → pr_open                        │
   pr_open → ci_failed ──────────┐          │
   ci_failed → working (retry)   │          │
   review_pending → changes_req  │          │
   changes_req → working ────────┼──────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │ Reaction Engine │
                        │ (auto-responds) │
                        └─────────────────┘
```

## Key Design Decisions

### 1. Monorepo with pnpm workspaces
**Why:** Enables atomic cross-package changes, shared TypeScript config, and faster CI builds with built-in caching.

### 2. Plugin-based architecture
**Why:** Makes the system extensible without core changes. New agents, runtimes, and integrations are just npm packages.

### 3. Redis Streams for message bus
**Why:** Durable message delivery, built-in ordering, and queryable history. More robust than in-memory pub/sub for distributed agents.

### 4. Git worktrees for workspace isolation
**Why:** Zero-copy branching — multiple agents can work on the same repo without full clones, saving disk space and setup time.

### 5. Lifecycle polling instead of webhooks
**Why:** Works in dev environments without public endpoints. Webhooks are optional for production.

### 6. TypeScript throughout
**Why:** Strong typing across plugin boundaries prevents runtime errors and improves developer experience.

## Testing Strategy

- **Unit tests** — Per-package with Vitest (`pnpm test`)
- **Integration tests** — Full workflows in `packages/integration-tests`
- **Plugin contracts** — Plugins must satisfy TypeScript interfaces (compile-time checks)
- **Snapshot tests** — Prompt builders and config generators

Run all tests: `pnpm test` (currently 3,288 test cases passing)

## Related Documentation

- [DEVELOPMENT.md](DEVELOPMENT.md) — Code conventions and contribution guidelines
- [SETUP.md](SETUP.md) — Development environment setup (coming soon)
- [packages/core/src/types.ts](../packages/core/src/types.ts) — Canonical type definitions
