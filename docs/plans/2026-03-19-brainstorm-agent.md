# Brainstorm Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-plan brainstorming chat modal that lets users refine feature ideas with an AI agent before submitting to the plan decomposer.

**Architecture:** Stateless streaming chat API route using `createAnthropicClient()` from `@composio/ao-core` (already a dependency — no new packages needed). Configurable agent personas via markdown files in `docker/skills/brainstorm/`. BrainstormModal component mounts from PlansDashboard, feeds refined spec into existing `POST /api/plans/create`.

**Tech Stack:** Next.js API routes, Anthropic SDK (via ao-core), React, SSE streaming, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-19-brainstorm-agent-design.md`

---

### Task 1: Brainstorm Agents List API

**Files:**
- Create: `packages/web/src/app/api/plans/brainstorm/agents/route.ts`
- Create: `docker/skills/brainstorm/.gitkeep`

- [ ] **Step 1: Create the brainstorm skills directory**

```bash
mkdir -p docker/skills/brainstorm
touch docker/skills/brainstorm/.gitkeep
```

- [ ] **Step 2: Create the agents list API route**

Create `packages/web/src/app/api/plans/brainstorm/agents/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

export const dynamic = "force-dynamic";

const BRAINSTORM_SKILLS_DIR = join(process.cwd(), "../../docker/skills/brainstorm");

function titleCase(str: string): string {
  return str
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(): Promise<Response> {
  const agents: Array<{ id: string; name: string; description?: string }> = [
    { id: "default", name: "Default Brainstorm Agent" },
  ];

  try {
    const files = await readdir(BRAINSTORM_SKILLS_DIR);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const id = basename(file, ".md");
      const content = await readFile(join(BRAINSTORM_SKILLS_DIR, file), "utf-8");
      const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "").trim();
      agents.push({
        id,
        name: titleCase(id),
        description: firstLine || undefined,
      });
    }
  } catch {
    // Directory may not exist — return just the default
  }

  return NextResponse.json({ agents });
}
```

- [ ] **Step 3: Test manually**

Run: `curl http://localhost:3000/api/plans/brainstorm/agents`
Expected: `{"agents":[{"id":"default","name":"Default Brainstorm Agent"}]}`

- [ ] **Step 4: Commit**

```bash
git add docker/skills/brainstorm/.gitkeep packages/web/src/app/api/plans/brainstorm/agents/route.ts
git commit -m "feat: add brainstorm agents list API route"
```

---

### Task 2: Brainstorm Streaming Chat API

**Files:**
- Create: `packages/web/src/app/api/plans/brainstorm/route.ts`

This is the core streaming chat endpoint. Uses `createAnthropicClient()` from `@composio/ao-core` (already a web dependency) to avoid adding `@anthropic-ai/sdk` directly.

- [ ] **Step 1: Create the streaming chat route**

Create `packages/web/src/app/api/plans/brainstorm/route.ts`:

```typescript
import { createAnthropicClient } from "@composio/ao-core";
import { getServices } from "@/lib/services";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";

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
    const lines: string[] = ["## Project Context (auto-generated)"];

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

    // Shallow directory listing (depth 1)
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

    return lines.length > 1 ? "\n\n" + lines.join("\n") : "";
  } catch {
    return "";
  }
}

function trimMessages(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  if (messages.length <= 20) return messages;
  // Keep first message (original idea) + last 18
  return [messages[0], ...messages.slice(-18)];
}

export async function POST(request: Request): Promise<Response> {
  // Rate limiting
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

  // Build system prompt
  const basePrompt = await loadSystemPrompt(agent);
  const projectContext = await gatherProjectContext(project);
  const systemPrompt = basePrompt + projectContext;

  // Trim conversation if too long
  const trimmed = trimMessages(messages);

  // Resolve model
  const model =
    process.env.ANTHROPIC_MODEL_SONNET ??
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    "claude-sonnet-4-20250514";

  // Stream response
  const encoder = new TextEncoder();
  let streamClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        try {
          const client = createAnthropicClient();
          const response = await client.messages.create({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: trimmed.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
            stream: true,
          });

          for await (const event of response) {
            if (streamClosed) break;
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const chunk = `data: ${JSON.stringify({ content: event.delta.text })}\n\n`;
              controller.enqueue(encoder.encode(chunk));
            }
          }

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
```

- [ ] **Step 2: Test manually**

Run: `curl -X POST http://localhost:3000/api/plans/brainstorm -H "Content-Type: application/json" -d '{"project":"agent-orchestrator","agent":"default","messages":[{"role":"user","content":"I want to add a dark mode toggle"}]}'`
Expected: SSE stream of `data: {"content": "..."}` events followed by `data: {"done": true}`

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/app/api/plans/brainstorm/route.ts
git commit -m "feat: add brainstorm streaming chat API route"
```

---

### Task 3: BrainstormModal UI Component

**Files:**
- Create: `packages/web/src/components/plans/BrainstormModal.tsx`

- [ ] **Step 1: Create the BrainstormModal component**

Create `packages/web/src/components/plans/BrainstormModal.tsx`:

```typescript
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/cn";

interface BrainstormModalProps {
  open: boolean;
  onClose: () => void;
  project: string;
  skipTesting: boolean;
  maxConcurrency: number;
  initialDescription?: string;
  onPlanCreated: (planId: string) => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export function BrainstormModal({
  open,
  onClose,
  project,
  skipTesting,
  maxConcurrency,
  initialDescription,
  onPlanCreated,
}: BrainstormModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialDescription ?? "");
  const [streaming, setStreaming] = useState(false);
  const [pendingSpec, setPendingSpec] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState("default");
  const [agents, setAgents] = useState<AgentOption[]>([{ id: "default", name: "Default Brainstorm Agent" }]);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fetch available agents on mount
  useEffect(() => {
    if (!open) return;
    fetch("/api/plans/brainstorm/agents")
      .then((r) => r.json())
      .then((data) => {
        if (data.agents) setAgents(data.agents);
      })
      .catch(() => {});
  }, [open]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setMessages([]);
      setPendingSpec(null);
      setError(null);
      setInput(initialDescription ?? "");
      setCreatingPlan(false);
    }
  }, [open, initialDescription]);

  // Cleanup abort on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creatingPlan) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, creatingPlan, onClose]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setStreaming(true);
    setPendingSpec(null);
    setError(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/plans/brainstorm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          agent: selectedAgent,
          messages: updatedMessages,
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        setError(data.error ?? "Request failed");
        setStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response stream");
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) {
              assistantContent += data.content;
              setMessages([...updatedMessages, { role: "assistant", content: assistantContent }]);
            }
            if (data.done) {
              // Spec detection after stream completes
              const specMatch = assistantContent.match(/<spec>([\s\S]*?)<\/spec>/);
              if (specMatch) {
                setPendingSpec(specMatch[1].trim());
              }
            }
            if (data.error) {
              setError(data.error);
            }
          } catch {
            // Ignore parse errors on partial chunks
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Connection failed");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, messages, streaming, project, selectedAgent]);

  const handleExecutePlan = useCallback(async () => {
    if (!pendingSpec || creatingPlan) return;
    setCreatingPlan(true);
    setError(null);

    try {
      const res = await fetch("/api/plans/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          description: pendingSpec,
          skipTesting,
          maxConcurrency,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create plan");
        setCreatingPlan(false);
        return;
      }

      onPlanCreated(data.planId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setCreatingPlan(false);
    }
  }, [pendingSpec, creatingPlan, project, skipTesting, maxConcurrency, onPlanCreated]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-zinc-200">Brainstorm</h2>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-300 focus:border-cyan-600 focus:outline-none"
            disabled={streaming}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={onClose}
          disabled={creatingPlan}
          className="text-zinc-500 hover:text-zinc-300 transition-colors text-xl leading-none"
        >
          &times;
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-zinc-600 text-sm py-12">
            Describe your feature idea and the brainstorming agent will help you refine it into an actionable spec.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[80%] rounded-lg px-4 py-3 text-sm leading-relaxed",
              msg.role === "user"
                ? "ml-auto bg-cyan-900/40 border border-cyan-800/40 text-zinc-200"
                : "mr-auto bg-zinc-900 border border-zinc-800 text-zinc-300",
            )}
          >
            <div className="whitespace-pre-wrap break-words">{msg.content}</div>
          </div>
        ))}
        {streaming && (
          <div className="text-xs text-cyan-500/60 animate-pulse">Agent is thinking...</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Spec card */}
      {pendingSpec && (
        <div className="mx-6 mb-4 p-4 rounded-lg border border-green-800/50 bg-green-950/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-green-400 uppercase tracking-wider">Spec Ready</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingSpec(null)}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-200 border border-zinc-700 transition-colors"
              >
                Refine Further
              </button>
              <button
                onClick={handleExecutePlan}
                disabled={creatingPlan}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  creatingPlan
                    ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                    : "bg-cyan-600 text-white hover:bg-cyan-500",
                )}
              >
                {creatingPlan ? "Creating Plan..." : "Execute Plan"}
              </button>
            </div>
          </div>
          <div className="text-xs text-green-300/80 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
            {pendingSpec}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-6 mb-2 text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded p-2">
          {error}
        </div>
      )}

      {/* Input */}
      <div className="px-6 py-4 border-t border-zinc-800">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Describe your feature idea..."
            rows={2}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/30 resize-none"
            disabled={streaming || creatingPlan}
          />
          <button
            onClick={sendMessage}
            disabled={streaming || !input.trim() || creatingPlan}
            className={cn(
              "px-4 py-2 rounded-md text-xs font-medium transition-colors self-end",
              streaming || !input.trim() || creatingPlan
                ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                : "bg-cyan-600 text-white hover:bg-cyan-500",
            )}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/plans/BrainstormModal.tsx
git commit -m "feat: add BrainstormModal chat component"
```

---

### Task 4: Wire Up CreatePlanForm and PlansDashboard

**Files:**
- Modify: `packages/web/src/components/plans/CreatePlanForm.tsx`
- Modify: `packages/web/src/components/PlansDashboard.tsx`

- [ ] **Step 1: Add onBrainstorm prop to CreatePlanForm**

In `packages/web/src/components/plans/CreatePlanForm.tsx`:

Add `onBrainstorm` to the props interface:
```typescript
interface CreatePlanFormProps {
  projects: ProjectInfo[];
  onCreated: (planId: string) => void;
  onCancel: () => void;
  onBrainstorm: (config: { project: string; description: string; skipTesting: boolean; maxConcurrency: number }) => void;
}
```

Add it to the destructured props:
```typescript
export const CreatePlanForm = memo(function CreatePlanForm({
  projects,
  onCreated,
  onCancel,
  onBrainstorm,
}: CreatePlanFormProps) {
```

Add a "Brainstorm" button next to "Create Plan" in the actions div (after the Cancel button):
```typescript
<button
  type="button"
  onClick={() => onBrainstorm({ project, description, skipTesting, maxConcurrency })}
  disabled={submitting || !project}
  className={cn(
    "px-4 py-2 rounded-md text-xs font-medium transition-colors",
    submitting || !project
      ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
      : "bg-purple-600 text-white hover:bg-purple-500",
  )}
>
  Brainstorm
</button>
```

- [ ] **Step 2: Wire BrainstormModal in PlansDashboard**

In `packages/web/src/components/PlansDashboard.tsx`:

Add import:
```typescript
import { BrainstormModal } from "./plans/BrainstormModal";
```

Add state after existing `showCreateForm` state (around line 126):
```typescript
const [brainstormConfig, setBrainstormConfig] = useState<{
  project: string;
  description: string;
  skipTesting: boolean;
  maxConcurrency: number;
} | null>(null);
```

Add `onBrainstorm` prop to the existing `CreatePlanForm` mount (around line 348):
```typescript
<CreatePlanForm
  projects={projects}
  onCreated={(planId) => {
    setShowCreateForm(false);
    setSelectedPlanId(planId);
    fetchPlans();
  }}
  onCancel={() => setShowCreateForm(false)}
  onBrainstorm={(config) => {
    setShowCreateForm(false);
    setBrainstormConfig(config);
  }}
/>
```

Add the BrainstormModal mount after the create plan modal (after line 359):
```typescript
{brainstormConfig && (
  <BrainstormModal
    open={!!brainstormConfig}
    onClose={() => setBrainstormConfig(null)}
    project={brainstormConfig.project}
    skipTesting={brainstormConfig.skipTesting}
    maxConcurrency={brainstormConfig.maxConcurrency}
    initialDescription={brainstormConfig.description}
    onPlanCreated={(planId) => {
      setBrainstormConfig(null);
      setSelectedPlanId(planId);
      fetchPlans();
    }}
  />
)}
```

- [ ] **Step 3: Test the full flow**

1. Open dashboard, click "+ New Plan"
2. Type a description, click "Brainstorm" → modal opens
3. Chat with agent → agent proposes `<spec>` → "Execute Plan" button appears
4. Click "Execute Plan" → plan created, navigated to plan detail
5. Also verify: "Create Plan" still works as before (direct submission)

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/plans/CreatePlanForm.tsx packages/web/src/components/PlansDashboard.tsx
git commit -m "feat: wire brainstorm modal into plan creation flow"
```

---

### Task 5: Add serverExternalPackages and Build Verification

**Files:**
- Possibly modify: `packages/web/next.config.js` (if build issues arise)

- [ ] **Step 1: Build the project**

```bash
cd packages/web && rm -rf .next && npx next build
```

If there are module resolution errors related to the Anthropic SDK or ao-core imports in the new route, add any problematic packages to `serverExternalPackages` in `next.config.js`.

- [ ] **Step 2: Test in dev mode**

```bash
npx next dev
```

Navigate to the dashboard, open brainstorm modal, verify streaming works end-to-end.

- [ ] **Step 3: Commit any build fixes**

```bash
git add -A && git commit -m "fix: build config for brainstorm route"
```

- [ ] **Step 4: Final commit — push**

```bash
git push
```
