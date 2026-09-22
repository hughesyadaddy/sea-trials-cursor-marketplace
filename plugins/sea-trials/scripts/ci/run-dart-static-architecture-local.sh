#!/usr/bin/env bash
# Full-tree architecture lint (dart-static job companion).
# Ships in the sea-trials plugin; runs against the checkout in cwd.
set -euo pipefail

ST_PLUGIN_ROOT="${ST_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
export ST_PLUGIN_ROOT
ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
BASE="${1:-origin/dev}"
cd "$ROOT"

FORCE_ARGS=()
if node "$ST_PLUGIN_ROOT/scripts/ci/head-touches-lint.mjs" --base "$BASE" \
  | grep -Fq 'touched=true'; then
  FORCE_ARGS=(--force-rebuild)
fi

if ! node "$ST_PLUGIN_ROOT/scripts/hooks/ensure-sea-trials-lint.mjs" \
  ${FORCE_ARGS[@]+"${FORCE_ARGS[@]}"}; then
  echo "sea-trials-lint ensure failed" >&2
  exit 1
fi

LINT="$(
  node --input-type=module -e "
    import { pathToFileURL } from 'node:url';
    const mod = await import(pathToFileURL(
      process.env.ST_PLUGIN_ROOT + '/scripts/hooks/lib/resolve-sea-trials-lint.mjs',
    ).href);
    console.log(mod.getSeaTrialsLintCmd(process.cwd())[0]);
  "
)"

cd "$ROOT/flutter"
"$LINT" check --root . --only architecture
