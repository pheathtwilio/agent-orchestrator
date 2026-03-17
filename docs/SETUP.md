# Development Environment Setup

This guide walks you through setting up a complete development environment for Agent Orchestrator.

## Prerequisites

Before you begin, ensure you have the following installed:

### Required

- **Node.js** 20.0.0 or higher
  - Check version: `node --version`
  - Download from [nodejs.org](https://nodejs.org/) or use [nvm](https://github.com/nvm-sh/nvm)

- **pnpm** 9.15.4 or higher
  - Install globally: `npm install -g pnpm@9.15.4`
  - Check version: `pnpm --version`

- **Git** 2.25 or higher
  - Check version: `git --version`
  - Required for worktree support and branch management

- **Redis** 7.x
  - Required for message bus and session state management
  - Can be run via Docker (recommended) or installed locally

### Optional but Recommended

- **Docker** and **Docker Compose**
  - Required for Docker runtime plugin and containerized Redis
  - Check versions: `docker --version` and `docker compose version`

- **GitHub CLI** (`gh`)
  - Required for GitHub integration (SCM and tracker plugins)
  - Install: see [cli.github.com](https://cli.github.com/)
  - Authenticate: `gh auth login`

- **tmux**
  - Required for default tmux runtime plugin
  - Install via package manager: `apt-get install tmux` or `brew install tmux`
  - Check version: `tmux -V`

## Quick Setup

For a fast automated setup, run the provided setup script:

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
bash scripts/setup.sh
```

This script will check prerequisites, install dependencies, build packages, and link the CLI.

## Manual Setup

### 1. Clone the Repository

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
```

### 2. Install Dependencies

This is a pnpm workspace monorepo. Install all package dependencies:

```bash
pnpm install
```

The postinstall script will automatically rebuild native dependencies (node-pty) for your platform.

### 3. Build All Packages

Build all packages in the monorepo in dependency order:

```bash
pnpm build
```

This compiles TypeScript and prepares all packages including:
- `@composio/ao-core` - Core orchestration logic
- `@composio/ao-cli` - Command-line interface
- `@composio/ao-web` - Web dashboard
- `@composio/ao-message-bus` - Redis-based messaging
- Plugin packages (runtimes, agents, trackers, notifiers, etc.)

### 4. Link the CLI Globally

Make the `ao` command available globally:

```bash
cd packages/cli
npm link
```

Verify the installation:

```bash
ao --version
```

## Redis Setup

Agent Orchestrator uses Redis for the message bus and session coordination.

### Option A: Docker Compose (Recommended)

Start Redis and other infrastructure services:

```bash
cd docker
docker compose up -d
```

This starts:
- Redis 7-alpine on port 6379 with persistence enabled
- Health checks configured
- Runs in the `ao-network` bridge network

Verify Redis is running:

```bash
docker compose ps
docker exec ao-redis redis-cli ping
# Should return: PONG
```

Stop services:

```bash
docker compose down
```

### Option B: Local Redis Installation

**macOS (Homebrew):**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

**Verify connection:**
```bash
redis-cli ping
# Should return: PONG
```

## Docker Build Steps

Build the agent container images for Docker runtime plugin:

### Build Base Agent Image

```bash
docker build -f docker/Dockerfile.agent -t ao-agent:latest .
```

This image includes:
- Node.js 20 runtime
- Git, GitHub CLI, AWS CLI
- Claude Code CLI
- Redis client (ioredis) for sidecar communication
- Agent user with appropriate permissions

### Build Frontend Image (Optional)

For containerized web dashboard:

```bash
docker build -f docker/Dockerfile.frontend -t ao-frontend:latest .
```

### Verify Images

```bash
docker images | grep ao-
```

## Environment Configuration

### Core Configuration

Create `agent-orchestrator.yaml` in your project directories or use the global config:

```bash
cp agent-orchestrator.yaml.example agent-orchestrator.yaml
```

Edit with your settings (port, defaults, projects, reactions).

### API Keys and Authentication

Set up authentication for AI agents:

**Option 1: Anthropic API Key**
```bash
export ANTHROPIC_API_KEY="your-api-key-here"
```

**Option 2: AWS Bedrock (SSO)**
```bash
export CLAUDE_CODE_USE_BEDROCK=1
# Ensure ~/.aws credentials are configured
aws sso login --profile your-profile
```

**GitHub Authentication (for tracker/SCM plugins):**
```bash
gh auth login
```

### Environment Variables

Optional environment variables can be set in your shell profile:

```bash
# Redis connection
export REDIS_URL="redis://localhost:6379"

# Web dashboard port
export PORT=3000

# Enable debug logging
export DEBUG=ao:*
```

## Verification

### Run Tests

Run the full test suite (3,288+ test cases):

```bash
pnpm test
```

Run integration tests:

```bash
pnpm test:integration
```

### Type Checking

Verify TypeScript compilation across all packages:

```bash
pnpm typecheck
```

### Linting

Check code style:

```bash
pnpm lint
```

Auto-fix issues:

```bash
pnpm lint:fix
```

### Start Development Server

Run the web dashboard in development mode:

```bash
pnpm dev
```

Opens at `http://localhost:3000` with hot reload enabled.

### Verify CLI

Test the CLI commands:

```bash
ao doctor                    # Check installation and dependencies
ao status                    # View session overview
ao --help                    # Show available commands
```

## Troubleshooting

### pnpm Command Not Found

Ensure pnpm is installed globally:
```bash
npm install -g pnpm@9.15.4
```

### Redis Connection Failed

Check if Redis is running:
```bash
# Docker
docker compose ps

# Local
redis-cli ping
```

Verify Redis URL in your configuration matches your setup.

### Docker Build Fails

Ensure Docker daemon is running:
```bash
docker info
```

Check available disk space - Docker builds require several GB.

### node-pty Build Errors

The postinstall script rebuilds node-pty for your platform. If it fails:
```bash
cd node_modules/node-pty
npm run install
```

### Permission Errors with Global CLI

On some systems, npm link may require sudo:
```bash
cd packages/cli
sudo npm link
```

Or configure npm to use a user-writable directory:
```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

### tmux Not Available

The default runtime plugin requires tmux. Install it:
```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux

# Or switch to process runtime in config
```

## Next Steps

- Read [docs/DEVELOPMENT.md](DEVELOPMENT.md) for architecture and code conventions
- Check [docs/ARCHITECTURE.md](ARCHITECTURE.md) for system design details
- See [examples/](../examples/) for configuration templates
- Run `ao init --auto` in a project directory to start orchestrating

## Additional Resources

- **Quick Start**: See README.md for `ao start` one-liner
- **CLI Reference**: Run `ao --help` for command documentation
- **Configuration**: See `agent-orchestrator.yaml.example` for full schema
- **Plugin Development**: Check CONTRIBUTING.md for plugin patterns
- **Troubleshooting**: See TROUBLESHOOTING.md for common issues
