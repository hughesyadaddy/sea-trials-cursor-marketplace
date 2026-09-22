#!/usr/bin/env bash
# Drop CocoaPods leftovers that macOS `melos bootstrap` / `pub get`
# regenerate. Sourced by run-dart-analyze-extras-local.sh.
#
# Never `git restore`: Debug.xcconfig is authored (LocalSecrets,
# preprocessor defs). Only delete ephemeral Podfiles and strip generated
# `Pods/Target Support Files/` include lines.

APPLE_COCOAPODS_PLATFORM_ROOTS=(
  flutter/apps/client_app/ios
  flutter/apps/client_app/macos
  flutter/apps/admin_app/ios
  flutter/apps/admin_app/macos
  flutter/packages/app_ui/gallery/ios
)

restore_apple_cocoapods_artifacts() {
  local root="${1:-.}"
  (
    cd "$root"
    local platform_dir f tmp
    for platform_dir in "${APPLE_COCOAPODS_PLATFORM_ROOTS[@]}"; do
      [[ -d "$platform_dir" ]] || continue
      find "$platform_dir" \
        \( -name Podfile -o -name Podfile.lock \) -delete 2>/dev/null || true
      while IFS= read -r -d '' f; do
        grep -q 'Pods/Target Support Files/' "$f" || continue
        tmp="$(mktemp)"
        grep -v 'Pods/Target Support Files/' "$f" > "$tmp"
        mv "$tmp" "$f"
      done < <(find "$platform_dir" -name '*.xcconfig' -print0)
    done
  )
}
