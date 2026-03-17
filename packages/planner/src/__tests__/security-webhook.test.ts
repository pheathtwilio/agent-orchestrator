import { describe, it, expect } from "vitest";
import { parseGitHubWebhook } from "../security-webhook.js";

describe("parseGitHubWebhook", () => {
  it("parses check_run events", () => {
    const event = parseGitHubWebhook("check_run", {
      action: "completed",
      check_run: {
        name: "snyk-security-scan",
        conclusion: "failure",
        head_branch: "main",
      },
    }, "my-project");

    expect(event).toEqual({
      type: "check_run",
      projectId: "my-project",
      action: "completed",
      name: "snyk-security-scan",
      conclusion: "failure",
      branch: "main",
    });
  });

  it("parses dependabot_alert events", () => {
    const event = parseGitHubWebhook("dependabot_alert", {
      action: "created",
      alert: {
        dependency: {
          package: { name: "lodash" },
        },
        security_vulnerability: {
          severity: "high",
          cve_id: "CVE-2021-23337",
        },
      },
    }, "my-project");

    expect(event).toEqual({
      type: "dependabot_alert",
      projectId: "my-project",
      action: "created",
      alertSeverity: "high",
      alertPackage: "lodash",
      alertCve: "CVE-2021-23337",
    });
  });

  it("parses code_scanning_alert events", () => {
    const event = parseGitHubWebhook("code_scanning_alert", {
      action: "created",
      alert: {
        rule: {
          severity: "error",
          description: "SQL injection vulnerability",
        },
      },
    }, "my-project");

    expect(event).toEqual({
      type: "code_scanning_alert",
      projectId: "my-project",
      action: "created",
      alertSeverity: "error",
      details: "SQL injection vulnerability",
    });
  });

  it("returns null for unrelated event types", () => {
    expect(parseGitHubWebhook("push", { action: "created" }, "p")).toBeNull();
    expect(parseGitHubWebhook("pull_request", { action: "opened" }, "p")).toBeNull();
  });

  it("returns null for check_run with no check_run payload", () => {
    expect(parseGitHubWebhook("check_run", { action: "completed" }, "p")).toBeNull();
  });
});
