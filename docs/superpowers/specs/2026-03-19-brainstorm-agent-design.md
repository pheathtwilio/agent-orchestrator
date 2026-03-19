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

## Architecture

### Flow

```
User clicks "Brainstorm" in CreatePlanForm
  -> BrainstormModal opens
  -> User selects agent from dropdown (default or skill-based)
  -> User types feature idea
  -> POST /api/plans/brainstorm { project, agent, messages }
  -> Server loads system prompt (skill file or built-in default)
  -> Server appends auto-generated project context
  -> Server calls Claude streaming API
  -> Response streams back to modal
  -> Client detects <spec> tags -> shows "Execute Plan" button
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
```

**Behavior:**
1. Load system prompt: check `docker/skills/brainstorm/{agent}.md`, fall back to built-in default
2. Gather project context (tech stack, directory structure, CLAUDE.md)
3. Append project context to system prompt
4. Call Claude Sonnet streaming API with system prompt + conversation history
5. Stream text deltas back as SSE events
6. Truncate older messages if conversation exceeds 20 messages (safety net)

**Error handling:**
- Streaming failure: send `data: {"error": "message"}\n\n`
- Invalid project: return 400

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

**Gathered from:**
1. `package.json` dependencies/devDependencies (package names only)
2. Shallow directory listing (depth 2, excluding node_modules/.git/dist/.next)
3. `CLAUDE.md` at project root if present

## UI Component: BrainstormModal

### Props
```typescript
interface BrainstormModalProps {
  open: boolean;
  onClose: () => void;
  project: string;
  skipTesting: boolean;
  maxConcurrency: number;
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
```

### Layout
- Full-screen modal overlay with dark zinc theme (matches dashboard)
- Header: agent dropdown selector, close button
- Body: scrollable message list with user/assistant bubbles
- Footer: text input + send button (disabled while streaming)
- When `pendingSpec` is set: styled spec card with "Refine Further" and "Execute Plan" buttons

### Spec Detection
Regex on full assistant message content: `/<spec>([\s\S]*?)<\/spec>/`
Only the last `<spec>` block in a message is used. Raw spec text stored in `pendingSpec` and passed as `description` to plan creation.

### Streaming
- Uses `fetch` with `ReadableStream` reader
- `AbortController` cancels on modal close
- Progressive update of assistant's current message in state

## Integration with Existing Components

### CreatePlanForm.tsx — Modified
Add a "Brainstorm" button next to the existing "Create Plan" button:
```
[ Description textarea    ]
[ Project dropdown        ]
[ Skip testing | Max conc ]
[ Create Plan ] [ Brainstorm ]
```

Both buttons use the same form values. "Create Plan" submits directly. "Brainstorm" opens the modal with form values as props.

### PlansDashboard.tsx — Modified
- Add `BrainstormModal` component mount
- Add `brainstormOpen` boolean state
- Pass callback to navigate to plan detail on creation

## New Files
- `packages/web/src/app/api/plans/brainstorm/route.ts`
- `packages/web/src/app/api/plans/brainstorm/agents/route.ts`
- `packages/web/src/components/plans/BrainstormModal.tsx`
- `docker/skills/brainstorm/` (directory, initially empty — default agent is built-in)

## Modified Files
- `packages/web/src/components/plans/CreatePlanForm.tsx` — add brainstorm button
- `packages/web/src/components/PlansDashboard.tsx` — mount modal, manage open state

## Risk Assessment

**Low risk to existing functionality:**
- No changes to planner, plan-executor, message bus, task store, or any orchestration code
- The brainstorm modal is additive — direct plan creation still works
- The brainstorm API route is entirely new, no shared state with existing routes
- The only modified existing files are two UI components with minimal changes (adding a button and mounting a modal)
