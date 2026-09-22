#!/usr/bin/env bash
# Local parity for edge-function-tests (mirrors pr-checks.yml Deno lane).
# Ships in the sea-trials plugin; runs against the checkout in cwd.
set -euo pipefail

ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

if ! command -v deno >/dev/null 2>&1; then
  echo "edge-function-tests: Deno not found; installing to ${ROOT}/.deno …"
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="${ROOT}/.deno" sh
  export PATH="${ROOT}/.deno/bin:${PATH}"
fi

cd supabase/functions
deno test --permit-no-files --no-check --allow-read=../../functions \
  --allow-env .
