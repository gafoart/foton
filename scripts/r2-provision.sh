#!/usr/bin/env bash
# Create bucket (if missing), enable r2.dev public URL, apply CORS from config/r2-cors.json.
# Prerequisites:
#   - R2 enabled for the account: https://dash.cloudflare.com/ → R2 (accept terms / add payment if prompted)
#   - wrangler login   OR   export CLOUDFLARE_API_TOKEN=...
#
# Usage:
#   Terminal: wrangler login   then   R2_BUCKET=changan pnpm run r2:provision
#   CI/Cursor: export CLOUDFLARE_API_TOKEN=...   (Account → Workers R2 Storage → Edit)
#   https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
set -euo pipefail
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -t 1 ]; then
  echo "Error: no TTY and CLOUDFLARE_API_TOKEN unset — Wrangler will fail here."
  echo "Run in Terminal.app after \`wrangler login\`, or: export CLOUDFLARE_API_TOKEN='...'"
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${R2_BUCKET:-spark-viewer-splats}"
CORS_FILE="$ROOT/config/r2-cors.json"

cd "$ROOT"
WR="pnpm --filter viewer exec wrangler"

cf_auth_hint() {
  cat <<'EOF'

Wrangler hit a Cloudflare API auth error (often /memberships [10000]). Try, in order:
  1. Edit the API token: add User → User Details → Read (and User → Memberships → Read if offered).
  2. export CLOUDFLARE_ACCOUNT_ID='<Account ID>'  (right sidebar in dash.cloudflare.com, or the table printed by wrangler whoami)
  3. Or unset CLOUDFLARE_API_TOKEN and run wrangler login in Terminal.app (OAuth avoids many token edge cases).
  4. If you saw [10502] too many authentication failures, wait several minutes before retrying.

EOF
}

wr_r2() {
  if ! $WR "$@"; then
    cf_auth_hint
    exit 1
  fi
}

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "Tip: export CLOUDFLARE_ACCOUNT_ID='<id>' if Wrangler fails on /memberships (see wrangler whoami or Cloudflare dashboard)."
fi

# If Wrangler fails on /memberships, set User→User Details→Read on the token, and/or:
#   export CLOUDFLARE_ACCOUNT_ID=<Account ID from wrangler whoami>
echo "==> R2 bucket: $BUCKET"
if [ "${R2_SKIP_BUCKET_ENSURE:-0}" = "1" ]; then
  echo "    Skipping bucket list/create (R2_SKIP_BUCKET_ENSURE=1 — bucket already exists in dashboard)."
elif $WR r2 bucket info "$BUCKET" &>/dev/null; then
  echo "    Bucket already exists."
else
  echo "    Creating bucket (ignored if name is already taken)..."
  set +e
  CREATE_MSG=$($WR r2 bucket create "$BUCKET" 2>&1)
  CREATE_EC=$?
  set -e
  if ! $WR r2 bucket info "$BUCKET" &>/dev/null; then
    echo "$CREATE_MSG"
    echo ""
    echo "If the bucket already exists in the dashboard, re-run with:"
    echo "  R2_SKIP_BUCKET_ENSURE=1 R2_BUCKET=$BUCKET pnpm run r2:configure"
    echo "Or fix the token (User → User Details → Read) and optional CLOUDFLARE_ACCOUNT_ID."
    echo "ERROR: Bucket $BUCKET is missing and could not be created (exit $CREATE_EC)."
    exit 1
  fi
  if [ "$CREATE_EC" -ne 0 ]; then
    echo "    Create returned $CREATE_EC — bucket is present (e.g. already existed)."
  else
    echo "    Created."
  fi
fi

echo "==> Enabling public r2.dev URL..."
wr_r2 r2 bucket dev-url enable "$BUCKET"

echo "==> Applying CORS ($CORS_FILE)..."
wr_r2 r2 bucket cors set "$BUCKET" --file="$CORS_FILE"

echo "==> CORS rules (verify):"
$WR r2 bucket cors list "$BUCKET" || true

echo ""
echo "==> Public asset base (no trailing slash) — set as VITE_PUBLIC_ASSETS_BASE in Cloudflare Pages (Build):"
echo ""
wr_r2 r2 bucket dev-url get "$BUCKET"
echo ""
echo "    Objects are keyed as splats/<path>; the app requests {base}/splats/..."
echo "    If splats fail to load with COEP, see CLOUDFLARE.md (CORP / Transform Rules)."
echo ""
