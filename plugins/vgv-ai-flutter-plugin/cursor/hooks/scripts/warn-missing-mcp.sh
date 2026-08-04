#!/usr/bin/env bash
# sessionStart: warn when dart / very_good CLI or Flutter plugin MCP are missing.
set -euo pipefail

_msgs=()

if ! command -v dart >/dev/null 2>&1; then
  _msgs+=(
    "dart SDK not on PATH — install Flutter/Dart and reload MCP."
  )
fi

if ! command -v very_good >/dev/null 2>&1; then
  _msgs+=(
    "very_good CLI not on PATH — dart pub global activate very_good_cli"
  )
else
  # shellcheck source=vgv-cli-common.sh
  source "$(dirname "$0")/vgv-cli-common.sh"
  case "$(check_vgv_cli)" in
    not_installed)
      _msgs+=("Very Good CLI missing — dart pub global activate very_good_cli")
      ;;
    outdated:*)
      _msgs+=(
        "Very Good CLI too old (need >= ${MIN_VERSION}) — dart pub global activate very_good_cli"
      )
      ;;
  esac
fi

_plugins="${HOME}/.cursor/plugins"
_market="${_plugins}/cache"
plugin_mcp="$(
  { ls -1t \
    "${_market}"/*/vgv-ai-flutter-plugin/*/mcp.json \
    "${_plugins}/local/vgv-ai-flutter-plugin/mcp.json" 2>/dev/null || true; } |
    head -1
)"
if [[ -n "$plugin_mcp" ]]; then
  for _server in dart very-good-cli; do
    if ! grep -q "\"${_server}\"" "$plugin_mcp" 2>/dev/null; then
      _msgs+=(
        "Flutter plugin mcp.json missing ${_server} — refresh Team Marketplace."
      )
    fi
  done
else
  _msgs+=(
    "VGV AI Flutter plugin not installed — enable it in Team Marketplace."
  )
fi

if [[ -f "${HOME}/.cursor/mcp.json" ]]; then
  _msgs+=(
    "~/.cursor/mcp.json duplicates plugin MCP — delete it."
  )
fi

if [[ ${#_msgs[@]} -eq 0 ]]; then
  printf '{}\n'
  exit 0
fi

joined="$(printf '%s ' "${_msgs[@]}")"
if command -v jq >/dev/null 2>&1; then
  jq -n --arg m "$joined" '{agent_message:$m}'
else
  printf '{"agent_message":%s}\n' \
    "$(printf '%s' "$joined" | sed 's/"/\\"/g; s/^/"/; s/$/"/')"
fi
exit 0
