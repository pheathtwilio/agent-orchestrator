import Anthropic from "@anthropic-ai/sdk";
import { getServices } from "@/lib/services";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

const BRAINSTORM_SKILLS_DIR = join(process.cwd(), "../../docker/skills/brainstorm");

// Simple in-memory rate limiter: max 30 requests/minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

const DEFAULT_SYSTEM_PROMPT = `You are a brainstorming agent for a software project. Your job is to help
the user refine a feature idea into a detailed, actionable specification
that can be decomposed into implementation tasks.

## Your Process
1. Ask clarifying questions about scope, requirements, and edge cases
2. Understand constraints and acceptance criteria
3. Propose a rough architecture breakdown showing which areas of the
   codebase will be affected and how components interact
4. When you believe the spec is complete, present it inside <spec> tags

## Spec Format
When proposing a spec, wrap it in <spec> tags:
<spec>
Title: ...
Description: ...
Architecture: ...
Key decisions: ...
Acceptance criteria: ...
</spec>

After presenting a spec, ask if the user wants to refine further or proceed
with plan creation.

## Guidelines
- Ask one question at a time
- Reference the project's existing patterns and tech stack when relevant
- Be opinionated — suggest approaches rather than listing all options
- Keep the spec actionable — it will be fed directly into a task decomposer
- If the user's idea is too large, suggest breaking it into smaller plans`;

async function loadSystemPrompt(agentId: string): Promise<string> {
  if (agentId === "default") return DEFAULT_SYSTEM_PROMPT;
  try {
    const filePath = join(BRAINSTORM_SKILLS_DIR, `${agentId}.md`);
    return await readFile(filePath, "utf-8");
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

async function gatherProjectContext(projectId: string): Promise<string> {
  try {
    const { config } = await getServices();
    const project = config.projects[projectId];
    if (!project) return "";

    const repoPath = project.path.replace(/^~/, process.env.HOME || "");
    const lines: string[] = ["\n\n## Project Context (auto-generated)"];

    // Tech stack from package.json
    try {
      const pkgRaw = await readFile(join(repoPath, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw);
      const deps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      if (deps.length > 0) {
        lines.push(`Tech stack: ${deps.slice(0, 30).join(", ")}`);
      }
    } catch { /* no package.json */ }

    // Shallow directory listing
    try {
      const entries = await readdir(repoPath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !["node_modules", ".git", "dist", ".next", ".turbo"].includes(e.name))
        .map((e) => e.name);
      if (dirs.length > 0) {
        lines.push(`Directory structure: ${dirs.join(", ")}`);
      }
    } catch { /* can't read dir */ }

    // CLAUDE.md from target project
    try {
      const claudeMd = await readFile(join(repoPath, "CLAUDE.md"), "utf-8");
      lines.push(`Project conventions:\n${claudeMd.slice(0, 2000)}`);
    } catch { /* no CLAUDE.md */ }

    return lines.length > 1 ? lines.join("\n") : "";
  } catch {
    return "";
  }
}

function trimMessages(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  if (messages.length <= 20) return messages;
  return [messages[0], ...messages.slice(-18)];
}

export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { project?: string; agent?: string; messages?: Array<{ role: string; content: string }> };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { project, agent = "default", messages = [] } = body;
  if (!project) {
    return new Response(JSON.stringify({ error: "project is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const basePrompt = await loadSystemPrompt(agent);
  const projectContext = await gatherProjectContext(project);
  const systemPrompt = basePrompt + projectContext;

  const trimmed = trimMessages(messages);

  const model =
    process.env.ANTHROPIC_MODEL_SONNET ??
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    "claude-sonnet-4-20250514";

  const encoder = new TextEncoder();
  let streamClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        try {
          const client = new Anthropic();
          const stream = client.messages.stream({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: trimmed.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
          });

          stream.on("text", (text) => {
            if (streamClosed) return;
            const chunk = `data: ${JSON.stringify({ content: text })}\n\n`;
            controller.enqueue(encoder.encode(chunk));
          });

          await stream.finalMessage();

          if (!streamClosed) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
            controller.close();
          }
        } catch (err) {
          if (!streamClosed) {
            const msg = err instanceof Error ? err.message : "Streaming failed";
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
            controller.close();
          }
        }
      })();
    },
    cancel() {
      streamClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
