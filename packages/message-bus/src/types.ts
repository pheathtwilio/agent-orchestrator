// ============================================================================
// MESSAGE TYPES
// ============================================================================

/** All message types flowing through the bus */
export type MessageType =
  // Orchestrator → Agent
  | "ASSIGN_TASK"
  | "ABORT"
  | "UNSTICK"
  | "CONTEXT_UPDATE"
  // Agent → Orchestrator
  | "TASK_COMPLETE"
  | "TASK_FAILED"
  | "STUCK"
  | "QUESTION"
  | "FILE_LOCK_REQUEST"
  | "PROGRESS_UPDATE"
  // Orchestrator → Testing
  | "RUN_TESTS"
  | "TEST_RESULT";

/** Base message envelope */
export interface BusMessage {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

/** Task assigned from orchestrator to an agent */
export interface TaskAssignment {
  taskId: string;
  sessionId: string;
  projectId: string;
  description: string;
  acceptanceCriteria: string[];
  fileBoundary: string[];
  model: string;
  skill: string;
  dependsOn: string[];
  branch: string;
}

/** Result reported by an agent */
export interface TaskResult {
  taskId: string;
  sessionId: string;
  status: "complete" | "failed" | "blocked";
  branch: string;
  commits: string[];
  summary: string;
  error?: string;
}

// ============================================================================
// MESSAGE BUS
// ============================================================================

export type MessageHandler = (message: BusMessage) => void | Promise<void>;

/** Handler for real-time agent output lines */
export type OutputHandler = (data: { sessionId: string; timestamp: number; line: string }) => void;

export interface MessageBus {
  /** Publish a message to a target's inbox */
  publish(message: Omit<BusMessage, "id" | "timestamp">): Promise<string>;

  /** Subscribe to messages for a given recipient.
   *  startId defaults to "$" (new messages only). Pass "0" to replay from beginning. */
  subscribe(recipient: string, handler: MessageHandler, startId?: string): Promise<void>;

  /** Unsubscribe from messages */
  unsubscribe(recipient: string): Promise<void>;

  /** Get message history for a recipient (from Redis streams) */
  getHistory(recipient: string, count?: number): Promise<BusMessage[]>;

  /** Subscribe to real-time output from an agent session (Redis pub/sub) */
  subscribeOutput(sessionId: string, handler: OutputHandler): Promise<void>;

  /** Unsubscribe from agent output */
  unsubscribeOutput(sessionId: string): Promise<void>;

  /** Subscribe using Redis consumer groups (XREADGROUP).
   *  Messages must be explicitly acknowledged via ack().
   *  handler receives (message, streamId) — streamId is needed for ack. */
  subscribeGroup(
    stream: string,
    group: string,
    consumer: string,
    handler: (message: BusMessage, streamId: string) => Promise<void>,
  ): Promise<void>;

  /** Acknowledge a message in a consumer group */
  ack(stream: string, group: string, streamId: string): Promise<void>;

  /** Claim pending messages from crashed consumers (XAUTOCLAIM) */
  autoClaim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
  ): Promise<Array<{ message: BusMessage; streamId: string }>>;

  /** Create a consumer group (idempotent — ignores BUSYGROUP error) */
  createGroup(stream: string, group: string, startId?: string): Promise<void>;

  /** Graceful shutdown */
  disconnect(): Promise<void>;
}

// ============================================================================
// FILE LOCKS
// ============================================================================

export interface FileLock {
  filePath: string;
  owner: string;
  acquiredAt: number;
}

export interface FileLockRegistry {
  /** Attempt to acquire a lock. Returns true if granted. */
  acquire(filePath: string, owner: string): Promise<boolean>;

  /** Release a lock. Only the owner can release. */
  release(filePath: string, owner: string): Promise<boolean>;

  /** Release all locks held by an owner (e.g. when session is destroyed) */
  releaseAll(owner: string): Promise<number>;

  /** Get current owner of a file lock, or null */
  getOwner(filePath: string): Promise<string | null>;

  /** List all locks (for orchestrator dashboard) */
  listAll(): Promise<FileLock[]>;

  /** Detect deadlocks: sessions waiting on files locked by sessions that are waiting */
  detectDeadlocks(): Promise<string[][]>;

  /** Graceful shutdown */
  disconnect(): Promise<void>;
}

// ============================================================================
// TASK STORE (TODO list managed by orchestrator)
// ============================================================================

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "testing"
  | "complete"
  | "failed"
  | "blocked";

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileBoundary: string[];
  status: TaskStatus;
  assignedTo: string | null;
  model: string;
  skill: string;
  dependsOn: string[];
  branch: string | null;
  result: TaskResult | null;
  createdAt: number;
  updatedAt: number;
  workflowStepIndex?: number;
}

export interface TaskGraph {
  id: string;
  featureId: string;
  title: string;
  nodes: TaskNode[];
  createdAt: number;
  updatedAt: number;
  /** Workflow metadata — stored for plan reconstruction */
  workflowId?: string;
  workflowVersionId?: string;
  workflowSnapshot?: unknown[];
  currentStepIndex?: number;
}

export interface TaskStore {
  /** Create a new task graph from a feature decomposition */
  createGraph(graph: Omit<TaskGraph, "createdAt" | "updatedAt">): Promise<TaskGraph>;

  /** Get a task graph by ID */
  getGraph(graphId: string): Promise<TaskGraph | null>;

  /** Update a task node's status */
  updateTask(graphId: string, taskId: string, update: Partial<TaskNode>): Promise<TaskNode | null>;

  /** Get all tasks that are ready to execute (deps satisfied, status pending) */
  getReadyTasks(graphId: string): Promise<TaskNode[]>;

  /** Get all active task graphs */
  listGraphs(): Promise<TaskGraph[]>;

  /** Delete a task graph */
  deleteGraph(graphId: string): Promise<boolean>;

  /** Get token usage for a plan (all sessions) */
  getUsage(planId: string): Promise<PlanUsage>;

  /** Add a node to an existing task graph (e.g. for dynamically spawned test/verify tasks) */
  addNode(graphId: string, node: TaskNode): Promise<TaskNode | null>;

  /** Archive a plan (hide from default list) */
  archiveGraph(graphId: string): Promise<void>;

  /** Unarchive a plan */
  unarchiveGraph(graphId: string): Promise<void>;

  /** Get set of archived graph IDs */
  listArchivedIds(): Promise<Set<string>>;

  /** Update graph-level metadata (e.g. currentStepIndex) without touching nodes */
  updateGraphMetadata(graphId: string, update: Partial<Pick<TaskGraph, "currentStepIndex" | "workflowId" | "workflowVersionId" | "workflowSnapshot">>): Promise<void>;

  /** Graceful shutdown */
  disconnect(): Promise<void>;
}

export interface SessionUsage {
  taskId: string;
  skill: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  updatedAt: number;
}

export interface PlanUsage {
  sessions: Record<string, SessionUsage>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  };
}

// ============================================================================
// SUMMARY STORE
// ============================================================================

export interface SummaryStore {
  /** Store a plan summary (keyed by planId). Accepts any object with a planId field. */
  store(summary: { planId: string }): Promise<void>;
  /** Retrieve a plan summary by planId */
  get(planId: string): Promise<Record<string, unknown> | null>;
  /** Graceful shutdown */
  disconnect(): Promise<void>;
}

// ============================================================================
// ENGINE STORE (HASH-per-task atomic persistence)
// ============================================================================

export interface EnginePlanData {
  phase: string;
  currentStepIndex: number;
  workflowId: string;
  workflowVersionId: string;
  workflowSnapshot: string; // JSON
  projectId: string;
  featureDescription: string;
  createdAt: number;
  updatedAt: number;
}

export interface EngineStore {
  createPlan(planId: string, data: EnginePlanData): Promise<void>;
  getPlan(planId: string): Promise<EnginePlanData | null>;
  atomicUpdate(planId: string, ops: AtomicOp[]): Promise<void>;
  getTask(planId: string, taskId: string): Promise<string | null>;
  getAllTasks(planId: string): Promise<Record<string, string>>;
  getActivePlanIds(): Promise<string[]>;
  deactivatePlan(planId: string): Promise<void>;
  registerContainer(containerName: string, planId: string, taskId: string): Promise<void>;
  lookupContainer(containerName: string): Promise<{ planId: string; taskId: string } | null>;
  removeContainer(containerName: string): Promise<void>;
  updateHeartbeat(planId: string, taskId: string, timestamp: number): Promise<void>;
  getHeartbeats(): Promise<Record<string, number>>;
  disconnect(): Promise<void>;
}

export type AtomicOp =
  | { type: "SET_TASK"; taskId: string; data: string }
  | { type: "SET_PLAN_FIELD"; field: string; value: string }
  | { type: "ADD_CLEANUP"; planId: string; resource: string }
  | { type: "REMOVE_CLEANUP"; planId: string; resource: string };
