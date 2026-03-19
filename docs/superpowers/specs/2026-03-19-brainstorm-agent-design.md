# Brainstorm Agent — Pre-Plan Refinement Chat

## Summary

Add an interactive brainstorming step before plan decomposition. A chat modal in the dashboard lets the user refine a feature idea with an AI agent before submitting it as a plan. The brainstorming agent clarifies scope, understands the codebase, and proposes an architecture breakdown. The refined spec then feeds into the existing plan creation pipeline unchanged.

## Requirements

- Back-and-forth chat between user and brainstorming agent in a modal dialog
- Direct LLM calls from the Next.js server (no Docker container)
- Agent clarifies scope, understands codebase context, proposes architecture
- Agent periodically proposes a refined spec; user confirms when ready
- Conversation is ephemeral (React state); only the final spec is passed to plan creation
- Configurable agent persona via dropdown (skill files or built-in default)
- Existing direct plan creation path remains untouched

## Dependencies

**New package dependency:** `@anthropic-ai/sdk` must be added to `packages/web/package.json`. This is the Anthropic SDK for direct Claude API calls from the Next.js server.

**API key:** The brainstorm route requires `ANTHROPIC_API_KEY` (or `BEDROCK_*` credentials if using AWS Bedrock — follow the same pattern as the existing planner which uses the Anthropic SDK in `packages/planner/`). The route validates the key on first call and returns a clear 500 error if missing.

## Architecture

### Flow

```
User clicks "Brainstorm" in CreatePlanForm
  -> PlansDashboard opens BrainstormModal (via onBrainstorm callback)
  -> If description textarea had content, it becomes the first user message
  -> User selects agent from dropdown (default or skill-based)
  -> User types feature idea (or edits pre-filled message)
  -> POST /api/plans/brainstorm { project, agent, messages }
  -> Server loads system prompt (skill file or built-in default)
  -> Server appends auto-generated project context
  -> Server calls Claude streaming API
  -> Response streams back to modal
  -> After stream completes, client detects <spec> tags -> shows "Execute Plan" button
  -> User clicks "Execute Plan"
  -> POST /api/plans/create { project, description: specContent, ... }
  -> Existing pipeline: decompose -> classify -> spawn -> test -> verify
```

### No Changes to Downstream Pipeline

The brainstorm modal's output is a refined `description` string. It feeds into the exact same `POST /api/plans/create` endpoint. The entire downstream pipeline (decompose, classify, spawn, test, verify, cleanup) is untouched.

## API Design

### `POST /api/plans/brainstorm` — Streaming Chat

**Request:**
```typescript
{
  project: string;
  agent: string;    // "default" or skill filename (e.g. "architect")
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}
```

**Response:** `Content-Type: text/event-stream`
```
data: {"content": "Let me ask..."}\n\n
data: {"content": " a few questions"}\n\n
...
data: {"done": true}\n\n
```

A final `{"done": true}` event signals stream completion so the client knows when to run spec detection.

**Behavior:**
1. Validate `ANTHROPIC_API_KEY` is set; return 500 with clear message if missing
2. Load system prompt: check `docker/skills/brainstorm/{agent}.md`, fall back to built-in default
3. Gather project context (tech stack, directory structure, CLAUDE.md from target project)
4. Append project context to system prompt
5. Call Claude Sonnet streaming API with system prompt + conversation history
6. Stream text deltas back as SSE events
7. Send `{"done": true}` on stream completion
8. Context window management: keep the first user message (original idea) + system prompt, then a sliding window of the most recent 18 messages. This preserves the original feature idea while staying within token limits.

**Rate limiting:**
- Max 30 requests per minute per client (enforced via simple in-memory counter keyed by IP or session)
- Max 4096 output tokens per response (passed to the Claude API `max_tokens` parameter)

**Error handling:**
- Missing API key: return 500 `{ "error": "ANTHROPIC_API_KEY not configured" }`
- Streaming failure: send `data: {"error": "message"}\n\n`
- Invalid project: return 400
- Rate limit exceeded: return 429

### `GET /api/plans/brainstorm/agents` — List Available Agents

**Response:**
```typescript
{
  agents: Array<{
    id: string;       // "default" or filename without extension
    name: string;     // Display name (titlecased filename or "Default Brainstorm Agent")
    description?: string; // First line of the .md file if it starts with a comment
  }>;
}
```

**Behavior:**
1. Always include `{ id: "default", name: "Default Brainstorm Agent" }`
2. Glob `docker/skills/brainstorm/*.md`
3. For each file, extract filename as id, titlecase as name, first line as description

## System Prompt

### Built-in Default

```
You are a brainstorming agent for a software project. Your job is to help
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
- If the user's idea is too large, suggest breaking it into smaller plans
```

### Custom Agents

Any `.md` file placed in `docker/skills/brainstorm/` becomes a selectable agent. The file content is used as the system prompt verbatim. Project context is always appended under a `## Project Context (auto-generated)` heading regardless of which prompt is used.

## Project Context Injection

Appended to every system prompt (custom or default):

```
## Project Context (auto-generated)
Tech stack: next.js, react, drizzle-orm, redis, docker...
Directory structure:
  src/
    api/
    components/
    lib/
  docker/
  packages/
Project conventions:
  {contents of CLAUDE.md, truncated to 2000 chars}
```

**Gathered from the target project** (resolved via `config.projects[projectId].path` with `~` expansion):
1. `package.json` dependencies/devDependencies (package names only)
2. Shallow directory listing (depth 2, excluding node_modules/.git/dist/.next)
3. `CLAUDE.md` at target project root if present (not the orchestrator repo)

## UI Component: BrainstormModal

### Props
```typescript
interface BrainstormModalProps {
  open: boolean;
  onClose: () => void;
  project: string;
  skipTesting: boolean;
  maxConcurrency: number;
  initialDescription?: string;  // Pre-filled from CreatePlanForm textarea
  onPlanCreated: (planId: string) => void;
}
```

### State
```typescript
messages: Array<{ role: "user" | "assistant"; content: string }>
streaming: boolean
pendingSpec: string | null
selectedAgent: string  // "default" or skill id
agents: Array<{ id: string; name: string }>
creatingPlan: boolean  // true while POST /api/plans/create is in flight
```

### Layout
- Full-screen modal overlay with dark zinc theme (matches dashboard)
- Header: agent dropdown selector, close button
- Body: scrollable message list with user/assistant bubbles, markdown rendered
- Footer: text input + send button (disabled while streaming)
- When `pendingSpec` is set: styled spec card with "Refine Further" and "Execute Plan" buttons
- Keyboard: Enter to send, Escape to close

### Spec Detection
Regex on full assistant message content: `/<spec>([\s\S]*?)<\/spec>/`
**Runs only after the stream completes** (triggered by the `{"done": true}` event), not during streaming. This avoids partial matches and ensures the full spec is captured. Only the last `<spec>` block in a message is used. Raw spec text stored in `pendingSpec` and passed as `description` to plan creation.

### Streaming
- Uses `fetch` with `ReadableStream` reader
- `AbortController` cancels streaming on modal close
- Progressive update of assistant's current message in state

### Plan Creation
When the user clicks "Execute Plan":
1. Set `creatingPlan: true` (disables button, shows spinner)
2. `POST /api/plans/create` with spec content as description
3. On success: call `onPlanCreated(planId)` — modal closes, navigates to plan
4. On failure: show error in chat, set `creatingPlan: false`
5. If modal is closed while request is in flight: the plan still creates server-side. On next dashboard poll the new plan will appear in the plan list.

### Initial Description
If `initialDescription` is provided (from the CreatePlanForm textarea), it is pre-filled as the first message in the input field. The user can edit or send it as-is.

## Integration with Existing Components

### CreatePlanForm.tsx — Modified
Add `onBrainstorm` callback prop and a "Brainstorm" button:

```typescript
interface CreatePlanFormProps {
  projects: ProjectInfo[];
  onCreated: (planId: string) => void;
  onCancel: () => void;
  onBrainstorm: (config: { project: string; description: string; skipTesting: boolean; maxConcurrency: number }) => void;
}
```

```
[ Description textarea    ]
[ Project dropdown        ]
[ Skip testing | Max conc ]
[ Create Plan ] [ Brainstorm ]
```

"Create Plan" submits directly as before. "Brainstorm" calls `onBrainstorm` with the current form values. The parent (`PlansDashboard`) handles opening the modal.

### PlansDashboard.tsx — Modified
- Add `BrainstormModal` component mount
- Add `brainstormOpen` boolean state + `brainstormConfig` to hold form values
- Wire `onBrainstorm` from `CreatePlanForm` to open the modal
- Wire `onPlanCreated` to close modal and navigate to plan detail

## New Files
- `packages/web/src/app/api/plans/brainstorm/route.ts` — streaming chat endpoint
- `packages/web/src/app/api/plans/brainstorm/agents/route.ts` — list available agents
- `packages/web/src/components/plans/BrainstormModal.tsx` — chat modal UI
- `docker/skills/brainstorm/` (directory, initially empty — default agent is built-in)

## Modified Files
- `packages/web/package.json` — add `@anthropic-ai/sdk` dependency
- `packages/web/src/components/plans/CreatePlanForm.tsx` — add `onBrainstorm` prop and button
- `packages/web/src/components/PlansDashboard.tsx` — mount modal, manage open state

## Risk Assessment

**Low risk to existing functionality:**
- No changes to planner, plan-executor, message bus, task store, or any orchestration code
- The brainstorm modal is additive — direct plan creation still works unchanged
- The brainstorm API route is entirely new, no shared state with existing routes
- The only modified existing files are two UI components with minimal changes (adding a callback prop and mounting a modal)
- New `@anthropic-ai/sdk` dependency is server-side only, does not affect client bundle
