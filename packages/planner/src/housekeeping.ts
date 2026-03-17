import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore, TaskGraph } from "@composio/ao-message-bus";

const execFileAsync = promisify(execFile);

// ============================================================================
// HOUSEKEEPING
// Cleans up stopped containers, stale worktrees, orphan branches, and old plans
// ============================================================================

export interface CleanupResult {
  containers: string[];
  worktrees: string[];
  branches: { local: string[]; remote: string[] };
  plans: string[];
  errors: string[];
}

export interface CleanupConfig {
  /** Remove stopped ao-* containers */
  containers: boolean;
  /** Remove stale git worktrees */
  worktrees: boolean;
  /** Remove orphan plan branches (local + remote) */
  branches: boolean;
  /** Remove completed/cancelled/failed plans older than this (ms). 0 = don't remove */
  maxPlanAgeMs: number;
  /** Dry run — report what would be cleaned without doing it */
  dryRun: boolean;
}

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  containers: true,
  worktrees: true,
  branches: true,
  maxPlanAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  dryRun: false,
};

async function exec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 30_000,
      ...opts,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Find stopped ao-* containers */
async function findStoppedContainers(): Promise<string[]> {
  const output = await exec("docker", [
    "ps", "-a", "--filter", "status=exited",
    "--filter", "name=ao-", "--format", "{{.Names}}",
  ]);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/** Remove stopped containers */
async function removeContainers(names: string[]): Promise<void> {
  if (names.length === 0) return;
  await exec("docker", ["rm", ...names]);
}

/** Find stale worktrees (those with missing or locked gitdir) */
async function findStaleWorktrees(repoPath: string): Promise<string[]> {
  const output = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
  if (!output) return [];

  const stale: string[] = [];
  const entries = output.split("\n\n");

  for (const entry of entries) {
    const lines = entry.split("\n");
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    const prunable = lines.some((l) => l === "prunable");

    if (worktreeLine && prunable) {
      stale.push(worktreeLine.replace("worktree ", ""));
    }
  }

  return stale;
}

/** Find ao-* worktrees (from agent sessions) */
async function findAoWorktrees(repoPath: string): Promise<{ path: string; branch: string }[]> {
  const output = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
  if (!output) return [];

  const results: { path: string; branch: string }[] = [];
  const entries = output.split("\n\n");

  for (const entry of entries) {
    const lines = entry.split("\n");
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));

    if (worktreeLine) {
      const path = worktreeLine.replace("worktree ", "");
      // Only include ao worktrees (session worktrees)
      if (path.includes("/ao-") || path.includes("/.worktrees/")) {
        const branch = branchLine?.replace("branch refs/heads/", "") ?? "";
        results.push({ path, branch });
      }
    }
  }

  return results;
}

/** Find plan branches (feat/plan-*, test/plan-*) */
async function findPlanBranches(
  repoPath: string,
): Promise<{ local: string[]; remote: string[] }> {
  const localOutput = await exec("git", ["branch", "--list", "feat/plan-*", "test/plan-*"], { cwd: repoPath });
  const remoteOutput = await exec("git", ["branch", "-r", "--list", "origin/feat/plan-*", "origin/test/plan-*"], { cwd: repoPath });

  const local = localOutput
    ? localOutput.split("\n").map((b) => b.trim().replace(/^\* /, "")).filter(Boolean)
    : [];
  const remote = remoteOutput
    ? remoteOutput.split("\n").map((b) => b.trim()).filter(Boolean)
    : [];

  return { local, remote };
}

/** Extract plan ID from a branch name */
function extractPlanId(branch: string): string | null {
  const match = branch.match(/plan-[a-f0-9]+/);
  return match ? match[0] : null;
}

export async function cleanup(
  repoPath: string,
  taskStore: TaskStore,
  config: Partial<CleanupConfig> = {},
): Promise<CleanupResult> {
  const cfg = { ...DEFAULT_CLEANUP_CONFIG, ...config };
  const result: CleanupResult = {
    containers: [],
    worktrees: [],
    branches: { local: [], remote: [] },
    plans: [],
    errors: [],
  };

  // 1. Stopped containers
  if (cfg.containers) {
    const stopped = await findStoppedContainers();
    result.containers = stopped;
    if (!cfg.dryRun && stopped.length > 0) {
      try {
        await removeContainers(stopped);
      } catch (err) {
        result.errors.push(`Failed to remove containers: ${err}`);
      }
    }
  }

  // 2. Stale worktrees
  if (cfg.worktrees) {
    // First prune any that git already knows are broken
    if (!cfg.dryRun) {
      await exec("git", ["worktree", "prune"], { cwd: repoPath });
    }

    // Find remaining ao worktrees
    const aoWorktrees = await findAoWorktrees(repoPath);

    // Check which ones belong to completed/cancelled/failed plans
    const graphs = await taskStore.listGraphs();
    const terminalPlanIds = new Set(
      graphs
        .filter((g) => {
          const allComplete = g.nodes.every((n) => n.status === "complete");
          const hasFailed = g.nodes.some((n) => n.status === "failed");
          return allComplete || hasFailed;
        })
        .map((g) => g.id),
    );

    for (const wt of aoWorktrees) {
      const planId = extractPlanId(wt.branch);
      // Remove if: belongs to a terminal plan, or has no associated plan (orphaned)
      if (planId && (terminalPlanIds.has(planId) || !graphs.some((g) => g.id === planId))) {
        result.worktrees.push(wt.path);
        if (!cfg.dryRun) {
          try {
            await exec("git", ["worktree", "remove", "--force", wt.path], { cwd: repoPath });
          } catch (err) {
            result.errors.push(`Failed to remove worktree ${wt.path}: ${err}`);
          }
        }
      }
    }
  }

  // 3. Orphan branches
  if (cfg.branches) {
    await exec("git", ["fetch", "--prune", "origin"], { cwd: repoPath });
    const planBranches = await findPlanBranches(repoPath);

    // Get active plan IDs (plans that are still executing/testing/review)
    const graphs = await taskStore.listGraphs();
    const activePlanIds = new Set(
      graphs
        .filter((g) => {
          const hasActive = g.nodes.some(
            (n) => n.status === "in_progress" || n.status === "assigned" || n.status === "testing" || n.status === "pending",
          );
          return hasActive;
        })
        .map((g) => g.id),
    );

    // Remove local branches for non-active plans
    for (const branch of planBranches.local) {
      const planId = extractPlanId(branch);
      if (planId && !activePlanIds.has(planId)) {
        result.branches.local.push(branch);
        if (!cfg.dryRun) {
          try {
            await exec("git", ["branch", "-D", branch], { cwd: repoPath });
          } catch (err) {
            result.errors.push(`Failed to delete local branch ${branch}: ${err}`);
          }
        }
      }
    }

    // Remove remote branches for non-active plans
    for (const remoteBranch of planBranches.remote) {
      const planId = extractPlanId(remoteBranch);
      const shortName = remoteBranch.replace("origin/", "");
      if (planId && !activePlanIds.has(planId)) {
        result.branches.remote.push(shortName);
        if (!cfg.dryRun) {
          try {
            await exec("git", ["push", "origin", "--delete", shortName], { cwd: repoPath });
          } catch (err) {
            result.errors.push(`Failed to delete remote branch ${shortName}: ${err}`);
          }
        }
      }
    }
  }

  // 4. Old plans in Redis
  if (cfg.maxPlanAgeMs > 0) {
    const graphs = await taskStore.listGraphs();
    const cutoff = Date.now() - cfg.maxPlanAgeMs;

    for (const graph of graphs) {
      const isTerminal = graph.nodes.every((n) => n.status === "complete") ||
        graph.nodes.some((n) => n.status === "failed");

      if (isTerminal && graph.updatedAt < cutoff) {
        result.plans.push(graph.id);
        if (!cfg.dryRun) {
          try {
            await taskStore.deleteGraph(graph.id);
          } catch (err) {
            result.errors.push(`Failed to delete plan ${graph.id}: ${err}`);
          }
        }
      }
    }
  }

  return result;
}
