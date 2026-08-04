#!/usr/bin/env bash
# afterFileEdit: dart format on edited .dart files (official PostToolUse port).
set -euo pipefail

input="$(cat || true)"
file_path=""

if command -v jq >/dev/null 2>&1; then
  file_path="$(jq -r '.file_path // empty' <<<"$input" 2>/dev/null || true)"
fi
if [[ -z "$file_path" ]]; then
  file_path="$(
    printf '%s' "$input" |
      sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -1
  )"
fi

if [[ -z "$file_path" || "$file_path" != *.dart ]]; then
  printf '{}\n'
  exit 0
fi

if command -v dart >/dev/null 2>&1; then
  dart format "$file_path" >/dev/null 2>&1 || true
fi

printf '{}\n'
exit 0
