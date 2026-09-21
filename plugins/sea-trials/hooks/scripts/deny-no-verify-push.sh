#!/usr/bin/env bash
# beforeShellExecution / PreToolUse: block git push --no-verify / -n.
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

# Tokenize and inspect only push subcommand flags (not ref names).
read -r -a tokens <<<"$command"
push_idx=-1
for ((i = 0; i < ${#tokens[@]}; i += 1)); do
  if [[ "${tokens[i]}" == "push" ]]; then
    push_idx=$i
    break
  fi
done

if [[ $push_idx -ge 0 ]]; then
  for ((i = push_idx + 1; i < ${#tokens[@]}; i += 1)); do
    case "${tokens[i]}" in
      --no-verify | -n | --dry-run)
        deny "Sea Trials: never git push with --no-verify, -n, or --dry-run. Use pnpm pr-review-push."
        ;;
    esac
  done
fi

allow
