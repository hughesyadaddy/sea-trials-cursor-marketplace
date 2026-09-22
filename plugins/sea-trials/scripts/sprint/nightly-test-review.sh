#!/usr/bin/env bash
# Nightly /st-jira-test-review sweep, cron/launchd friendly.
#
#   nightly-test-review.sh [extra sweep flags]
#
# 1. Loads ~/.config/sea-trials/jira.env (override: ST_JIRA_ENV_FILE).
# 2. Runs jira-test-review-sweep.mjs --tasks and stores the task lines at
#    ~/.cache/sea-trials/sweeps/<date>.jsonl (root: ST_STATE_DIR).
# 3. Per task line, depending on ST_SWEEP_HOST:
#      claude      (default) `claude -p "<prompt>" --permission-mode acceptEdits`
#      cursor-cli  `agent -p "<prompt>" --force --approve-mcps`
#      cursor      write the jsonl only; a Cursor session picks it up
#    Bounded concurrency (ST_SWEEP_CONCURRENCY, default 2), launches spread
#    ST_SWEEP_STAGGER_MIN..MAX seconds apart (default 180..540) so verdict
#    comments never land in the same minute. One log per issue under the
#    sweeps directory.
#
# Env knobs: JIRA_PROJECT_KEY (required), JIRA_REVIEW_STATUS, ST_SWEEP_MAX,
# ST_SWEEP_SINCE, ST_SWEEP_REPO (owner/name for gh), ST_SWEEP_REPO_ROOT
# (checkout the worker starts from; default $PWD), ST_SWEEP_MODEL,
# ST_SWEEP_DRY_RUN=1 (print the commands, run nothing), ST_SWEEP_SCRIPT
# (alternate sweep emitter, used by tests).
#
# Works with the /bin/bash 3.2 that launchd provides: no mapfile, no
# `wait -n`, no ${var,,}.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP_JS="${ST_SWEEP_SCRIPT:-$SCRIPT_DIR/jira-test-review-sweep.mjs}"

ENV_FILE="${ST_JIRA_ENV_FILE:-$HOME/.config/sea-trials/jira.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

STATE_ROOT="${ST_STATE_DIR:-$HOME/.cache/sea-trials}"
SWEEP_DIR="$STATE_ROOT/sweeps"
mkdir -p "$SWEEP_DIR"

HOST="${ST_SWEEP_HOST:-claude}"
CONCURRENCY="${ST_SWEEP_CONCURRENCY:-2}"
STAGGER_MIN="${ST_SWEEP_STAGGER_MIN:-180}"
STAGGER_MAX="${ST_SWEEP_STAGGER_MAX:-540}"
MAX_ISSUES="${ST_SWEEP_MAX:-10}"
SINCE="${ST_SWEEP_SINCE:-24h}"
REPO_ROOT="${ST_SWEEP_REPO_ROOT:-$PWD}"
DRY_RUN="${ST_SWEEP_DRY_RUN:-0}"
RUN_ID="$(date +%F)"
TASKS_FILE="$SWEEP_DIR/$RUN_ID.jsonl"
SWEEP_LOG="$SWEEP_DIR/$RUN_ID.sweep.log"

log() { printf '[nightly-test-review] %s\n' "$*" >&2; }

if [[ -z "${JIRA_PROJECT_KEY:-}" ]]; then
  log "JIRA_PROJECT_KEY is not set (put it in $ENV_FILE)"
  exit 2
fi

command -v node >/dev/null 2>&1 || { log "node not on PATH"; exit 2; }

sweep_args=(--project "$JIRA_PROJECT_KEY" --tasks --since "$SINCE"
  --max "$MAX_ISSUES" --repo-root "$REPO_ROOT")
[[ -n "${ST_SWEEP_REPO:-}" ]] && sweep_args+=(--repo "$ST_SWEEP_REPO")
sweep_args+=("$@")

log "sweep: node $SWEEP_JS ${sweep_args[*]}"
if ! node "$SWEEP_JS" "${sweep_args[@]}" >"$TASKS_FILE.tmp" 2>"$SWEEP_LOG"; then
  log "sweep failed; see $SWEEP_LOG"
  rm -f "$TASKS_FILE.tmp"
  exit 1
fi
mv "$TASKS_FILE.tmp" "$TASKS_FILE"
log "$(tail -n 1 "$SWEEP_LOG")"
log "tasks: $TASKS_FILE"

if [[ ! -s "$TASKS_FILE" ]]; then
  log "nothing to review"
  exit 0
fi

if [[ "$HOST" == "cursor" ]]; then
  log "ST_SWEEP_HOST=cursor: task lines written; open them in a Cursor session"
  exit 0
fi

json_field() {
  # json_field <line> <field>
  node -e 'const t = JSON.parse(process.argv[1]); const v = t[process.argv[2]];
    process.stdout.write(v == null ? "" : String(v));' "$1" "$2"
}

running_jobs() { jobs -rp | wc -l | tr -d ' '; }

wait_for_slot() {
  while [[ "$(running_jobs)" -ge "$CONCURRENCY" ]]; do sleep 5; done
}

random_between() {
  local lo="$1" hi="$2"
  if [[ "$hi" -le "$lo" ]]; then printf '%s\n' "$lo"; return; fi
  printf '%s\n' $(( lo + (RANDOM % (hi - lo + 1)) ))
}

run_worker() {
  # run_worker <key> <prompt> <log>
  local key="$1" prompt="$2" out="$3"
  local cmd rc
  case "$HOST" in
    claude)
      cmd=(claude -p "$prompt" --permission-mode acceptEdits)
      [[ -n "${ST_SWEEP_MODEL:-}" ]] && cmd+=(--model "$ST_SWEEP_MODEL")
      ;;
    cursor-cli)
      cmd=(agent -p "$prompt" --force --approve-mcps --workspace "$REPO_ROOT")
      [[ -n "${ST_SWEEP_MODEL:-}" ]] && cmd+=(--model "$ST_SWEEP_MODEL")
      ;;
    *)
      log "unknown ST_SWEEP_HOST=$HOST (claude|cursor-cli|cursor)"
      return 2
      ;;
  esac
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run $key: ${cmd[0]} ${cmd[1]} <prompt> ${cmd[*]:3}"
    return 0
  fi
  log "start $key -> $out"
  rc=0
  (
    cd "$REPO_ROOT"
    "${cmd[@]}"
  ) >"$out" 2>&1 || rc=$?
  log "done $key exit=$rc"
  return "$rc"
}

launched=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  key="$(json_field "$line" key)"
  prompt="$(json_field "$line" prompt)"
  [[ -z "$key" || -z "$prompt" ]] && continue
  if [[ "$launched" -gt 0 ]]; then
    pause="$(random_between "$STAGGER_MIN" "$STAGGER_MAX")"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "would wait ${pause}s before $key"
    else
      log "waiting ${pause}s before $key"
      sleep "$pause"
    fi
  fi
  wait_for_slot
  run_worker "$key" "$prompt" "$SWEEP_DIR/$RUN_ID.$key.log" &
  launched=$((launched + 1))
done <"$TASKS_FILE"

wait
log "finished: launched=$launched logs=$SWEEP_DIR/$RUN_ID.*.log"
