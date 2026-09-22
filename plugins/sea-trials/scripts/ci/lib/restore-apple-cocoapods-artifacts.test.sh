#!/usr/bin/env bash
# Pins restore_apple_cocoapods_artifacts to generated CocoaPods leftovers
# only. Must not `git restore` authored xcconfigs (Debug.xcconfig carries
# LocalSecrets + preprocessor defs) or AppDelegate / entitlements / pbxproj.
set -euo pipefail

# Plugin root (this file lives at scripts/ci/lib/ inside the plugin).
ROOT="${ST_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
# shellcheck source=restore-apple-cocoapods-artifacts.sh
source "$ROOT/scripts/ci/lib/restore-apple-cocoapods-artifacts.sh"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

cd "$scratch"
git init -q
git config user.email 'tdd@example.test'
git config user.name 'tdd'

mkdir -p \
  flutter/apps/client_app/ios/Flutter \
  flutter/apps/client_app/ios/Runner \
  flutter/apps/client_app/macos/Flutter \
  flutter/apps/admin_app/ios/Flutter \
  flutter/apps/admin_app/macos/Flutter \
  flutter/packages/app_ui/gallery/ios/Flutter

printf '%s\n' \
  '#include "Generated.xcconfig"' \
  '#include? "LocalSecrets.xcconfig"' \
  'GCC_PREPROCESSOR_DEFINITIONS = $(inherited) PERMISSION_NOTIFICATIONS=1' \
  > flutter/apps/client_app/ios/Flutter/Debug.xcconfig
printf 'CLEAN_DELEGATE\n' > flutter/apps/client_app/ios/Runner/AppDelegate.swift
printf 'CLEAN_PBX\n' > flutter/apps/client_app/ios/Runner/project.pbxproj
printf 'CLEAN_ENTITLEMENTS\n' \
  > flutter/apps/client_app/ios/Runner/Runner.entitlements

git add flutter
git commit -qm 'seed'

# Bootstrap pollution + an authored unstaged edit on the same xcconfig.
printf '%s\n' \
  '#include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"' \
  '#include "Generated.xcconfig"' \
  '#include? "LocalSecrets.xcconfig"' \
  'GCC_PREPROCESSOR_DEFINITIONS = $(inherited) PERMISSION_NOTIFICATIONS=1' \
  'AUTHORD_EDIT = 1' \
  > flutter/apps/client_app/ios/Flutter/Debug.xcconfig
printf 'DIRTY_DELEGATE\n' > flutter/apps/client_app/ios/Runner/AppDelegate.swift
printf 'DIRTY_PBX\n' > flutter/apps/client_app/ios/Runner/project.pbxproj
printf 'DIRTY_ENTITLEMENTS\n' \
  > flutter/apps/client_app/ios/Runner/Runner.entitlements
printf 'PODFILE\n' > flutter/apps/client_app/ios/Podfile
printf 'PODLOCK\n' > flutter/apps/client_app/ios/Podfile.lock

restore_apple_cocoapods_artifacts "$scratch"

assert_eq() {
  # `$(cat)` strips trailing newlines; compare bytes instead.
  local expected="$scratch/.expected"
  printf '%s' "$2" > "$expected"
  if ! cmp -s "$1" "$expected"; then
    echo "FAIL $1" >&2
    diff -u "$expected" "$1" >&2 || true
    exit 1
  fi
}

# Pods include gone; authored LocalSecrets line + unstaged edit kept.
# `git restore` of this file must make this FAIL.
assert_eq flutter/apps/client_app/ios/Flutter/Debug.xcconfig \
  $'#include "Generated.xcconfig"\n#include? "LocalSecrets.xcconfig"\nGCC_PREPROCESSOR_DEFINITIONS = $(inherited) PERMISSION_NOTIFICATIONS=1\nAUTHORD_EDIT = 1\n'
assert_eq flutter/apps/client_app/ios/Runner/AppDelegate.swift $'DIRTY_DELEGATE\n'
assert_eq flutter/apps/client_app/ios/Runner/project.pbxproj $'DIRTY_PBX\n'
assert_eq flutter/apps/client_app/ios/Runner/Runner.entitlements \
  $'DIRTY_ENTITLEMENTS\n'

if [[ -e flutter/apps/client_app/ios/Podfile ]]; then
  echo 'FAIL: Podfile must be deleted' >&2
  exit 1
fi
if [[ -e flutter/apps/client_app/ios/Podfile.lock ]]; then
  echo 'FAIL: Podfile.lock must be deleted' >&2
  exit 1
fi

helper="$ROOT/scripts/ci/lib/restore-apple-cocoapods-artifacts.sh"
if grep -nE '^[[:space:]]*git restore' "$helper"; then
  echo "FAIL: $helper must not git restore authored files" >&2
  exit 1
fi

extras="$ROOT/scripts/ci/run-dart-analyze-extras-local.sh"
if ! grep -q 'restore-apple-cocoapods-artifacts.sh' "$extras"; then
  echo "FAIL: $extras must source restore-apple-cocoapods-artifacts.sh" >&2
  exit 1
fi
if grep -n 'git restore "\${apple_platform_roots' "$extras"; then
  echo "FAIL: $extras must not restore whole Apple platform trees" >&2
  exit 1
fi

echo 'restore-apple-cocoapods-artifacts: ok'
