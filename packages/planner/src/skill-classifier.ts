import Anthropic from "@anthropic-ai/sdk";
import type { AgentSkill, ModelTier, ModelPolicy, TaskAssignment } from "./types.js";

// ============================================================================
// LLM-BASED SKILL + COMPLEXITY CLASSIFICATION
// ============================================================================

const CLASSIFY_SYSTEM = `You are a task classifier for a software project. Given a task description, determine:

1. **skill**: The primary skill needed. Choose ONE:
   - "frontend" — UI components, styling, client-side logic, browser APIs, Playwright tests
   - "backend" — API endpoints, server logic, middleware, auth, business logic
   - "fullstack" — tasks that require both frontend and backend changes
   - "testing" — writing/fixing tests, test infrastructure, coverage
   - "security" — vulnerability scanning, auth hardening, input validation, OWASP
   - "devops" — CI/CD, Docker, deployment, infrastructure, monitoring
   - "database" — schema changes, migrations, queries, indexing

2. **complexity**: How complex is this task? Choose ONE:
   - "high" — new architecture, complex algorithms, multi-system coordination
   - "medium" — standard feature work, moderate logic, clear scope
   - "low" — boilerplate, config changes, simple CRUD, copy-paste patterns

3. **fileBoundary**: List the file paths or glob patterns this task will likely touch.
   Be specific but not exhaustive. Use patterns like "src/components/**" or "src/api/routes.ts".

Respond with ONLY a JSON object:
{"skill": "...", "complexity": "...", "fileBoundary": ["..."]}`;

interface ClassificationResult {
  skill: AgentSkill;
  complexity: "high" | "medium" | "low";
  fileBoundary: string[];
}

export async function classifyTask(
  client: Anthropic,
  model: string,
  taskDescription: string,
  projectContext?: string,
): Promise<ClassificationResult> {
  const userContent = projectContext
    ? `Project context:\n${projectContext}\n\nTask:\n${taskDescription}`
    : `Task:\n${taskDescription}`;

  const res = await client.messages.create({
    model,
    max_tokens: 512,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });

  const text = res.content[0].type === "text" ? res.content[0].text.trim() : "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Fallback to safe defaults
    return { skill: "fullstack", complexity: "medium", fileBoundary: [] };
  }

  const parsed = JSON.parse(jsonMatch[0]) as Partial<ClassificationResult>;

  const validSkills: AgentSkill[] = [
    "frontend", "backend", "fullstack", "testing", "security", "devops", "database",
  ];
  const validComplexity = ["high", "medium", "low"] as const;

  return {
    skill: validSkills.includes(parsed.skill as AgentSkill)
      ? (parsed.skill as AgentSkill)
      : "fullstack",
    complexity: validComplexity.includes(parsed.complexity as "high" | "medium" | "low")
      ? (parsed.complexity as "high" | "medium" | "low")
      : "medium",
    fileBoundary: Array.isArray(parsed.fileBoundary) ? parsed.fileBoundary : [],
  };
}

/** Resolve the model tier for a task based on its skill and complexity */
export function resolveModel(
  skill: AgentSkill,
  complexity: "high" | "medium" | "low",
  policy: ModelPolicy,
): ModelTier {
  if (skill === "testing") return policy.testing;
  if (skill === "security") return policy.security;
  return policy.implementation[complexity];
}

/**
 * Map a model tier to an actual Anthropic model ID.
 *
 * Respects env var overrides:
 *   ANTHROPIC_MODEL_OPUS, ANTHROPIC_MODEL_SONNET, ANTHROPIC_MODEL_HAIKU
 *   (or Bedrock-style: ANTHROPIC_DEFAULT_OPUS_MODEL, etc.)
 */
export function modelTierToId(tier: ModelTier): string {
  switch (tier) {
    case "opus":
      return process.env.ANTHROPIC_MODEL_OPUS
        ?? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
        ?? "claude-opus-4-0-20250514";
    case "sonnet":
      return process.env.ANTHROPIC_MODEL_SONNET
        ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
        ?? "claude-sonnet-4-20250514";
    case "haiku":
      return process.env.ANTHROPIC_MODEL_HAIKU
        ?? process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        ?? "claude-haiku-4-5-20251001";
  }
}
