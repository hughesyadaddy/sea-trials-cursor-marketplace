#!/usr/bin/env bash
# beforeShellExecution: block git push --no-verify / -n (Sea Trials push gate).
set -euo pipefail

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
    jq -n --arg m "$msg" \
      '{permission:"deny",user_message:$m,agent_message:$m}'
  else
    printf '{"permission":"deny"}\n'
  fi
  exit 2
}

[[ -z "$command" ]] && allow

if [[ "$command" =~ git[[:space:]]+push ]] && \
   [[ "$command" =~ (--no-verify|-n|--dry-run) ]]; then
  deny "Sea Trials: never git push with --no-verify, -n, or --dry-run. Use pnpm pr-review-push."
fi

allow
