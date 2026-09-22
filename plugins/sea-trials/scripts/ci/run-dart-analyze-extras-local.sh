#!/usr/bin/env bash
# Post-bootstrap analyze guards from dart-analyze-shard shard 1.
# Ships in the sea-trials plugin; runs against the checkout in cwd.
set -euo pipefail

ST_PLUGIN_ROOT="${ST_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
BASE="${1:-origin/dev}"
cd "$ROOT"

# shellcheck source=lib/restore-apple-cocoapods-artifacts.sh
source "$ST_PLUGIN_ROOT/scripts/ci/lib/restore-apple-cocoapods-artifacts.sh"

# melos bootstrap on macOS can regenerate CocoaPods leftovers locally.
# Restore only those generated xcconfigs and drop ephemeral Podfiles so
# the zero-CocoaPods assert matches CI. Authored Apple sources are left
# untouched.
restore_apple_cocoapods_artifacts "$ROOT"

# Refresh SwiftPM plugin metadata on macOS after restore; pub get can
# briefly recreate CocoaPods leftovers, so restore/delete again.
if [[ "$(uname)" == "Darwin" ]]; then
  for app in \
    flutter/apps/client_app \
    flutter/apps/admin_app \
    flutter/packages/app_ui/gallery; do
    (cd "$app" && flutter pub get --suppress-analytics)
  done
  restore_apple_cocoapods_artifacts "$ROOT"
fi

bash scripts/flutter/assert-client-app-zero-cocoapods.sh

base_sha="$(git merge-base "$BASE" HEAD)"
git diff --name-only --diff-filter=ACMR "$base_sha"..HEAD \
  | { grep -E '^flutter/.*\.dart$' || true; } \
  | sed 's|^flutter/||' > /tmp/dart_only_targets.txt
if [ -s /tmp/dart_only_targets.txt ]; then
  (
    cd flutter
    xargs flutter pub run sea_trials_lints:check_dart_only \
      < /tmp/dart_only_targets.txt
  )
fi

(
  cd flutter
  flutter pub run sea_trials_lints:check_main_parity
)
