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

    # Check SSO session
    AWS_PROFILE="${AWS_PROFILE:-twilio-devex-bedrock}"
    if aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null; then
        echo "  AWS SSO session: valid"
    else
        echo "ERROR: AWS SSO session expired. On the host, run:"
        echo "  aws sso login --profile $AWS_PROFILE"
        exit 1
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

# Execute command or drop to shell
if [ $# -eq 0 ]; then
    exec bash
else
    exec "$@"
fi
