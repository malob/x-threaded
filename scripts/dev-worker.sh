#!/usr/bin/env bash
# Run the Cloudflare Worker locally (wrangler dev + local D1 simulation).
# Writes X_BEARER_TOKEN into .dev.vars (gitignored) from the environment or
# the 1Password-served secrets file, mirroring scripts/dev-server.sh.
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

if [[ -z "${X_BEARER_TOKEN:-}" ]]; then
  echo "X_BEARER_TOKEN is not set; expose it via ~/.claude/secrets.env or the environment." >&2
  exit 1
fi

# Subshell so the restrictive umask doesn't leak into wrangler (dirs created
# with mode 600 are untraversable and break miniflare's temp handling).
(umask 177 && printf 'X_BEARER_TOKEN=%s\n' "$X_BEARER_TOKEN" > .dev.vars)

exec npx wrangler dev --port "${WORKER_PORT:-8788}"
