#!/usr/bin/env bash
# Start the API server with X_BEARER_TOKEN sourced from the 1Password-served
# secrets file when not already set (same pattern as the 1MCP LaunchAgent).
set -euo pipefail
cd "$(dirname "$0")/.."

SECRETS_FILE="$HOME/.claude/secrets.env"
if [[ -z "${X_BEARER_TOKEN:-}" && -e "$SECRETS_FILE" ]]; then
  if [[ -p "$SECRETS_FILE" ]]; then
    content=$(timeout 15 cat "$SECRETS_FILE" 2>/dev/null || true)
    if [[ -n "$content" ]]; then
      set -a
      eval "$content"
      set +a
    fi
  else
    set -a
    # shellcheck disable=SC1090
    source "$SECRETS_FILE"
    set +a
  fi
fi

if [[ -z "${X_BEARER_TOKEN:-}" && ! -f .env ]]; then
  echo "X_BEARER_TOKEN is not set and no .env file exists." >&2
  echo "Either expose it via ~/.claude/secrets.env or copy .env.example to .env." >&2
  exit 1
fi

exec bun --watch src/server/index.ts
