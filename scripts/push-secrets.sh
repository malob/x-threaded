#!/usr/bin/env bash
# Push local config from .env up to the deployed Worker as secrets.
#
# Use after rotating a credential: update .env (e.g. `op inject`), run this,
# and the deployment matches. Values are piped to wrangler, never passed as
# arguments, so they stay out of the process list and shell history.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -e .env ]] || { echo "No .env file — copy .env.example and fill it in." >&2; exit 1; }

# Names worth pushing; anything empty or absent in .env is skipped, so this
# is safe to run on a deployment that only uses some of them.
NAMES=(
  X_BEARER_TOKEN
  X_OAUTH_CLIENT_ID
  X_OAUTH_CLIENT_SECRET
  POLICY_AUD
  TEAM_DOMAIN
)

set -a
if [[ -p .env ]]; then
  # Named pipe (1Password and similar): read once, then evaluate.
  eval "$(timeout 15 cat .env)"
else
  # shellcheck disable=SC1091
  source .env
fi
set +a

pushed=0
for name in "${NAMES[@]}"; do
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "skip   $name (not set in .env)"
    continue
  fi
  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1 &&
    echo "pushed $name" && pushed=$((pushed + 1)) ||
    echo "FAILED $name" >&2
done

echo "$pushed secret(s) updated. Redeploy is not needed — secrets apply immediately."
