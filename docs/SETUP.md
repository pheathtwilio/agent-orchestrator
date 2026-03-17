# Development Environment Setup

This guide walks you through setting up the Agent Orchestrator development environment from scratch.

## Prerequisites

### Required Software

#### Node.js (>= 20.0.0)

Agent Orchestrator requires Node.js version 20 or higher. Check your current version:

```bash
node --version
```

**Install Node.js:**
- **macOS/Linux:** Use [nvm](https://github.com/nvm-sh/nvm)
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
  nvm install 20
  nvm use 20
  ```
- **Windows:** Download from [nodejs.org](https://nodejs.org/en/download/)
- **Alternative:** Use [fnm](https://github.com/Schniz/fnm) (faster than nvm)

#### pnpm (9.15.4+)

This project uses pnpm as its package manager. The exact version is specified in `package.json`:

```bash
# Install via corepack (recommended, comes with Node.js 16+)
corepack enable
corepack prepare pnpm@9.15.4 --activate

# Or install globally via npm
npm install -g pnpm@9.15.4
```

Verify installation:
```bash
pnpm --version
```

#### Git (>= 2.25)

Git 2.25 or higher is required for git worktree support (a core feature of the orchestrator).

Check your version:
```bash
git --version
```

**Install/Upgrade Git:**
- **macOS:** `brew install git`
- **Ubuntu/Debian:** `sudo apt update && sudo apt install git`
- **Windows:** Download from [git-scm.com](https://git-scm.com/downloads)

### Optional But Recommended

#### tmux

The default runtime plugin uses tmux for session management:

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Verify
tmux -V
```

#### GitHub CLI

Required for GitHub integration (creating PRs, fetching issues):

```bash
# macOS
brew install gh

# Ubuntu/Debian
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh

# Authenticate
gh auth login
```

#### Claude CLI

Required for the claude-code agent plugin:

```bash
npm install -g @anthropic-ai/claude-code
```

## Redis Setup

Agent Orchestrator uses Redis for the message bus and task coordination.

### Option 1: Docker Compose (Recommended)

The project includes a `docker-compose.yml` for Redis:

```bash
cd docker
docker-compose up -d
```

This starts:
- **Redis 7 (Alpine)** on port `6379`
- Persistent storage via Docker volume `redis-data`
- Automatic health checks

Verify Redis is running:
```bash
docker-compose ps
docker-compose logs redis
```

Stop Redis:
```bash
docker-compose down
```

### Option 2: Local Redis Installation

#### macOS
```bash
brew install redis
brew services start redis
```

#### Ubuntu/Debian
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

#### Verify
```bash
redis-cli ping
# Expected output: PONG
```

## Docker Setup

Docker is required for the runtime-docker plugin, which runs agents in isolated containers.

### Install Docker Desktop

- **macOS/Windows:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux:** [Docker Engine](https://docs.docker.com/engine/install/)

Verify installation:
```bash
docker --version
docker-compose --version
```

### Post-Installation (Linux)

Add your user to the docker group to run Docker without sudo:
```bash
sudo usermod -aG docker $USER
newgrp docker
```

Test Docker:
```bash
docker run hello-world
```

## Project Setup

### 1. Clone the Repository

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
```

### 2. Run the Setup Script

The automated setup script handles dependency installation, building, and CLI linking:

```bash
bash scripts/setup.sh
```

This script:
- Validates all prerequisites
- Installs pnpm if needed
- Installs all project dependencies
- Builds all packages in the monorepo
- Links the `ao` CLI globally

### 3. Manual Setup (Alternative)

If you prefer manual control:

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Link CLI globally
cd packages/cli
npm link
cd ../..
```

### 4. Verify Installation

```bash
# Check that 'ao' is available
ao --version

# Run health checks
ao doctor

# Run tests
pnpm test
```

## Development Workflow

### Build Commands

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @composio/ao-core build

# Clean build artifacts
pnpm clean

# Type check
pnpm typecheck
```

### Running Tests

```bash
# Run all tests (3,288+ test cases)
pnpm test

# Run integration tests
pnpm test:integration

# Watch mode for development
cd packages/core
pnpm test -- --watch
```

### Development Server

Start the web dashboard in development mode:

```bash
pnpm dev
# Dashboard runs at http://localhost:3000
```

### Linting and Formatting

```bash
# Lint code
pnpm lint

# Fix linting issues
pnpm lint:fix

# Format code
pnpm format

# Check formatting
pnpm format:check
```

## Common Issues

### 'ao' command not found

Add npm global bin to your PATH:
```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

Add this line to `~/.zshrc` or `~/.bashrc` to persist.

### Redis connection errors

Ensure Redis is running:
```bash
# Docker
docker-compose -f docker/docker-compose.yml ps

# Local Redis
redis-cli ping
```

### Port 6379 already in use

Stop existing Redis instances:
```bash
# Find process
lsof -i :6379

# Kill process
kill -9 <PID>
```

### Build failures

Clean and rebuild:
```bash
pnpm clean
rm -rf node_modules packages/*/node_modules
pnpm install
pnpm build
```

### node-pty rebuild issues

The postinstall script handles this automatically, but if needed:
```bash
node scripts/rebuild-node-pty.js
```

## Next Steps

1. **Initialize a project:**
   ```bash
   cd /path/to/your-project
   ao init --auto
   ```

2. **Start the orchestrator:**
   ```bash
   ao start
   ```

3. **Spawn your first agent:**
   ```bash
   ao spawn my-project 123
   ```

4. **Explore the documentation:**
   - [Architecture](ARCHITECTURE.md) - System design and plugin architecture
   - [Development Guide](DEVELOPMENT.md) - Code conventions and patterns
   - [Examples](../examples/) - Configuration templates

## Getting Help

- Run `ao doctor` for system diagnostics
- Run `ao doctor --fix` to apply automatic fixes
- Check [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) for common issues
- Join the [Discord community](https://discord.gg/UZv7JjxbwG)
