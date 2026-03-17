<h1 align="center">Agent Orchestrator — Multi-Agent Docker Orchestration for AI Coding</h1>

<p align="center">
  <img width="800" alt="Agent Orchestrator banner" src="docs/assets/agent_orchestrator_banner.png">
</p>

<div align="center">

Decompose features into parallel tasks, spawn specialized AI coding agents in Docker containers, and coordinate them via Redis — from a single CLI command.

[![GitHub stars](https://img.shields.io/github/stars/pheathtwilio/agent-orchestrator?style=flat-square)](https://github.com/pheathtwilio/agent-orchestrator/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## Overview

Agent Orchestrator manages fleets of AI coding agents running in isolated Docker containers. A **planner** decomposes a feature description into a task graph, assigns each task to a skill-specific agent (frontend, backend, security, etc.), and coordinates execution via a Redis message bus. When all tasks complete, the orchestrator merges branches and opens a consolidated PR.

**What's new in this release:**

- Docker-first runtime — each agent runs in its own container with isolated workspace
- Skill-based agent routing with purpose-built Docker images per skill
- Redis message bus for real-time agent-to-orchestrator communication
- `ao plan` command suite for multi-step feature orchestration
- Agent sidecar for heartbeats, inbox watching, and completion reporting
- Monitor loop for stuck/dead agent detection and recovery
- Security trigger with webhook integration
- Branch merge orchestration with consolidated PR creation

---

## How It Works

```
ao plan create "Add user authentication with OAuth2"
```

1. **Planner** calls Claude Opus to decompose the feature into a task graph
2. **Skill classifier** assigns each task a role (`frontend`, `backend`, `testing`, `security`, etc.) and model tier
3. **Docker runtime** spawns one container per task, each with its own git worktree and feature branch
4. **Agent sidecar** inside each container manages Redis heartbeats, prompt injection, and completion reporting
5. **Watch loop** monitors progress, detects stuck agents, and triggers per-task test agents
6. **Merge orchestrator** consolidates completed branches and opens a single integration PR
7. **Security trigger** optionally runs a security audit agent after implementation

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLI (ao plan create / watch / cancel / audit)          │
└────────────────────────┬────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Planner (Opus)    │  Decomposes feature → TaskGraph
              └──────────┬──────────┘
                         │  plan.json persisted to ~/.agent-orchestrator/
              ┌──────────▼──────────┐
              │   Message Bus       │  Redis Streams + pub/sub
              └──────────┬──────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼──────┐ ┌───────▼──────┐ ┌───────▼──────┐
│ Docker Agent │ │ Docker Agent │ │ Docker Agent │
│  (backend)   │ │  (frontend)  │ │  (testing)   │
│  + sidecar   │ │  + sidecar   │ │  + sidecar   │
└──────────────┘ └──────────────┘ └──────────────┘
        │                │                │
        └────────────────┼────────────────┘
                         │  TASK_COMPLETE / TASK_FAILED
              ┌──────────▼──────────┐
              │  Merge Orchestrator │  Consolidates branches → PR
              └─────────────────────┘
```

---

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 20+
- Git 2.25+
- `gh` CLI (GitHub integration)
- Redis (provided via `docker/docker-compose.yml`)

### Install

```bash
git clone https://github.com/pheathtwilio/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh
```

### Start supporting services

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts:
- **Redis** (`ao-redis`) — message bus backbone on `localhost:6379`

### Build Docker agent images

```bash
# Base agent image (required for all skills)
docker build -f docker/Dockerfile.agent -t ao-agent:latest .

# Optional: security agent (adds snyk + semgrep)
docker build -f docker/Dockerfile.security -t ao-agent-security:latest .
```

### Configure

```bash
cd ~/your-project && ao init --auto
```

Or create `agent-orchestrator.yaml` manually:

```yaml
port: 3000

defaults:
  runtime: docker
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: false
    action: notify
```

### Auth configuration

Agents support two auth modes, configured via environment variables:

**Option 1 — Anthropic API key:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Option 2 — AWS Bedrock (SSO):**
```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_PROFILE=your-bedrock-profile
export AWS_REGION=us-west-2
# Mount ~/.aws into containers (handled automatically by the runtime)
```

---

## Multi-Agent Planning (`ao plan`)

The `ao plan` command suite orchestrates multi-step feature implementation across specialized agents.

### Create a plan

```bash
ao plan create "Add OAuth2 login with Google and GitHub providers"
```

The planner decomposes the feature and prints a task table for review:

```
  Plan:    plan-a1b2c3
  Feature: Add OAuth2 login with Google and GitHub providers
  Phase:   review
  Tasks:   4
  Active:  0

  ID       Status         Skill        Title
  ──────────────────────────────────────────────────────
  task-1   pending        backend      OAuth2 callback routes
  task-2   pending        frontend     Login button and flow  <- [task-1]
  task-3   pending        testing      Integration tests      <- [task-1, task-2]
  task-4   pending        security     Security audit         <- [task-3]
```

### Execute a plan

```bash
ao plan create "..." --yes    # Skip approval prompt
```

Or approve interactively when prompted. Agents spawn in parallel respecting task dependencies.

### Watch progress

```bash
ao plan watch plan-a1b2c3
```

Streams live status updates, agent output, and phase transitions. Press `Ctrl+C` to detach (agents keep running).

### Cancel a plan

```bash
ao plan cancel plan-a1b2c3
```

Sends `ABORT` to all active containers and marks the plan as cancelled.

### Security audit

```bash
ao plan audit plan-a1b2c3
```

Manually triggers a security agent against the completed implementation.

### Skip integration testing

```bash
ao plan create "Update docs" --no-test
```

Skips the integration test phase (useful for docs-only or config changes).

---

## Skill System

Each task is assigned a skill that determines its Docker image, `CLAUDE.md` instructions, and tooling:

| Skill      | Docker Image          | Tooling                        |
| ---------- | --------------------- | ------------------------------ |
| backend    | `ao-agent:latest`     | Node.js, git, gh CLI           |
| frontend   | `ao-agent:latest`     | Node.js, git, gh CLI           |
| fullstack  | `ao-agent:latest`     | Node.js, git, gh CLI           |
| testing    | `ao-agent:latest`     | Node.js, git, gh CLI           |
| devops     | `ao-agent:latest`     | Node.js, AWS CLI, git, gh CLI  |
| database   | `ao-agent:latest`     | Node.js, git, gh CLI           |
| security   | `ao-agent-security`   | + snyk, semgrep, python3       |

Skill instructions live in `docker/skills/<skill>/CLAUDE.md` and are appended to the base agent rules at image build time.

---

## Agent Sidecar

Every Docker agent container runs a lightweight **sidecar** (`docker/scripts/sidecar.mjs`) alongside Claude Code. The sidecar:

- Publishes **heartbeats** to Redis every 15 seconds so the monitor knows the agent is alive
- Watches `/tmp/ao-inbox` for orchestrator messages (e.g. `ABORT`)
- Injects the task prompt via Claude's `-p` flag for one-shot execution
- Streams agent output to Redis pub/sub for real-time display in `ao plan watch`
- Reports `TASK_COMPLETE` or `TASK_FAILED` to the orchestrator when the agent exits, including branch name and recent commits

---

## Monitor

The watch loop runs a **monitor** that checks for stuck or dead agents:

- An agent is **stuck** if it stops sending heartbeats for > 5 minutes
- An agent is **dead** if its container has exited unexpectedly
- Stuck agents receive a nudge message; dead agents are marked `failed`

---

## Standard Agent Workflow (`ao spawn`)

For single-agent tasks (no planning required):

```bash
ao spawn my-project 123    # Spawn agent for GitHub issue #123
ao status                  # Overview of all sessions
ao send <session> "Fix the tests"
ao session ls
ao session kill <session>
ao session restore <session>
ao dashboard               # Open web dashboard at http://localhost:3000
```

---

## CLI Reference

```bash
# Plan orchestration
ao plan create "<feature>"  [--yes] [--no-test]
ao plan watch <plan-id>
ao plan cancel <plan-id>
ao plan audit <plan-id>

# Single-agent sessions
ao spawn <project> [issue]
ao send <session> "<message>"
ao status
ao session ls
ao session kill <session>
ao session restore <session>

# System
ao init [--auto]
ao start [repo-url]
ao dashboard
ao doctor [--fix]
ao update
```

---

## Plugin Architecture

Every abstraction is swappable via the plugin system:

| Slot      | Default     | Alternatives             |
| --------- | ----------- | ------------------------ |
| Runtime   | docker      | tmux, k8s, process       |
| Agent     | claude-code | codex, aider, opencode   |
| Workspace | worktree    | clone                    |
| Tracker   | github      | linear                   |
| SCM       | github      | —                        |
| Notifier  | desktop     | slack, composio, webhook |
| Terminal  | iterm2      | web                      |
| Lifecycle | core        | —                        |

All interfaces are defined in [`packages/core/src/types.ts`](packages/core/src/types.ts).

---

## Configuration Reference

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference.

Key planner defaults (overridable via env vars):

| Variable                        | Default                      | Description                        |
| ------------------------------- | ---------------------------- | ---------------------------------- |
| `ANTHROPIC_API_KEY`             | —                            | API key auth mode                  |
| `CLAUDE_CODE_USE_BEDROCK`       | —                            | Enable Bedrock auth mode           |
| `AWS_PROFILE`                   | `twilio-devex-bedrock`       | AWS profile for Bedrock            |
| `AWS_REGION`                    | `us-west-2`                  | AWS region for Bedrock             |
| `REDIS_URL`                     | `redis://ao-redis:6379`      | Redis connection string            |
| `GH_TOKEN`                      | —                            | GitHub token for push/PR           |
| `ANTHROPIC_MODEL_OPUS`          | `claude-opus-4-0-20250514`   | Override planning model            |
| `AO_MODEL`                      | —                            | Override agent model               |

---

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests
pnpm dev                       # Start web dashboard dev server
```

### Package structure

```
packages/
  cli/          — ao CLI commands including ao plan
  core/         — shared types, config loader, plugin interfaces
  planner/      — feature decomposition, task graph, monitor, merge orchestrator
  message-bus/  — Redis Streams wrapper, task store, file locks
  plugins/      — runtime, agent, workspace, tracker, notifier plugins
  web/          — dashboard web app
  integration-tests/ — end-to-end tests
docker/
  Dockerfile.agent    — base agent image
  Dockerfile.security — security agent image (extends base)
  Dockerfile.frontend — frontend agent image (extends base)
  docker-compose.yml  — Redis and supporting services
  scripts/
    entrypoint.sh     — auth detection and sidecar mode
    sidecar.mjs       — agent sidecar (heartbeats, inbox, completion)
  skills/             — per-skill CLAUDE.md instruction files
  config/             — Claude Code settings for containers
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for code conventions and architecture details.

---

## Documentation

| Doc                                      | What it covers                                               |
| ---------------------------------------- | ------------------------------------------------------------ |
| [Setup Guide](SETUP.md)                  | Detailed installation and configuration                      |
| [Architecture](ARCHITECTURE.md)          | Hash-based namespacing, session naming, directory layout     |
| [Examples](examples/)                    | Config templates (GitHub, Linear, multi-project, auto-merge) |
| [Development Guide](docs/DEVELOPMENT.md) | Architecture, conventions, plugin pattern                    |
| [Contributing](CONTRIBUTING.md)          | How to contribute, build plugins, PR process                 |
| [Troubleshooting](TROUBLESHOOTING.md)    | Common issues and fixes                                      |
| [Security](SECURITY.md)                  | Security policy and reporting                                |

---

## Contributing

Contributions welcome. The plugin system makes it straightforward to add support for new agents, runtimes, trackers, and notification channels. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Development Guide](docs/DEVELOPMENT.md).

## License

MIT
