import type { SecurityTrigger, WebhookSecurityEvent } from "./security-trigger.js";

// ============================================================================
// SECURITY WEBHOOK PARSER
// Converts raw GitHub webhook payloads into WebhookSecurityEvent objects
// ============================================================================

export interface WebhookPayload {
  action: string;
  [key: string]: unknown;
}

/**
 * Parse a GitHub webhook payload into a WebhookSecurityEvent.
 * Returns null if the event type is not security-related.
 */
export function parseGitHubWebhook(
  eventType: string,
  payload: WebhookPayload,
  projectId: string,
): WebhookSecurityEvent | null {
  switch (eventType) {
    case "check_run": {
      const checkRun = payload.check_run as Record<string, unknown> | undefined;
      if (!checkRun) return null;
      return {
        type: "check_run",
        projectId,
        action: payload.action,
        name: checkRun.name as string | undefined,
        conclusion: checkRun.conclusion as string | undefined,
        branch: (checkRun.head_branch as string) ?? undefined,
      };
    }

    case "check_suite": {
      const checkSuite = payload.check_suite as Record<string, unknown> | undefined;
      if (!checkSuite) return null;
      return {
        type: "check_suite",
        projectId,
        action: payload.action,
        name: "check_suite",
        conclusion: checkSuite.conclusion as string | undefined,
        branch: (checkSuite.head_branch as string) ?? undefined,
      };
    }

    case "dependabot_alert": {
      const alert = payload.alert as Record<string, unknown> | undefined;
      const dep = alert?.dependency as Record<string, unknown> | undefined;
      const vuln = (alert?.security_vulnerability ?? alert?.security_advisory) as Record<string, unknown> | undefined;
      return {
        type: "dependabot_alert",
        projectId,
        action: payload.action,
        alertSeverity: (vuln?.severity as string) ?? undefined,
        alertPackage: (dep?.package as Record<string, unknown>)?.name as string ?? undefined,
        alertCve: (vuln?.cve_id as string) ?? (alert?.ghsa_id as string) ?? undefined,
      };
    }

    case "code_scanning_alert": {
      const alert = payload.alert as Record<string, unknown> | undefined;
      const rule = alert?.rule as Record<string, unknown> | undefined;
      return {
        type: "code_scanning_alert",
        projectId,
        action: payload.action,
        alertSeverity: (rule?.severity as string) ?? (rule?.security_severity_level as string) ?? undefined,
        details: (rule?.description as string) ?? undefined,
      };
    }

    default:
      return null;
  }
}

/**
 * Handle a raw GitHub webhook: parse + dispatch to security trigger.
 * Returns the session ID if an agent was spawned, null otherwise.
 */
export async function handleSecurityWebhook(
  trigger: SecurityTrigger,
  eventType: string,
  payload: WebhookPayload,
  projectId: string,
): Promise<string | null> {
  const event = parseGitHubWebhook(eventType, payload, projectId);
  if (!event) return null;
  return trigger.handleWebhookEvent(event);
}
