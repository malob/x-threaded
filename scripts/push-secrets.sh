#!/usr/bin/env bash
# Push local config from .env up to the deployed Worker as secrets.
#
# Use after rotating a credential: update .env (e.g. `op inject`), run this,
# and the safe deployment-scoped values match. Values are piped to wrangler,
# never passed as arguments, so they stay out of the process list and shell
# history. ALLOW_UNGATED is deliberately never copied automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -e .env ]] || { echo "No .env file — copy .env.example and fill it in." >&2; exit 1; }

set -a
if [[ -p .env ]]; then
  # Named pipe (1Password and similar): read once, then evaluate.
  if ! content=$(scripts/read-fifo.sh .env 15); then
    echo "Could not read the .env named pipe; no secrets were pushed." >&2
    exit 1
  fi
  eval "$content"
else
  # shellcheck disable=SC1091
  source .env
fi
set +a

# Define the allowlist only after loading .env so a dotenv variable cannot
# replace this script's control data. Local-only ports/paths are excluded, as is
# ALLOW_UNGATED: disabling the deployment gate must stay a separate, explicit
# act. Anything empty or absent in .env is skipped.
readonly -a SECRET_NAMES=(
  X_BEARER_TOKEN
  X_OAUTH_CLIENT_ID
  X_OAUTH_CLIENT_SECRET
  POLICY_AUD
  TEAM_DOMAIN
  MAX_POSTS_PER_FETCH
)

pushed=0
failed=0
for name in "${SECRET_NAMES[@]}"; do
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "skip   $name (not set in .env)"
    continue
  fi
  if printf '%s' "$value" | bunx wrangler secret put "$name" >/dev/null; then
    echo "pushed $name"
    pushed=$((pushed + 1))
  else
    echo "FAILED $name" >&2
    failed=$((failed + 1))
  fi
done

if [[ -n "${ALLOW_UNGATED:-}" ]]; then
  echo "skip   ALLOW_UNGATED (must be pushed explicitly)"
fi

if ((failed > 0)); then
  echo "$pushed secret(s) updated; $failed failed." >&2
  exit 1
fi

if ((pushed == 0)); then
  echo "No configured secrets to update."
else
  echo "$pushed secret(s) updated. Redeploy is not needed — secrets apply immediately."
fi
