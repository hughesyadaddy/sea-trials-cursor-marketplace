#!/usr/bin/env bash
# Local parity for lint-migrations (self-test + strict lint).
# Ships in the sea-trials plugin; runs against the checkout in cwd.
set -euo pipefail

ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
BASE="${1:-origin/dev}"

cd "$ROOT/scripts/migration_lint"
npm ci --silent 2>/dev/null || npm install --silent
./node_modules/.bin/tsx src/main.test.ts
./node_modules/.bin/tsx src/main.ts --base "$BASE" --strict \
  --grandfather-through 20260605
