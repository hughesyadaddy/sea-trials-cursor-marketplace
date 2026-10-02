# PR review monitor (24h Cursor background terminal)

Shared by `/st-pr-review-monitor`, `/st-pr-promote`, and both
`st-pr-review-loop-*` skills. The monitor is the **nervous system**;
the review loop body is the **fix pipeline**.

## Why this exists

`pr-review-loop.mjs` **exits** on handoff (codes 2/3/8) so a single
agent turn can act. That is correct for one pass — but it reads as
"the watch stopped" when the background shell dies with the agent
session. The **daemon never exits on handoff**; it emits deduped
sentinels and waits for the parent agent to fix, ack, and resume.

| Tool | Role |
| --- | --- |
| `pr-review-daemon.mjs` | 24h watch; CI fail + open threads → `>>> ACTION:` immediately |
| `pr-review-daemonctl.sh` | `start --daemon` (setsid), `stop`, `status` |
| `pr-review-loop.mjs` | Single-pass detect (fallback / tests) |
| `pr-review-supervisor.sh` | Legacy retry wrapper — prefer daemon |
| `pr-review-watch.mjs` | Thread-only continuous poll — superseded by daemon |

## Start the monitor (Cursor — do this in chat)

**Always start from the active checkout** (`$REPO_ROOT` or
`$WORKTREE_DIR`). Never run a monitor script outside the repo.

### Option A — detached daemon (24h+, survives chat close)

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
# worktree: export ST_REPO_ROOT="$WORKTREE_DIR"

bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" \
  start --pr <n> --daemon -- --duration 24h
```

### Option B — Cursor background terminal (visible in this chat)

Use the **Shell tool** with `block_until_ms: 0` so the terminal stays
open in Cursor:

```bash
cd "$ACTIVE_ROOT" && \
  ST_REPO_ROOT="$ACTIVE_ROOT" \
  node "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs" \
  --pr <n> --duration 24h
```

(`--webhook` is on by default; `gh extension install cli/gh-webhook`
for instant CI/review events. Pass `--no-webhook` only when offline.)

Record the **terminal task id** returned by Shell — the parent uses
`Await` on it (see below).

`pnpm` shortcuts (when the monorepo wires them):

```bash
pnpm pr-review-daemonctl -- start --pr <n> --daemon -- --duration 24h
pnpm pr-review-daemon -- --pr <n>
```

## Sentinels (grep / Await patterns)

The daemon prints **only on state change** (deduped):

| Line | Meaning | Parent must |
| --- | --- | --- |
| `>>> ACTION: ci-fail …` | CI red on HEAD | Fix **now** — do not wait for Codex |
| `>>> ACTION: threads …` | Unresolved bot threads | Run review-loop Steps 2–6 |
| `>>> WAIT: …` | CI pending or bots reviewing | Keep `Await` running |
| `>>> GREEN: …` | 0 threads, CI green | Round complete; keep watching after push |

Parallel artifacts under `docs/code-review/<scope>/`:

| File | Purpose |
| --- | --- |
| `pr-<n>-acting.signal` | Durable wake (`CI_FAIL`, `THREADS`, `WAIT`, `GREEN`) |
| `pr-<n>-monitor-last.txt` | Last deduped sentinel (session reconnect) |
| `pr-<n>-handoff.ack` | Parent writes after each fix round |
| `pr-<n>-daemon-log.txt` | Append-only log |
| `.pr-<n>-daemon.pid` | Single owner per PR |
| `pr-review-queue.json` | Thread/CI payload for triage |

## Parent agent loop (stay on task)

```text
START monitor (once per PR) → AWAIT → ACT on ACTION → ACK → AWAIT …
```

1. **Start** — Option A or B above (once; refuse duplicate via
   `daemonctl status`).
2. **Await** — `Await(task_id, pattern: ">>> ACTION:")` on the
   background terminal. If the chat session ended, read
   `pr-<n>-acting.signal` on resume; if it starts with `CI_FAIL` or
   `THREADS`, treat as ACTION.
3. **Act** — on `ci-fail`: fix → gate → push → **do not wait for
   Codex**. On `threads`: full review-loop Steps 2–6 (triage, fix
   fan-out, gate, push, reply+resolve).
4. **Ack** — after each fix round:

   ```bash
   touch "$ACTIVE_ROOT/docs/code-review/<scope>/pr-<n>-handoff.ack"
   ```

5. **Repeat** — go back to Await. Never end the turn on ACTION without
   fixing. Never ask "should I fix CI?" — **just fix it**.

### CI vs Codex priority

| Signal | Wait for Codex? | Action |
| --- | --- | --- |
| CI fail | **No** | Fix immediately; push; ack; resume watch |
| Open threads | No (existing threads) | Triage + adversarial vet + fix |
| CI pending, 0 threads | Yes (daemon stays WAIT) | Keep watching |
| New Codex after push | Daemon handles settle internally | ACT when threads appear |

## Worktree vs in-place

| Mode | `$ACTIVE_ROOT` | `ST_REPO_ROOT` when starting monitor |
| --- | --- | --- |
| In-place | `$REPO_ROOT` | same |
| Worktree | `$WORKTREE_DIR` | **`$WORKTREE_DIR`** (artifacts live in worktree) |

The monitor must watch the same tree the loop edits. Wrong root = wrong
`docs/code-review/` scope.

## Stop

```bash
bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" stop --pr <n>
```

Stop when: PR merged, user says stop, or replacing with a new PR number.

## Forbidden

- Hand-rolled `while true; pnpm pr-review-status` loops in chat (use daemon)
- **Adding review-loop or promotion watcher `.sh` / `.mjs` scripts inside
  the app repo** — orchestration lives only in the Sea Trials plugin
  (`$ST_PLUGIN_ROOT/scripts/hooks/`). App repos keep `pnpm` wiring +
  `docs/code-review/<scope>/` runtime artifacts only.
- Stopping after 1–2 `WAIT` polls ("bots usually respond by now")
- Waiting for Codex when CI is red
- Multiple daemons for the same PR (PID lock)
- Ending the agent turn on `>>> ACTION:` without fix + ack
