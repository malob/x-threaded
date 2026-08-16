#!/usr/bin/env bash
# Start the API server. Config comes from .env (see .env.example).
#
# Bun loads a regular .env automatically, but 1Password and similar tools can
# serve it as a named pipe, which Bun won't read — so load that case here and
# pass the values through the environment instead. Shell variables take
# precedence over .env in Bun, so this is safe either way.
set -euo pipefail
cd "$(dirname "$0")/.."

load_env_file() {
  local file="$1"
  [[ -e "$file" ]] || return 0
  if [[ -p "$file" ]]; then
    local content
    if ! content=$(scripts/read-fifo.sh "$file" 15 2>/dev/null); then
      echo "Could not read the .env named pipe; the server was not started." >&2
      exit 1
    fi
    set -a
    eval "$content"
    set +a
  fi
}

load_env_file .env

if [[ -z "${X_BEARER_TOKEN:-}" && ! -f .env ]]; then
  echo "No config found. Copy .env.example to .env and fill in X_BEARER_TOKEN." >&2
  exit 1
fi

exec bun --watch src/server/index.ts
