import { describe, expect, it } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";

describe("generateOrchestratorPrompt", () => {
  it("explicitly forbids direct code work and self-owned PRs", () => {
    const prompt = generateOrchestratorPrompt({
      config: {
        configPath: "/tmp/agent-orchestrator.yaml",
        readyThresholdMs: 300_000,
        defaults: {
          runtime: "tmux",
          agent: "opencode",
          workspace: "worktree",
          notifiers: ["desktop"],
        },
        projects: {
          "my-app": {
            name: "My App",
            repo: "org/my-app",
            path: "/tmp/my-app",
            defaultBranch: "main",
            sessionPrefix: "app",
          },
        },
        notifiers: {},
        notificationRouting: {
          urgent: [],
          action: [],
          warning: [],
          info: [],
        },
        reactions: {},
      },
      projectId: "my-app",
      project: {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    });

    expect(prompt).toContain("Never implement fixes directly in the repository.");
    expect(prompt).toContain("Never claim or attach a PR to the orchestrator session itself.");
    expect(prompt).toContain("you must delegate any code changes to a worker session");
  });
});
