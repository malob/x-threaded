#!/usr/bin/env bash
# Run the Cloudflare Worker locally (wrangler dev + local D1 simulation).
#
# Config comes from .env, which wrangler reads natively — the same file the
# Bun server uses, so local dev has one config surface. (A .dev.vars file
# would silently suppress .env, so this script refuses to run with both.)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .dev.vars ]]; then
  echo "Both .dev.vars and .env would apply, and .dev.vars silently wins." >&2
  echo "Delete .dev.vars; put local config in .env (see .env.example)." >&2
  exit 1
fi

if [[ ! -e .env ]]; then
  echo "No .env file. Copy .env.example to .env and fill in X_BEARER_TOKEN." >&2
  exit 1
fi

# A .env served as a named pipe (1Password and similar) isn't readable by
# wrangler, so read it here and hand the values over via the process
# environment instead.
if [[ -p .env ]]; then
  content=$(timeout 15 cat .env 2>/dev/null || true)
  if [[ -n "$content" ]]; then
    set -a
    eval "$content"
    set +a
    export CLOUDFLARE_INCLUDE_PROCESS_ENV=true
  fi
fi

exec npx wrangler dev --port "${WORKER_PORT:-8788}"
