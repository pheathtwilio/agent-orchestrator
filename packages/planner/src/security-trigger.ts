import type { MessageBus } from "@composio/ao-message-bus";
import { modelTierToId } from "./skill-classifier.js";
import type { AgentSkill } from "./types.js";

// ============================================================================
// SECURITY AGENT TRIGGER
//
// Spawns security agents in response to:
// 1. GitHub Actions webhook: check_run with security/scan conclusion
// 2. Orchestrator directive: explicit security audit request
// 3. Dependency alert: GitHub dependabot/security advisory events
// ============================================================================

export interface SecurityTriggerConfig {
  /** GitHub Actions check names that trigger security agent */
  checkNamePatterns: string[];
  /** Auto-spawn on dependency vulnerability alerts */
  autoOnDependencyAlert: boolean;
  /** Auto-spawn on code scanning alerts */
  autoOnCodeScanAlert: boolean;
}

export const DEFAULT_SECURITY_TRIGGER_CONFIG: SecurityTriggerConfig = {
  checkNamePatterns: [
    "security",
    "snyk",
    "semgrep",
    "codeql",
    "dependency-review",
    "audit",
  ],
  autoOnDependencyAlert: true,
  autoOnCodeScanAlert: true,
};

export interface SecurityTriggerDeps {
  messageBus: MessageBus;
  spawnSession: (params: {
    projectId: string;
    taskId: string;
    prompt: string;
    branch: string;
    model: string;
    skill: AgentSkill;
    dockerImage: string;
    environment: Record<string, string>;
  }) => Promise<string>;
}

export interface SecurityTrigger {
  /** Handle a GitHub webhook event and spawn security agent if needed */
  handleWebhookEvent(event: WebhookSecurityEvent): Promise<string | null>;
  /** Manually trigger a security audit for a project */
  triggerAudit(projectId: string, scope: string, branch?: string): Promise<string>;
}

export interface WebhookSecurityEvent {
  type: "check_run" | "check_suite" | "dependabot_alert" | "code_scanning_alert";
  projectId: string;
  action: string;
  name?: string;
  conclusion?: string;
  branch?: string;
  details?: string;
  alertSeverity?: string;
  alertPackage?: string;
  alertCve?: string;
}

export function createSecurityTrigger(
  deps: SecurityTriggerDeps,
  config: Partial<SecurityTriggerConfig> = {},
): SecurityTrigger {
  const cfg = { ...DEFAULT_SECURITY_TRIGGER_CONFIG, ...config };

  function matchesSecurityCheck(name: string): boolean {
    const lower = name.toLowerCase();
    return cfg.checkNamePatterns.some((pattern) => lower.includes(pattern));
  }

  function buildSecurityPrompt(event: WebhookSecurityEvent): string {
    const lines = [
      "# Security Audit Required",
      "",
    ];

    switch (event.type) {
      case "check_run":
      case "check_suite":
        lines.push(
          `A security check **${event.name ?? "unknown"}** has ${event.conclusion === "failure" ? "failed" : "triggered"}.`,
          "",
          "## Instructions",
          "1. Run `snyk test` to check dependency vulnerabilities",
          "2. Run `semgrep --config auto .` for static analysis",
          "3. Review the check output and fix any issues found",
          "4. Commit fixes and push",
        );
        break;

      case "dependabot_alert":
        lines.push(
          `## Dependency Vulnerability Alert`,
          "",
          `- **Package**: ${event.alertPackage ?? "unknown"}`,
          `- **Severity**: ${event.alertSeverity ?? "unknown"}`,
          `- **CVE**: ${event.alertCve ?? "N/A"}`,
          "",
          "## Instructions",
          "1. Update the vulnerable package to a patched version",
          "2. Run `snyk test` to verify the fix",
          "3. Run the test suite to ensure nothing breaks",
          "4. Commit the dependency update",
        );
        break;

      case "code_scanning_alert":
        lines.push(
          `## Code Scanning Alert`,
          "",
          `- **Severity**: ${event.alertSeverity ?? "unknown"}`,
          event.details ? `- **Details**: ${event.details}` : "",
          "",
          "## Instructions",
          "1. Review the code scanning alert",
          "2. Fix the vulnerability in the identified code",
          "3. Run `semgrep --config auto .` to verify the fix",
          "4. Run the test suite",
          "5. Commit the fix",
        );
        break;
    }

    return lines.filter(Boolean).join("\n");
  }

  return {
    async handleWebhookEvent(event: WebhookSecurityEvent): Promise<string | null> {
      let shouldSpawn = false;

      switch (event.type) {
        case "check_run":
        case "check_suite":
          if (event.name && matchesSecurityCheck(event.name)) {
            shouldSpawn = event.conclusion === "failure" || event.action === "requested";
          }
          break;

        case "dependabot_alert":
          shouldSpawn = cfg.autoOnDependencyAlert && event.action === "created";
          break;

        case "code_scanning_alert":
          shouldSpawn = cfg.autoOnCodeScanAlert && event.action === "created";
          break;
      }

      if (!shouldSpawn) return null;

      const taskId = `security-${event.type}-${Date.now()}`;
      const branch = event.branch ?? "main";
      const prompt = buildSecurityPrompt(event);

      const sessionId = await deps.spawnSession({
        projectId: event.projectId,
        taskId,
        prompt,
        branch: `fix/security/${taskId}`,
        model: modelTierToId("sonnet"),
        skill: "security",
        dockerImage: "ao-agent-security:latest",
        environment: {
          AO_TASK_ID: taskId,
          AO_SKILL: "security",
          AO_TRIGGER: event.type,
        },
      });

      await deps.messageBus.publish({
        type: "CONTEXT_UPDATE",
        from: "security-trigger",
        to: "orchestrator",
        payload: {
          event: "security_agent_spawned",
          sessionId,
          trigger: event.type,
          projectId: event.projectId,
        },
      });

      return sessionId;
    },

    async triggerAudit(projectId: string, scope: string, branch?: string): Promise<string> {
      const taskId = `security-audit-${Date.now()}`;

      const prompt = [
        "# Security Audit",
        "",
        `## Scope: ${scope}`,
        "",
        "## Instructions",
        "1. Run `snyk test` for dependency vulnerabilities",
        "2. Run `semgrep --config auto .` for static analysis",
        "3. Review code for OWASP Top 10 vulnerabilities",
        "4. Check for hardcoded secrets or credentials",
        "5. Review authentication and authorization logic",
        "6. Check input validation and output encoding",
        "7. Create a detailed report with findings and fixes",
        "8. Fix all critical and high severity issues",
        "9. Commit fixes and create a PR",
      ].join("\n");

      return deps.spawnSession({
        projectId,
        taskId,
        prompt,
        branch: branch ?? `fix/security-audit-${Date.now()}`,
        model: modelTierToId("sonnet"),
        skill: "security",
        dockerImage: "ao-agent-security:latest",
        environment: {
          AO_TASK_ID: taskId,
          AO_SKILL: "security",
          AO_TRIGGER: "manual-audit",
          AO_AUDIT_SCOPE: scope,
        },
      });
    },
  };
}
