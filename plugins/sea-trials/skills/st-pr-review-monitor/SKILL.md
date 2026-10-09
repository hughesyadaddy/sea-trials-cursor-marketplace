---
name: st-pr-review-monitor
description: >-
  Start and run the 24h PR review monitor in a Cursor background
  terminal. Wakes the agent immediately on CI failure or open review
  threads via >>> ACTION sentinels and signal files. Use when promoting
  a PR, shipping, or any long PR review session where the watch must
  survive for hours without dying when a single poll hands off. Works
  with worktree and in-place checkouts. Pair with st-pr-review-loop-*.
disable-model-invocation: true
user-invocable: true
---

<!-- CURSOR_VGV_PORT -->
> **Dual-host port:** use the host structured question
> tool — **AskQuestion** on Cursor, **AskUserQuestion**
> on Claude Code. Prefer whichever exists in the tool
> schema. Never ask option lists as plain chat text when
> a structured question tool is available.
> On Cursor: continue handoffs in this chat (Plan now /
> Build now). Never output `/clear` or `/new-chat`.
> On Claude Code: clear-context handoffs remain valid.


# PR Review Monitor (`/st-pr-review-monitor`)

Start the **24h daemon** in Cursor's terminal and **stay on task** until
the PR is merge-ready or the user stops you.

**Read:**

1. [`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)
2. [`references/shared/review-loop-monitor.md`](references/shared/review-loop-monitor.md)
3. [`references/shared/review-loop-body.md`](references/shared/review-loop-body.md)
   — Steps 2–6 when `>>> ACTION:` fires

## Autonomy

Default: **do not ask**. Start the monitor, `Await` on ACTION, fix CI
and threads immediately, ack, repeat. Never tell the user to "check back
later".

## Phase 0 — Resolve PR and active root

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
# worktree loops: ACTIVE_ROOT=$WORKTREE_DIR (see st-pr-review-loop-worktree)
ACTIVE_ROOT="${ACTIVE_ROOT:-$REPO_ROOT}"
PR_NUM=<from message or gh pr view>
```

## Phase 1 — Start monitor (once)

Check for an existing daemon:

Resolve `$ST_PLUGIN_ROOT` per `review-loop-contract.md` (bootstrap block;
`print-st-plugin-root.mjs` + Team Marketplace — no repo vendoring).

```bash
bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" \
  status --pr "$PR_NUM" \
  || bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" \
       start --pr "$PR_NUM" --daemon -- --duration 24h
```

**Also** start a **visible Cursor background terminal** (Shell tool,
`block_until_ms: 0`) tailing the daemon log or running the foreground
daemon:

```bash
cd "$ACTIVE_ROOT" && ST_REPO_ROOT="$ACTIVE_ROOT" \
  node "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs" \
  --pr "$PR_NUM" --duration 24h
```

Save the **terminal task id** for `Await`.

## Phase 2 — Watch loop (parent stays in this chat)

```text
Await(terminal_id, pattern: ">>> ACTION:")
  → read pr-review-queue.json + acting.signal
  → ci-fail: fix NOW (Steps 3–6, skip Codex wait)
  → threads: Steps 2–6 full loop
  → touch pr-<n>-handoff.ack
  → goto Await
```

On session resume: if `acting.signal` starts with `CI_FAIL` or
`THREADS`, run Phase 3 without waiting for a new sentinel.

## Phase 3 — Act (delegate to review-loop body)

| Sentinel | Route |
| --- | --- |
| `ci-fail` | Root-cause fix → gate fan-out → `pr-review-push` → ack |
| `threads` | Triage → adversarial vet → fix fan-out → gate → push → reply+resolve → ack |
| `GREEN` | Report status; keep watching if user wants merge-ready hold |

After every push: **do not restart the daemon** — it keeps running.
Write ack:

```bash
SCOPE=$(gh pr view "$PR_NUM" --json headRefName -q .headRefName | tr '/' '-')
touch "$ACTIVE_ROOT/docs/code-review/$SCOPE/pr-${PR_NUM}-handoff.ack"
```

## Phase 4 — Pair with loop skills

| User intent | Monitor + |
| --- | --- |
| Dirty / wrong branch | `/st-pr-review-loop-worktree` (set `ST_REPO_ROOT=$WORKTREE_DIR`) |
| Clean on PR branch | `/st-pr-review-loop-inplace` |
| Promote dev→stg | `/st-pr-promote` |

The monitor runs **in parallel** with the fix loop — it wakes you; the
loop skill defines *how* to fix.

## Phase 5 — Stop

```bash
bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" stop --pr "$PR_NUM"
```

When PR is merged or user says stop.

## Final report

- Monitor: pid, log path, webhook on/off
- ACTION rounds: ci-fail vs threads counts
- Last `>>> GREEN:` line
- Merge-ready? (0 threads, CI green on HEAD)
