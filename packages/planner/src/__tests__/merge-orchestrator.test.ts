import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFeaturePR, type MergeInput } from "../merge-orchestrator.js";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

describe("merge-orchestrator", () => {
  const baseInput: MergeInput = {
    planId: "plan-abc12345",
    featureDescription: "Add user authentication with OAuth2",
    repo: "org/my-app",
    repoPath: "/tmp/test-repo",
    taskBranches: [
      "feat/plan-abc12345/task-1",
      "feat/plan-abc12345/task-2",
      "feat/plan-abc12345/task-3",
    ],
    integrationBranch: "test/plan-abc12345/integration",
  };

  function setupMock(handler: (cmd: string, args: string[]) => string) {
    mockExecFile.mockImplementation(((
      cmd: string,
      args: string[],
      opts: unknown,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      try {
        const stdout = handler(cmd, args);
        callback(null, { stdout, stderr: "" });
      } catch (err) {
        callback(err as Error, { stdout: "", stderr: "" });
      }
    }) as typeof execFile);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupMock(() => "");
  });

  it("creates a PR from integration branch when available", async () => {
    setupMock((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr") {
        return "https://github.com/org/my-app/pull/42";
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "--list") {
        return "test/plan-abc12345/integration";
      }
      return "";
    });

    const result = await createFeaturePR(baseInput);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/org/my-app/pull/42");
    expect(result.featureBranch).toBe("feat/plan-abc12345");
  });

  it("merges task branches when no integration branch", async () => {
    const input = { ...baseInput, integrationBranch: null };

    setupMock((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr") {
        return "https://github.com/org/my-app/pull/43";
      }
      return "";
    });

    const result = await createFeaturePR(input);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/org/my-app/pull/43");
  });

  it("cleans up branches by default", async () => {
    setupMock((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr") {
        return "https://github.com/org/my-app/pull/44";
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "--list") {
        return "test/plan-abc12345/integration";
      }
      return "";
    });

    const result = await createFeaturePR(baseInput);

    expect(result.success).toBe(true);
    expect(result.cleanedBranches.length).toBeGreaterThan(0);
  });

  it("skips cleanup when configured", async () => {
    setupMock((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr") {
        return "https://github.com/org/my-app/pull/45";
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "--list") {
        return "test/plan-abc12345/integration";
      }
      return "";
    });

    const result = await createFeaturePR(baseInput, {
      cleanupBranches: false,
      cleanupTestBranch: false,
    });

    expect(result.success).toBe(true);
    expect(result.cleanedBranches).toEqual([]);
  });

  it("creates draft PR when configured", async () => {
    let capturedPrArgs: string[] = [];

    setupMock((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr") {
        capturedPrArgs = args;
        return "https://github.com/org/my-app/pull/46";
      }
      if (cmd === "git" && args[0] === "branch" && args[1] === "--list") {
        return "test/plan-abc12345/integration";
      }
      return "";
    });

    await createFeaturePR(baseInput, { draft: true });

    expect(capturedPrArgs).toContain("--draft");
  });

  it("returns error on failure", async () => {
    setupMock((cmd, args) => {
      if (cmd === "git" && args[0] === "fetch") {
        throw new Error("network error");
      }
      return "";
    });

    const result = await createFeaturePR(baseInput);

    expect(result.success).toBe(false);
    expect(result.error).toContain("network error");
  });
});
