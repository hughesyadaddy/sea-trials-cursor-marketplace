#!/usr/bin/env bash
# Keep pr-review-loop.mjs running continuously for one PR.
#
# pr-review-loop.mjs exits non-zero as its handoff signal: open threads,
# red CI, or CI still pending at the end of the silence window all end
# the process so an agent can act. That is correct for a single pass, but
# it means the watch does not survive the first finding — which reads as
# "the loop stopped" while work is still outstanding.
#
# This re-invokes it until it reports the terminal green (exit 0), so the
# watch outlives each handoff. Exit codes are recorded per attempt so the
# reason for each restart stays visible in the log.
#
# Detach with --daemon so the watch outlives the shell that started it.
# `nohup ... &` alone is not enough: it blocks SIGHUP but not the
# process-group termination an agent shell performs when its session
# ends, which killed an earlier run within seconds. os.setsid puts the
# supervisor in its own session and process group, out of that blast
# radius. macOS ships no setsid(1), hence Python.
#
# Usage: pr-review-supervisor.sh [--daemon] <pr-number> [retry-delay-s]
#          [-- <extra pr-review-loop flags>]
#
# Extra flags (after `--`) go straight to pr-review-loop.mjs, e.g.
# `-- --webhook --bots codex,bugbot`. `PR_REVIEW_LOOP_ARGS` does the
# same from the environment.

set -uo pipefail

if [ "${1:-}" = "--daemon" ]; then
  shift
  PR_ARG="${1:?usage: pr-review-supervisor.sh --daemon <pr> [delay] [-- flags]}"
  shift
  DELAY_ARG=60
  if [ "${1:-}" != "--" ] && [ $# -gt 0 ]; then
    DELAY_ARG="$1"
    shift
  fi
  [ "${1:-}" = "--" ] && shift
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  LOG="${PR_REVIEW_SUPERVISOR_LOG:-/tmp/pr-review-supervisor-$PR_ARG.log}"
  python3 - "$SELF" "$PR_ARG" "$DELAY_ARG" "$LOG" "$@" <<'PY'
import os, sys

self_path, pr, delay, log = sys.argv[1:5]
extra = sys.argv[5:]
if os.fork() > 0:
    os._exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.close(os.open(os.devnull, os.O_RDONLY))
argv = ['bash', self_path, pr, delay]
if extra:
    argv += ['--'] + extra
os.execvp('bash', argv)
PY
  # The daemon reopens the log; poll rather than assume it is up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if pgrep -f "pr-review-supervisor.sh $PR_ARG" >/dev/null 2>&1; then
      echo "supervisor detached for PR #$PR_ARG; log: $LOG"
      exit 0
    fi
    sleep 1
  done
  echo "supervisor failed to detach; see $LOG" >&2
  exit 1
fi

PR="${1:?usage: pr-review-supervisor.sh <pr-number> [retry-delay-seconds] [-- flags]}"
shift
DELAY=60
if [ "${1:-}" != "--" ] && [ $# -gt 0 ]; then
  DELAY="$1"
  shift
fi
[ "${1:-}" = "--" ] && shift
# shellcheck disable=SC2206 # intentional word-splitting of env flags
LOOP_ARGS=(${PR_REVIEW_LOOP_ARGS:-} "$@")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${ST_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
REPO_ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
LOOP_HOOK="$PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs"

if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  echo "pr-review-supervisor: not inside a git repo (set ST_REPO_ROOT)" >&2
  exit 1
fi

cd "$REPO_ROOT" || exit 1

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  printf '[supervisor] attempt %d for PR #%s at %s\n' \
    "$ATTEMPT" "$PR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  node "$LOOP_HOOK" --pr "$PR" ${LOOP_ARGS[@]+"${LOOP_ARGS[@]}"}
  CODE=$?

  if [ "$CODE" -eq 0 ]; then
    printf '[supervisor] PR #%s green after %d attempt(s); stopping.\n' \
      "$PR" "$ATTEMPT"
    exit 0
  fi

  printf '[supervisor] loop exited %d; retrying in %ss\n' "$CODE" "$DELAY"
  sleep "$DELAY"
done
