# Architecture

This document describes the high-level architecture of Agent Orchestrator, including the monorepo package structure, plugin system, and message bus design.

## Monorepo Package Structure

Agent Orchestrator is organized as a pnpm workspace monorepo with the following packages:

```
packages/
├── core/                    # Core library (types, services, config)
├── cli/                     # CLI tool (`ao` command)
├── web/                     # Next.js dashboard
├── agent-orchestrator/      # Main orchestrator package
├── planner/                 # Task decomposition and planning
├── message-bus/             # Redis-backed message bus
├── mobile/                  # Mobile application
├── integration-tests/       # Integration test suite
└── plugins/                 # Plugin packages (21 plugins across 8 slots)
    ├── runtime-*/           # Runtime plugins (tmux, docker, process)
    ├── agent-*/             # Agent adapters (claude-code, codex, aider, opencode)
    ├── workspace-*/         # Workspace providers (worktree, clone)
    ├── tracker-*/           # Issue trackers (github, linear, gitlab)
    ├── scm-*/               # SCM adapters (github, gitlab)
    ├── notifier-*/          # Notification channels (desktop, slack, webhook, composio, openclaw)
    └── terminal-*/          # Terminal UIs (iterm2, web)
```

### Package Dependencies

**Build order matters**: `core` must be built before all other packages. The dependency graph flows as:

```
core → [cli, web, plugins, agent-orchestrator, planner, message-bus]
plugins → cli (CLI imports all plugins)
[core, plugins] → web (Dashboard imports core and plugins)
```

### Core Package (`@composio/ao-core`)

The core package exports:

- **Type definitions** (`types.ts`): All interfaces and types that plugins implement
- **Services**:
  - `SessionManager`: Session CRUD (spawn, list, kill, send, restore)
  - `LifecycleManager`: State machine, polling loop, reactions engine
  - `PluginRegistry`: Plugin discovery, loading, and resolution
- **Utilities**:
  - `prompt-builder.ts`: 3-layer prompt assembly (base + config + rules)
  - `config.ts`: Configuration loading and Zod validation
  - `paths.ts`: Hash-based path and session name generation
  - `agent-selection.ts`: Resolves worker vs orchestrator agent roles
  - `observability.ts`: Correlation IDs, structured logging, metrics

## Plugin System

Agent Orchestrator is built around a plugin architecture with **8 plugin slots**. Every abstraction is swappable, and all interfaces are defined in `packages/core/src/types.ts`.

### Plugin Slots

| Slot      | Interface   | Purpose                              | Default       | Alternatives                             |
|-----------|-------------|--------------------------------------|---------------|------------------------------------------|
| Runtime   | `Runtime`   | Where sessions execute               | `tmux`        | `process`, `docker`, `k8s`, `ssh`, `e2b` |
| Agent     | `Agent`     | AI coding tool                       | `claude-code` | `codex`, `aider`, `opencode`             |
| Workspace | `Workspace` | Code isolation strategy              | `worktree`    | `clone`                                  |
| Tracker   | `Tracker`   | Issue tracking integration           | `github`      | `linear`, `gitlab`                       |
| SCM       | `SCM`       | Source platform (PR, CI, reviews)    | `github`      | `gitlab`                                 |
| Notifier  | `Notifier`  | Push notifications                   | `desktop`     | `slack`, `webhook`, `composio`, `openclaw` |
| Terminal  | `Terminal`  | Human interaction UI                 | `iterm2`      | `web`                                    |
| Lifecycle | —           | State machine + reactions (core)     | (core)        | Non-pluggable                            |

### Plugin Module Structure

Every plugin exports a `PluginModule` with:

```typescript
export interface PluginModule<T = unknown> {
  manifest: PluginManifest;  // name, slot, description, version
  create(config?: Record<string, unknown>): T;  // Factory function
}
```

Example plugin structure:

```typescript
import type { PluginModule, Runtime } from "@composio/ao-core";

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "tmux-based runtime",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "tmux",
    async create(config) { /* ... */ },
    async destroy(handle) { /* ... */ },
    async sendMessage(handle, message) { /* ... */ },
    async getOutput(handle, lines) { /* ... */ },
    async isAlive(handle) { /* ... */ },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

### Plugin Discovery and Loading

The `PluginRegistry` in `packages/core/src/plugin-registry.ts` handles:

1. **Built-in plugins**: Loaded from `packages/plugins/*` during `loadBuiltins()`
2. **External plugins**: Loaded from npm packages or local paths via `loadFromConfig()`
3. **Plugin resolution**: `get(slot, name)` returns the instance for a given slot and name

Plugins are registered once and reused across the application. The CLI imports all built-in plugins and registers them at startup.

## Message Bus Design

The message bus (`@composio/ao-message-bus`) provides Redis-backed communication for orchestrator-agent coordination and real-time output streaming.

### Architecture

**Transport**: Redis with two mechanisms:
- **Redis Streams** for durable, ordered message delivery
- **Redis Pub/Sub** for real-time output streaming

**Connection model**: Separate Redis connections for publishing and subscribing (Redis requirement)

### Message Patterns

#### 1. Inbox Pattern (Redis Streams)

Each recipient has its own stream: `ao:inbox:<recipient>`

```typescript
export interface BusMessage {
  id: string;                  // UUID
  type: MessageType;           // ASSIGN_TASK, TASK_COMPLETE, etc.
  from: string;                // Sender ID
  to: string;                  // Recipient ID
  timestamp: number;           // Unix timestamp
  payload: Record<string, unknown>;  // Message-specific data
}
```

**Message Types**:
- **Orchestrator → Agent**: `ASSIGN_TASK`, `ABORT`, `UNSTICK`, `CONTEXT_UPDATE`
- **Agent → Orchestrator**: `TASK_COMPLETE`, `TASK_FAILED`, `STUCK`, `QUESTION`, `FILE_LOCK_REQUEST`, `PROGRESS_UPDATE`
- **Testing**: `RUN_TESTS`, `TEST_RESULT`

**Why Streams over Pub/Sub?**
- Messages persist even if recipient is temporarily down
- History is queryable via `getHistory(recipient, count)`
- Consumer groups enable future horizontal scaling

#### 2. Output Streaming (Redis Pub/Sub)

Real-time agent output: `ao:output:<sessionId>`

```typescript
export type OutputHandler = (data: {
  sessionId: string;
  timestamp: number;
  line: string;
}) => void;
```

Used by the dashboard to display live terminal output from agent sessions.

### MessageBus Interface

```typescript
export interface MessageBus {
  publish(message: Omit<BusMessage, "id" | "timestamp">): Promise<string>;
  subscribe(recipient: string, handler: MessageHandler): Promise<void>;
  unsubscribe(recipient: string): Promise<void>;
  getHistory(recipient: string, count?: number): Promise<BusMessage[]>;
  subscribeOutput(sessionId: string, handler: OutputHandler): Promise<void>;
  unsubscribeOutput(sessionId: string): Promise<void>;
  disconnect(): Promise<void>;
}
```

### Supporting Components

#### File Lock Registry

Coordinate file access across parallel agents:

```typescript
export interface FileLockRegistry {
  acquire(filePath: string, owner: string): Promise<boolean>;
  release(filePath: string, owner: string): Promise<boolean>;
  releaseAll(owner: string): Promise<number>;
  getOwner(filePath: string): Promise<string | null>;
  listAll(): Promise<FileLock[]>;
  detectDeadlocks(): Promise<string[][]>;
}
```

#### Task Store

Orchestrator-managed task graph (for decomposition workflows):

```typescript
export interface TaskStore {
  createGraph(graph: Omit<TaskGraph, "createdAt" | "updatedAt">): Promise<TaskGraph>;
  getGraph(graphId: string): Promise<TaskGraph | null>;
  updateTask(graphId: string, taskId: string, update: Partial<TaskNode>): Promise<TaskNode | null>;
  getReadyTasks(graphId: string): Promise<TaskNode[]>;
  listGraphs(): Promise<TaskGraph[]>;
}
```

## Hash-Based Namespacing

All runtime data paths derive from a SHA-256 hash of the config file directory:

```typescript
const hash = sha256(path.dirname(configPath)).slice(0, 12);  // e.g., "a3b4c5d6e7f8"
const instanceId = `${hash}-${projectId}`;                   // e.g., "a3b4c5d6e7f8-myapp"
const dataDir = `~/.agent-orchestrator/${instanceId}`;
```

**Benefits**:
- Multiple orchestrator checkouts on the same machine never collide
- Session names are globally unique in tmux: `{hash}-{prefix}-{num}`
- User-facing names stay clean: `ao-1`, `myapp-2`
- Projects within the same config share a hash and data directory

## Session Lifecycle

Sessions flow through states managed by the `LifecycleManager`:

```
spawning → working → pr_open → ci_failed
                             → review_pending → changes_requested
                             → approved → mergeable → merged
                                                    ↓
                             cleanup → done (or killed/terminated)
```

**Activity states** (orthogonal to lifecycle):
- `active`: Agent is processing (thinking, writing code)
- `ready`: Agent finished its turn, waiting for input
- `idle`: Agent inactive for extended period
- `waiting_input`: Agent asking a question / permission prompt
- `blocked`: Agent hit an error or is stuck
- `exited`: Agent process is no longer running

## Data Storage

**Flat file metadata**: Session state stored as key=value files in `~/.agent-orchestrator/{hash}-{project}/sessions/{session-id}`

**Benefits**:
- Debuggable: `cat` shows full state
- No database to configure or migrate
- Survives crashes and restarts
- Git-friendly (can be version controlled if desired)

## Key Design Decisions

### Why Plugin Slots?

**Swappability**: Use tmux locally, Docker in CI, Kubernetes in prod — without changing application code.

**Testability**: Mock any plugin in unit tests.

**Extensibility**: Users add company-specific plugins without forking.

### Why Redis Streams for Message Bus?

**Durability**: Messages persist if recipient is temporarily down.

**Ordering**: Streams guarantee message order per recipient.

**Scalability**: Consumer groups enable future horizontal scaling.

**Simplicity**: No message broker infrastructure (Kafka, RabbitMQ) required.

### Why Flat File Metadata?

**Debuggability**: `cat ~/.agent-orchestrator/.../sessions/ao-1` shows full state.

**Simplicity**: No database to configure, no schema migrations.

**Reliability**: Survives orchestrator crashes and restarts.

**Portability**: Easy to backup, inspect, and transfer state.

## Further Reading

- [`packages/core/src/types.ts`](../packages/core/src/types.ts) — Complete interface definitions
- [`packages/core/README.md`](../packages/core/README.md) — Core service reference
- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) — Development guide and conventions
- [`agent-orchestrator.yaml.example`](../agent-orchestrator.yaml.example) — Configuration reference
