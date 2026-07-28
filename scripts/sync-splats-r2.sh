#!/usr/bin/env bash
# Upload assets/splats/** to R2 with keys splats/<relative-path>.
# Requires: wrangler login (or CLOUDFLARE_API_TOKEN), R2_BUCKET env.
# Usage: R2_BUCKET=changan pnpm run sync:splats:r2  (tras wrangler login o con CLOUDFLARE_API_TOKEN)
set -euo pipefail
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -t 1 ]; then
  echo "Error: no TTY and CLOUDFLARE_API_TOKEN unset — run in Terminal or set the token."
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${R2_BUCKET:-spark-viewer-splats}"
SPLATS="$ROOT/assets/splats"
if [[ ! -d "$SPLATS" ]]; then
  echo "Missing $SPLATS"
  exit 1
fi
cd "$ROOT"
count=0
while IFS= read -r -d '' f; do
  rel="${f#"$SPLATS/"}"
  key="splats/${rel}"
  # Wrangler 4.x: single positional path {bucket}/{key}
  echo "[$((++count))] r2 put $BUCKET/$key"
  pnpm --filter viewer exec wrangler r2 object put "$BUCKET/$key" --file="$f" --remote
done < <(find "$SPLATS" -type f ! -name '.DS_Store' -print0)
echo "Done. $count objects uploaded to bucket $BUCKET."
