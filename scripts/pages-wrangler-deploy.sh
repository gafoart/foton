#!/usr/bin/env bash
# Wrangler "pages deploy" needs git metadata; repos with no commits break `git rev-parse HEAD`.
# Usage (from repo root): bash scripts/pages-wrangler-deploy.sh <viewer|editor> <project-name>
#
# Production vs Preview (Cloudflare Pages):
# A direct upload is "Production" only when --branch matches the project's production_branch.
# Override branch label: PAGES_DEPLOY_BRANCH=my-branch
# Default branch label: config/cloudflare-pages-deploy-branch (this repo: main), else current git branch.
# Align production_branch on Cloudflare: export CLOUDFLARE_API_TOKEN (Pages:Edit). Account id is
# auto-filled from `wrangler whoami --json` when CLOUDFLARE_ACCOUNT_ID is unset.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${1:?first arg: viewer or editor}"
PROJECT="${2:?second arg: Pages project name}"
cd "$ROOT"

BRANCH_CFG="$ROOT/config/cloudflare-pages-deploy-branch"
if [ -n "${PAGES_DEPLOY_BRANCH:-}" ]; then
  BR="${PAGES_DEPLOY_BRANCH}"
elif [ -f "$BRANCH_CFG" ]; then
  BR="$(tr -d '[:space:]' <"$BRANCH_CFG" | head -c 200)"
  GIT_BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -n "$GIT_BR" ] && [ "$GIT_BR" != "HEAD" ] && [ "$GIT_BR" != "$BR" ]; then
    echo "pages-wrangler-deploy: using branch label '$BR' from config/cloudflare-pages-deploy-branch (git: $GIT_BR)." >&2
  fi
elif git rev-parse HEAD >/dev/null 2>&1; then
  BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
else
  BR=main
fi
if [ -z "${BR:-}" ] || [ "$BR" = "HEAD" ]; then
  BR=main
fi

if git rev-parse HEAD >/dev/null 2>&1; then
  HASH=$(git rev-parse HEAD)
  MSG=$(git log -1 --pretty=%B 2>/dev/null | head -c 500 | tr '\n\r' '  ' | sed 's/  */ /g' || true)
  MSG=${MSG:-pages deploy}
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    DIRTY=true
  else
    DIRTY=false
  fi
else
  HASH=0000000000000000000000000000000000000000
  MSG="pages deploy (no git commits in repo yet)"
  DIRTY=true
fi

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ]; then
  ACCOUNT_ID="$(
    pnpm --filter viewer exec wrangler whoami --json 2>/dev/null \
      | node -p "(()=>{try{const j=JSON.parse(require('fs').readFileSync(0,'utf8'));return(j.accounts&&j.accounts[0]&&j.accounts[0].id)||'';}catch(e){return'';}})()" 2>/dev/null \
      || true
  )"
fi

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "$ACCOUNT_ID" ]; then
  RESP="$(
    curl -sS -X PATCH \
      "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"production_branch\":\"${BR}\"}" || true
  )"
  if echo "$RESP" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    echo "pages-wrangler-deploy: Pages project '${PROJECT}' production_branch set to '${BR}'." >&2
  else
    echo "pages-wrangler-deploy: warning: could not PATCH production_branch to '${BR}' (token scope or project name). Deploy continues." >&2
    if [ -n "$RESP" ]; then
      echo "pages-wrangler-deploy: API response: ${RESP}" >&2
    fi
  fi
else
  echo "pages-wrangler-deploy: --branch '${BR}'. For Production environment (secrets/bindings), this must match the project's Production branch." >&2
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "pages-wrangler-deploy: hint: export CLOUDFLARE_API_TOKEN (Account → Cloudflare Pages → Edit) to auto-sync production_branch, or set Production branch to '${BR}' in the dashboard." >&2
  elif [ -z "$ACCOUNT_ID" ]; then
    echo "pages-wrangler-deploy: hint: set CLOUDFLARE_ACCOUNT_ID or run wrangler login so whoami can supply the account id." >&2
  fi
fi

# pnpm --filter viewer exec runs with cwd = apps/viewer, so --cwd must be absolute.
pnpm --filter viewer exec wrangler --cwd="${ROOT}/apps/${APP_DIR}" pages deploy dist \
  --project-name="${PROJECT}" \
  --branch="${BR}" \
  --commit-hash="${HASH}" \
  --commit-message="${MSG}" \
  --commit-dirty="${DIRTY}"
