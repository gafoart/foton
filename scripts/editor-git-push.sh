#!/usr/bin/env bash
# Used by the local editor dev server (POST /__deploy/github). Commits all tracked changes and pushes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not a git repository" >&2
  exit 1
fi

git add -A
if git diff --cached --quiet; then
  echo "EDITOR_GIT_NO_CHANGES"
  exit 0
fi

MSG="chore: sync scene from editor ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
git commit -m "$MSG"
git push origin HEAD
