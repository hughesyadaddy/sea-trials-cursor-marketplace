#!/usr/bin/env bash
# Local parity for the ci-script-tests PR Checks job (beyond Node unit tests).
#
# Ships in the sea-trials plugin. The Node unit tests split in two: the
# plugin's own `scripts/ci/*.test.mjs` (gate logic) and the checkout's
# `scripts/ci/*.test.mjs` (config parity against its workflows and lane
# registry). App-specific suites (scripts/flutter python tests, whitelabel,
# vscode tasks, web tools) run only when the checkout ships them.
set -euo pipefail

ST_PLUGIN_ROOT="${ST_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
export ST_PLUGIN_ROOT
ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
export ST_REPO_ROOT="$ROOT"
cd "$ROOT"

skip() {
  echo "ci-script-tests: skipping $1 (not present in this checkout)"
}

# Bash 3 (macOS /bin/bash) has no globstar/nullglob defaults; collect
# explicitly so a missing directory is a skip, not a literal glob token.
node_tests=()
for f in "$ST_PLUGIN_ROOT"/scripts/ci/*.test.mjs; do
  [ -f "$f" ] && node_tests+=("$f")
done
if compgen -G 'scripts/ci/*.test.mjs' >/dev/null; then
  for f in scripts/ci/*.test.mjs; do node_tests+=("$f"); done
else
  skip 'scripts/ci/*.test.mjs'
fi
if compgen -G 'scripts/whitelabel/*.test.mjs' >/dev/null; then
  for f in scripts/whitelabel/*.test.mjs; do node_tests+=("$f"); done
else
  skip 'scripts/whitelabel/*.test.mjs'
fi
node --test "${node_tests[@]}"

if [ -f scripts/env-loader-hygiene.test.mjs ]; then
  node --test scripts/env-loader-hygiene.test.mjs
else
  skip scripts/env-loader-hygiene.test.mjs
fi

if [ -f scripts/flutter/flutter_tool_wrapper_test.py ]; then
  (
    cd scripts/flutter
    python3 -m unittest flutter_tool_wrapper_test -v
  )
else
  skip scripts/flutter/flutter_tool_wrapper_test.py
fi

if [ -f scripts/flutter/test_ios_spm_deployment_target_sync.sh ]; then
  bash scripts/flutter/test_ios_spm_deployment_target_sync.sh
else
  skip scripts/flutter/test_ios_spm_deployment_target_sync.sh
fi

bash "$ST_PLUGIN_ROOT/scripts/ci/lib/restore-apple-cocoapods-artifacts.test.sh"

if [ -f scripts/flutter/native_build_gate_test.py ]; then
  (
    cd scripts/flutter
    python3 -m unittest native_build_gate_test -v
  )
else
  skip scripts/flutter/native_build_gate_test.py
fi

if [ -f scripts/flutter/pnpm-flutter.test.mjs ]; then
  node --test scripts/flutter/pnpm-flutter.test.mjs
else
  skip scripts/flutter/pnpm-flutter.test.mjs
fi

if [ -f scripts/flutter/firestore_macos_preflight_test.py ] \
  && [ -f scripts/flutter/firestore_macos_spm_test.py ]; then
  (
    cd scripts/flutter
    python3 -m unittest firestore_macos_preflight_test firestore_macos_spm_test -v
  )
else
  skip 'scripts/flutter/firestore_macos_*_test.py'
fi

if [ -f scripts/flutter/check_cloud_firestore_patch.py ]; then
  python3 scripts/flutter/check_cloud_firestore_patch.py
else
  skip scripts/flutter/check_cloud_firestore_patch.py
fi

python3 -c 'import yaml' || pip install --quiet pyyaml
bash "$ST_PLUGIN_ROOT/scripts/ci/assert-workflow-paths.sh"

if [ -f scripts/admin_app_configs/derive-marketing-required-fields.mjs ]; then
  node --test \
    scripts/admin_app_configs/derive-marketing-required-fields.test.mjs
  node scripts/admin_app_configs/derive-marketing-required-fields.mjs --check
else
  skip scripts/admin_app_configs/derive-marketing-required-fields.mjs
fi

if [ -f web/tools/screenshots/generate-device-frame.test.mjs ]; then
  node --test web/tools/screenshots/generate-device-frame.test.mjs
else
  skip web/tools/screenshots/generate-device-frame.test.mjs
fi

if [ -d scripts/vscode ]; then
  pnpm verify:vscode-tasks && pnpm test:vscode-tasks
else
  skip scripts/vscode
fi
