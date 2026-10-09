#!/usr/bin/env bash
# Source after Team Marketplace install (any app repo):
#   source "$(find "${HOME}/.cursor/plugins" -path '*/sea-trials/scripts/bootstrap-st-env.sh' 2>/dev/null | head -1)"
set -euo pipefail

export ST_PLUGIN_ROOT="${ST_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
if [[ -z "${ST_PLUGIN_ROOT:-}" ]]; then
  _ST_PRINT="$(
    find "${HOME}/.cursor/plugins" "${HOME}/.claude/plugins" \
      -path '*/sea-trials/scripts/lib/print-st-plugin-root.mjs' 2>/dev/null | head -1
  )"
  if [[ -z "${_ST_PRINT}" ]]; then
    echo "ERROR: sea-trials plugin not found (Customize → Team Marketplace → sea-trials)" >&2
    return 1 2>/dev/null || exit 1
  fi
  ST_PLUGIN_ROOT="$(node "${_ST_PRINT}")"
  export ST_PLUGIN_ROOT
fi
