#!/usr/bin/env bash
# afterFileEdit: dart analyze on edited .dart files (official PostToolUse port).
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

if ! command -v dart >/dev/null 2>&1; then
  printf '{}\n'
  exit 0
fi

# Load guard: `dart analyze` starts a full analysis server per call, and many
# parallel agents editing many files can stack dozens of them. Run at most one
# analyze per worktree at a time (skip, don't queue: the next edit re-checks),
# and skip a file whose content has not changed since it was last analyzed.
# Set VGV_ANALYZE_NO_GUARD=1 to always analyze.
if [[ "${VGV_ANALYZE_NO_GUARD:-}" != "1" ]]; then
  _dir="$(cd "$(dirname "$file_path")" 2>/dev/null && pwd || dirname "$file_path")"
  _root="$(git -C "$_dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$_dir")"
  _hash() { { shasum 2>/dev/null || sha1sum; } | cut -c1-16; }
  _state="${TMPDIR:-/tmp}/vgv-analyze-dart-$(id -u)"
  mkdir -p "$_state" 2>/dev/null || true
  _wt="$(printf '%s' "$_root" | _hash)"
  _lock="$_state/$_wt.lock"
  _sum="$(_hash < "$file_path" 2>/dev/null || true)"
  _seen="$_state/$_wt-$(printf '%s' "$file_path" | _hash).sum"
  if [[ -n "$_sum" && -f "$_seen" && "$(cat "$_seen" 2>/dev/null)" == "$_sum" ]]; then
    printf '{}\n'
    exit 0
  fi
  if ! mkdir "$_lock" 2>/dev/null; then
    _pid="$(cat "$_lock/pid" 2>/dev/null || true)"
    if [[ -n "$_pid" ]] && ! kill -0 "$_pid" 2>/dev/null; then
      rm -f "$_lock/pid" && rmdir "$_lock" 2>/dev/null && mkdir "$_lock" 2>/dev/null || {
        printf '{}\n'; exit 0; }
    else
      printf '{}\n'
      exit 0
    fi
  fi
  echo $$ > "$_lock/pid"
  trap 'rm -f "$_lock/pid"; rmdir "$_lock" 2>/dev/null || true' EXIT
fi

output="$(dart analyze "$file_path" 2>&1)" || {
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg m "$output" '{agent_message:$m}'
  else
    printf '{"agent_message":%s}\n' \
      "$(printf '%s' "$output" | sed 's/"/\\"/g; s/^/"/; s/$/"/')"
  fi
  exit 0
}

[[ -n "${_seen:-}" && -n "${_sum:-}" ]] && printf '%s' "$_sum" > "$_seen" 2>/dev/null
printf '{}\n'
exit 0
