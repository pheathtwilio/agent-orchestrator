#!/bin/bash
set -e

echo "=== Agent Orchestrator — Agent Container ==="
echo ""

# Detect auth mode
if [ "$CLAUDE_CODE_USE_BEDROCK" = "1" ]; then
    echo "Auth mode: AWS Bedrock (SSO)"

    if [ ! -f "$HOME/.aws/config" ] && [ ! -f "/home/agent/.aws/config" ]; then
        echo "ERROR: AWS config not found. Mount ~/.aws from host with:"
        echo "  -v \$HOME/.aws:/home/agent/.aws:ro"
        exit 1
    fi

    # Check SSO session (non-fatal — Claude SDK reads tokens directly)
    AWS_PROFILE="${AWS_PROFILE:-twilio-devex-bedrock}"
    if aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null 2>&1; then
        echo "  AWS SSO session: valid"
    else
        echo "  AWS SSO session: could not verify (CLI check failed)"
        echo "  Claude SDK will attempt to read SSO tokens directly."
        echo "  If auth fails, run on the host: aws sso login --profile $AWS_PROFILE"
    fi

    echo "  AWS Profile: $AWS_PROFILE"
    echo "  AWS Region: ${AWS_REGION:-us-west-2}"

elif [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "Auth mode: API key"
    echo "  Key: ${ANTHROPIC_API_KEY:0:10}..."

else
    echo "ERROR: No auth configured. Set one of:"
    echo "  1. ANTHROPIC_API_KEY=sk-ant-..."
    echo "  2. CLAUDE_CODE_USE_BEDROCK=1 + mount ~/.aws"
    exit 1
fi

echo ""
echo "Environment:"
echo "  User: $(whoami)"
echo "  Claude: $(claude --version 2>/dev/null || echo 'not found')"
echo "  Working dir: $(pwd)"
echo "  Session ID: ${AO_SESSION_ID:-none}"
echo "  Skill: ${AO_SKILL:-none}"
echo "  Model: ${AO_MODEL:-default}"
echo ""

# Initialize .claude directory
mkdir -p "$HOME/.claude/projects" 2>/dev/null || true

# ── GitHub auth ──
# If GH_TOKEN is set, configure gh CLI and git credential helper so agents
# can push branches and create PRs. Also rewrite SSH remotes to HTTPS so
# the token-based auth works transparently with worktree remotes.
if [ -n "$GH_TOKEN" ]; then
    echo "GitHub: token configured (${GH_TOKEN:0:7}...)"

    # Authenticate gh CLI
    echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null || true

    # Set gh as git credential helper (fills username/password for HTTPS)
    gh auth setup-git 2>/dev/null || true

    # Rewrite SSH URLs to HTTPS so token auth works with cloned worktrees
    git config --global url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true

    # Set git identity for commits
    git config --global user.name "ao-agent" 2>/dev/null || true
    git config --global user.email "ao-agent@users.noreply.github.com" 2>/dev/null || true
else
    echo "GitHub: no token (push/PR disabled)"
fi

echo ""

# Execute command or drop to shell
if [ $# -eq 0 ]; then
    exec bash
elif [ -n "$AO_PLAN_ID" ]; then
    # Planner mode: wrap the agent command with the sidecar
    # The sidecar handles Redis heartbeats, inbox watching, and completion reporting
    echo "Sidecar mode: plan=$AO_PLAN_ID task=$AO_TASK_ID"
    exec node /usr/local/bin/ao-sidecar.mjs "$@"
else
    exec "$@"
fi
