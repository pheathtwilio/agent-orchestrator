import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import type {
  Workflow,
  WorkflowVersion,
  WorkflowStep,
} from "./workflow-types";

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let cachedDb: Database.Database | null = null;

export function getDb(): Database.Database {
  if (cachedDb) return cachedDb;

  mkdirSync("data", { recursive: true });

  const db = new Database("data/ao-workflows.db");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id          TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      version     INTEGER NOT NULL,
      is_active   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      snapshot    TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active
      ON workflow_versions(workflow_id) WHERE is_active = 1;

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id             TEXT PRIMARY KEY,
      workflow_id    TEXT NOT NULL REFERENCES workflows(id),
      sort_order     INTEGER NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL,
      exit_criteria  TEXT NOT NULL,
      failure_policy TEXT NOT NULL,
      agent_config   TEXT NOT NULL,
      is_conditional INTEGER NOT NULL DEFAULT 0,
      condition      TEXT
    );
  `);

  cachedDb = db;

  seedDefaultWorkflow();

  return cachedDb;
}

// ---------------------------------------------------------------------------
// Workflow CRUD
// ---------------------------------------------------------------------------

export function getWorkflows(): Workflow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM workflows").all() as Workflow[];
}

export function getWorkflow(id: string): Workflow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
  return (row as Workflow) ?? null;
}

export function createWorkflow(
  id: string,
  name: string,
  description: string,
): Workflow {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "INSERT INTO workflows (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, description, now, now);
  return { id, name, description, created_at: now, updated_at: now };
}

export function updateWorkflow(
  id: string,
  updates: { name?: string; description?: string },
): Workflow | null {
  const db = getDb();
  const existing = getWorkflow(id);
  if (!existing) return null;

  const name = updates.name ?? existing.name;
  const description = updates.description ?? existing.description;
  const now = Date.now();

  db.prepare(
    "UPDATE workflows SET name = ?, description = ?, updated_at = ? WHERE id = ?",
  ).run(name, description, now, id);

  return { id, name, description, created_at: existing.created_at, updated_at: now };
}

export function deleteWorkflow(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Step CRUD
// ---------------------------------------------------------------------------

function rowToStep(row: Record<string, unknown>): WorkflowStep {
  return {
    id: row.id as string,
    workflow_id: row.workflow_id as string,
    sort_order: row.sort_order as number,
    name: row.name as string,
    description: row.description as string,
    exit_criteria: JSON.parse(row.exit_criteria as string),
    failure_policy: JSON.parse(row.failure_policy as string),
    agent_config: JSON.parse(row.agent_config as string),
    is_conditional: (row.is_conditional as number) === 1,
    condition: row.condition ? JSON.parse(row.condition as string) : null,
  };
}

export function getStep(stepId: string): WorkflowStep | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM workflow_steps WHERE id = ?")
    .get(stepId) as Record<string, unknown> | undefined;
  return row ? rowToStep(row) : null;
}

export function getSteps(workflowId: string): WorkflowStep[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY sort_order")
    .all(workflowId) as Record<string, unknown>[];
  return rows.map(rowToStep);
}

export function addStep(
  workflowId: string,
  step: Omit<WorkflowStep, "id" | "workflow_id">,
): WorkflowStep {
  const db = getDb();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO workflow_steps
       (id, workflow_id, sort_order, name, description, exit_criteria, failure_policy, agent_config, is_conditional, condition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workflowId,
    step.sort_order,
    step.name,
    step.description,
    JSON.stringify(step.exit_criteria),
    JSON.stringify(step.failure_policy),
    JSON.stringify(step.agent_config),
    step.is_conditional ? 1 : 0,
    step.condition ? JSON.stringify(step.condition) : null,
  );

  return { id, workflow_id: workflowId, ...step };
}

export function updateStep(
  stepId: string,
  updates: Partial<WorkflowStep>,
): WorkflowStep | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM workflow_steps WHERE id = ?")
    .get(stepId) as Record<string, unknown> | undefined;
  if (!existing) return null;

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.sort_order !== undefined) {
    setClauses.push("sort_order = ?");
    values.push(updates.sort_order);
  }
  if (updates.name !== undefined) {
    setClauses.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push("description = ?");
    values.push(updates.description);
  }
  if (updates.exit_criteria !== undefined) {
    setClauses.push("exit_criteria = ?");
    values.push(JSON.stringify(updates.exit_criteria));
  }
  if (updates.failure_policy !== undefined) {
    setClauses.push("failure_policy = ?");
    values.push(JSON.stringify(updates.failure_policy));
  }
  if (updates.agent_config !== undefined) {
    setClauses.push("agent_config = ?");
    values.push(JSON.stringify(updates.agent_config));
  }
  if (updates.is_conditional !== undefined) {
    setClauses.push("is_conditional = ?");
    values.push(updates.is_conditional ? 1 : 0);
  }
  if (updates.condition !== undefined) {
    setClauses.push("condition = ?");
    values.push(updates.condition ? JSON.stringify(updates.condition) : null);
  }

  if (setClauses.length > 0) {
    values.push(stepId);
    db.prepare(
      `UPDATE workflow_steps SET ${setClauses.join(", ")} WHERE id = ?`,
    ).run(...values);
  }

  const updated = db
    .prepare("SELECT * FROM workflow_steps WHERE id = ?")
    .get(stepId) as Record<string, unknown>;
  return rowToStep(updated);
}

export function removeStep(stepId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
  return result.changes > 0;
}

export function reorderSteps(workflowId: string, stepIds: string[]): void {
  const db = getDb();
  const reorder = db.transaction(() => {
    const stmt = db.prepare(
      "UPDATE workflow_steps SET sort_order = ? WHERE id = ? AND workflow_id = ?",
    );
    for (let i = 0; i < stepIds.length; i++) {
      stmt.run(i, stepIds[i], workflowId);
    }
  });
  reorder();
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export function publishVersion(workflowId: string): WorkflowVersion {
  const db = getDb();
  const publish = db.transaction(() => {
    const steps = getSteps(workflowId);
    const snapshot = JSON.stringify(steps);

    const maxRow = db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS max_version FROM workflow_versions WHERE workflow_id = ?",
      )
      .get(workflowId) as { max_version: number };
    const nextVersion = maxRow.max_version + 1;

    db.prepare(
      "UPDATE workflow_versions SET is_active = 0 WHERE workflow_id = ? AND is_active = 1",
    ).run(workflowId);

    const id = randomUUID();
    const now = Date.now();

    db.prepare(
      `INSERT INTO workflow_versions (id, workflow_id, version, is_active, created_at, snapshot)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(id, workflowId, nextVersion, now, snapshot);

    return {
      id,
      workflow_id: workflowId,
      version: nextVersion,
      is_active: true,
      created_at: now,
      snapshot: steps,
    } satisfies WorkflowVersion;
  });

  return publish();
}

export function getVersions(workflowId: string): WorkflowVersion[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version")
    .all(workflowId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as string,
    workflow_id: row.workflow_id as string,
    version: row.version as number,
    is_active: (row.is_active as number) === 1,
    created_at: row.created_at as number,
    snapshot: JSON.parse(row.snapshot as string) as WorkflowStep[],
  }));
}

export function getVersion(
  workflowId: string,
  version: number,
): WorkflowVersion | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?",
    )
    .get(workflowId, version) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: row.id as string,
    workflow_id: row.workflow_id as string,
    version: row.version as number,
    is_active: (row.is_active as number) === 1,
    created_at: row.created_at as number,
    snapshot: JSON.parse(row.snapshot as string) as WorkflowStep[],
  };
}

export function getActiveSnapshot(
  workflowId: string,
): { steps: WorkflowStep[]; versionId: string; version: number } | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM workflow_versions WHERE workflow_id = ? AND is_active = 1",
    )
    .get(workflowId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    steps: JSON.parse(row.snapshot as string) as WorkflowStep[],
    versionId: row.id as string,
    version: row.version as number,
  };
}

export function restoreVersion(workflowId: string, version: number): void {
  const db = getDb();
  const restore = db.transaction(() => {
    const ver = getVersion(workflowId, version);
    if (!ver) throw new Error(`Version ${version} not found for workflow ${workflowId}`);

    db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(workflowId);

    const stmt = db.prepare(
      `INSERT INTO workflow_steps
         (id, workflow_id, sort_order, name, description, exit_criteria, failure_policy, agent_config, is_conditional, condition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const step of ver.snapshot) {
      stmt.run(
        randomUUID(),
        workflowId,
        step.sort_order,
        step.name,
        step.description,
        JSON.stringify(step.exit_criteria),
        JSON.stringify(step.failure_policy),
        JSON.stringify(step.agent_config),
        step.is_conditional ? 1 : 0,
        step.condition ? JSON.stringify(step.condition) : null,
      );
    }
  });
  restore();
}

// ---------------------------------------------------------------------------
// Seed default workflow
// ---------------------------------------------------------------------------

function seedDefaultWorkflow(): void {
  const db = cachedDb!;
  const existing = db
    .prepare("SELECT id FROM workflows WHERE id = ?")
    .get("default-sdlc");
  if (existing) return;

  const now = Date.now();
  db.prepare(
    "INSERT INTO workflows (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("default-sdlc", "Default SDLC", "Standard software development lifecycle workflow", now, now);

  const insertStep = db.prepare(
    `INSERT INTO workflow_steps
       (id, workflow_id, sort_order, name, description, exit_criteria, failure_policy, agent_config, is_conditional, condition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  insertStep.run(
    randomUUID(),
    "default-sdlc",
    0,
    "Implementation",
    "Each agent must implement their assigned sub-feature, write tests for their changes, and verify tests pass. Create a PR with a clear description of changes.",
    JSON.stringify({
      programmatic: ["all_tasks_complete"],
      description: "All implementation agents have committed, tested, and created PRs",
    }),
    JSON.stringify({
      action: "spawn_doctor",
      max_retries: 2,
      description: "Spawn a diagnostic agent to investigate and fix the failure",
    }),
    JSON.stringify({
      skill: "developer",
      model_tier: "primary",
      per_task_testing: true,
    }),
    0,
    null,
  );

  insertStep.run(
    randomUUID(),
    "default-sdlc",
    1,
    "Integration Test",
    "Merge all implementation branches together and run the full test suite. Verify that all features work together without conflicts. Fix any merge conflicts or integration issues.",
    JSON.stringify({
      programmatic: ["all_tasks_complete", "tests_pass"],
      description: "All branches merged cleanly and full test suite passes",
    }),
    JSON.stringify({
      action: "fail_plan",
      description: "Integration failure requires human review",
    }),
    JSON.stringify({
      skill: "testing",
      model_tier: "testing",
    }),
    0,
    null,
  );

  insertStep.run(
    randomUUID(),
    "default-sdlc",
    2,
    "Verify Build",
    "Run a final production build and full test suite. Verify no regressions. Generate a summary of all changes, PRs merged, and test results. Clean up any temporary resources.",
    JSON.stringify({
      programmatic: ["all_tasks_complete"],
      description: "Production build succeeds and all tests pass",
    }),
    JSON.stringify({
      action: "fail_plan",
      description: "Build verification failure requires human review",
    }),
    JSON.stringify({
      skill: "testing",
      model_tier: "testing",
    }),
    0,
    null,
  );

  // Publish version 1 — inline to avoid re-entering getDb()
  const steps = db
    .prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY sort_order")
    .all("default-sdlc") as Record<string, unknown>[];
  const parsedSteps = steps.map(rowToStep);
  const snapshot = JSON.stringify(parsedSteps);

  db.prepare(
    `INSERT INTO workflow_versions (id, workflow_id, version, is_active, created_at, snapshot)
     VALUES (?, ?, 1, 1, ?, ?)`,
  ).run(randomUUID(), "default-sdlc", now, snapshot);
}
