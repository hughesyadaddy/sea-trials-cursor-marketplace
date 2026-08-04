#!/usr/bin/env bash
# beforeShellExecution: block shell that bypasses dart / very-good-cli MCP.
set -euo pipefail

# shellcheck source=vgv-cli-common.sh
source "$(dirname "$0")/vgv-cli-common.sh"

input="$(cat || true)"
command=""

if command -v jq >/dev/null 2>&1; then
  command="$(jq -r '.command // empty' <<<"$input" 2>/dev/null || true)"
fi
if [[ -z "$command" ]]; then
  command="$(
    printf '%s' "$input" |
      sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -1
  )"
fi

allow() {
  printf '%s\n' '{"permission":"allow"}'
  exit 0
}

deny() {
  local msg="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -n \
      --arg m "$msg" \
      '{permission:"deny",user_message:$m,agent_message:$m}'
  else
    printf '{"permission":"deny","user_message":%s,"agent_message":%s}\n' \
      "$(printf '%s' "$msg" | sed 's/"/\\"/g; s/^/"/; s/$/"/')" \
      "$(printf '%s' "$msg" | sed 's/"/\\"/g; s/^/"/; s/$/"/')"
  fi
  exit 2
}

deny_with_cli_check() {
  local mcp_hint="$1"
  case "$(check_vgv_cli)" in
    not_installed)
      deny \
        "Very Good CLI required. Install: dart pub global activate very_good_cli"
      ;;
    outdated:*)
      deny \
        "Very Good CLI too old (need >= ${MIN_VERSION}). Run: dart pub global activate very_good_cli"
      ;;
    *)
      deny "$mcp_hint"
      ;;
  esac
}

[[ -z "$command" ]] && allow

blocked="$(
  echo "$command" | awk '{
    n = split($0, parts, /[;&|]+/)
    for (i = 1; i <= n; i++) {
      gsub(/^[[:space:]]+/, "", parts[i])
      split(parts[i], w, /[[:space:]]+/)
      b = w[1]; s = w[2]
      if ((b == "flutter" || b == "dart") && s == "create") { print "create"; exit }
      if ((b == "flutter" || b == "dart") && s == "test")   { print "test"; exit }
      if (b == "very_good" && s == "create")                { print "vg_create"; exit }
      if (b == "very_good" && s == "test")                  { print "vg_test"; exit }
      if (b == "very_good" && s == "packages")              { print "vg_packages"; exit }
    }
  }'
)"

case "$blocked" in
  create)
    deny_with_cli_check \
      "Use very-good-cli MCP create — not shell flutter/dart create."
    ;;
  test)
    deny_with_cli_check \
      "Use very-good-cli MCP test or pnpm agent-validate — not shell test."
    ;;
  vg_create)
    deny_with_cli_check \
      "Use very-good-cli MCP create — not shell very_good create."
    ;;
  vg_test)
    deny_with_cli_check \
      "Use very-good-cli MCP test — not shell very_good test."
    ;;
  vg_packages)
    deny_with_cli_check \
      "Use very-good-cli MCP packages_get — not shell very_good packages."
    ;;
esac

allow
