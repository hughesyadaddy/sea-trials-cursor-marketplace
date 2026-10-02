#!/usr/bin/env bash
# Control the 24h PR review daemon (pr-review-daemon.mjs).
#
#   pr-review-daemonctl.sh start --pr <n> [--daemon] [-- extra daemon flags]
#   pr-review-daemonctl.sh stop --pr <n>
#   pr-review-daemonctl.sh status --pr <n>
#
# --daemon detaches via setsid (survives Cursor agent session end).

set -uo pipefail

usage() {
  echo "usage: pr-review-daemonctl.sh {start|stop|status} --pr <n> [--daemon] [-- flags]" >&2
  exit 2
}

CMD="${1:-}"
shift || usage

case "$CMD" in
  start|stop|status) ;;
  *) usage ;;
esac

PR=""
DAEMON=0
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)
      PR="${2:?--pr requires a number}"
      shift 2
      ;;
    --daemon)
      DAEMON=1
      shift
      ;;
    --)
      shift
      EXTRA=("$@")
      break
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      ;;
  esac
done

[ -n "$PR" ] || usage

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${ST_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
DAEMON_HOOK="$PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs"
REPO_ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  echo "pr-review-daemonctl: not inside a git repo (set ST_REPO_ROOT)" >&2
  exit 1
fi

resolve_pid_file() {
  local head scope
  head="$(gh pr view "$PR" --json headRefName -q .headRefName 2>/dev/null)" || head="pr-$PR"
  scope="${head//\//-}"
  printf '%s/docs/code-review/%s/.pr-%s-daemon.pid\n' "$REPO_ROOT" "$scope" "$PR"
}

PID_FILE="$(resolve_pid_file)"

read_pid() {
  [ -f "$PID_FILE" ] && tr -d '[:space:]' <"$PID_FILE"
}

pid_alive() {
  local p="$1"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

case "$CMD" in
  status)
    P="$(read_pid)"
    if pid_alive "$P"; then
      echo "running pid=$P pr=$PR repo=$REPO_ROOT"
      exit 0
    fi
    echo "stopped pr=$PR"
    exit 1
    ;;
  stop)
    P="$(read_pid)"
    if pid_alive "$P"; then
      kill "$P" 2>/dev/null || true
      sleep 1
      if pid_alive "$P"; then
        kill -9 "$P" 2>/dev/null || true
      fi
      rm -f "$PID_FILE"
      echo "stopped pid=$P"
      exit 0
    fi
    rm -f "$PID_FILE"
    echo "not running"
    exit 0
    ;;
  start)
    P="$(read_pid)"
    if pid_alive "$P"; then
      echo "already running pid=$P" >&2
      exit 1
    fi
    ;;
esac

run_daemon() {
  cd "$REPO_ROOT" || exit 1
  export ST_PLUGIN_ROOT="$PLUGIN_ROOT"
  export ST_REPO_ROOT="$REPO_ROOT"
  exec node "$DAEMON_HOOK" --pr "$PR" "${EXTRA[@]}"
}

if [ "$DAEMON" -eq 1 ]; then
  LOG="${PR_REVIEW_DAEMON_LOG:-/tmp/pr-review-daemon-$PR.log}"
  python3 - "$SELF" "$PR" "$LOG" "$REPO_ROOT" "$PLUGIN_ROOT" "${EXTRA[@]}" <<'PY'
import os, sys

self_path, pr, log, repo, plugin = sys.argv[1:6]
extra = sys.argv[6:]
if os.fork() > 0:
    os._exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.close(os.open(os.devnull, os.O_RDONLY))
os.environ['ST_REPO_ROOT'] = repo
os.environ['ST_PLUGIN_ROOT'] = plugin
argv = ['bash', self_path, 'start', '--pr', pr, '--'] + extra
os.execvp('bash', argv)
PY
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if bash "$SELF" status --pr "$PR" >/dev/null 2>&1; then
      echo "daemon detached for PR #$PR; log: $LOG"
      exit 0
    fi
    sleep 1
  done
  echo "daemon failed to start; see $LOG" >&2
  exit 1
fi

run_daemon
