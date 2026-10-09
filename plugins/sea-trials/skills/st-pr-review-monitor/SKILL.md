---
name: st-pr-review-monitor
description: >-
  Start and run the PR review monitor in a Cursor in-chat background
  terminal. Wakes this chat on CI failure or Codex/Bot threads via
  >>> ACTION sentinels, Shell notify_on_output, and Await. Runs until
  merge-ready and 60m Codex-quiet after the last push (or user stop).
  Pair with st-pr-review-loop-inplace or st-pr-review-loop-worktree.
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

Start the watch **in this chat's background terminal** and **stay on task**
until the PR is merge-ready (and Codex has been quiet for 60 minutes on the
current HEAD after the last push) or the user stops you.

**Read:**

1. [`references/shared/cursor-in-chat-monitor.md`](references/shared/cursor-in-chat-monitor.md)
   — **Cursor mandatory** (Shell + Await + notify).
2. [`references/shared/review-loop-monitor.md`](references/shared/review-loop-monitor.md)
3. [`references/shared/review-loop-body.md`](references/shared/review-loop-body.md)
   — Steps 2–6 when `>>> ACTION:` fires

## Autonomy

Default: **do not ask**. Start the in-chat monitor, loop `Await` on
`>>> ACTION:`, fix CI and threads immediately, ack, repeat. Never tell
the user to "check back later" or use an external terminal.

## Phase 0 — Resolve PR and active root

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
ACTIVE_ROOT="${ACTIVE_ROOT:-$REPO_ROOT}"
PR_NUM=<from message or gh pr view>
```

Worktree loops: set `ACTIVE_ROOT=$WORKTREE_DIR` before Phase 1.

Resolve `$ST_PLUGIN_ROOT` per `review-loop-contract.md`.

## Phase 1 — In-chat monitor (once per PR)

**Cursor — do exactly this:**

1. Stop detached daemon (does not wake chat):

   ```bash
   bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" \
     stop --pr "$PR_NUM" || true
   ```

2. **Shell** (background terminal **in this chat**):
   - `block_until_ms: 0`
   - `working_directory`: `$ACTIVE_ROOT`
   - `notify_on_output`: `{ "pattern": ">>> ACTION:", "reason": "PR review wake" }`
   - Command:

   ```bash
   ST_REPO_ROOT="$ACTIVE_ROOT" \
     node "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs" \
     --pr "$PR_NUM" \
     --duration 24h \
     --silence 60 \
     --bots codex,bugbot,coderabbit,copilot
   ```

   Add `--no-webhook --interval 180` only when offline. Default webhook
   needs `gh extension install cli/gh-webhook`.

3. Save the **terminal task id** for `Await`.

**Do not** start only `daemonctl start --daemon` in Cursor Agent chat.

## Phase 2 — Watch loop (parent stays in this chat)

```text
loop:
  Await(task_id, pattern: ">>> ACTION:", block_until_ms: 600000)
  → read pr-review-queue.json + acting.signal
  → ci-fail: fix NOW (Steps 3–6, skip Codex wait)
  → threads: Steps 2–6 full loop
  → touch pr-<n>-handoff.ack
  → continue loop (never end turn on GREEN alone)
```

On session resume: if `acting.signal` starts with `CI_FAIL` or
`THREADS`, run Phase 3 without waiting for a new sentinel.

## Phase 3 — Act (delegate to review-loop body)

| Sentinel | Route |
| --- | --- |
| `ci-fail` | Root-cause fix → gate fan-out → `pr-review-push` → ack |
| `threads` | Triage → adversarial vet → fix fan-out → gate → push → reply+resolve → ack |
| `GREEN` | Report status; **keep** `Await` — Codex may still comment |

After every push: **do not restart the daemon** — it keeps running.
Write ack:

```bash
SCOPE=$(gh pr view "$PR_NUM" --json headRefName -q .headRefName | tr '/' '-')
touch "$ACTIVE_ROOT/docs/code-review/$SCOPE/pr-${PR_NUM}-handoff.ack"
```

## Phase 4 — Pair with loop skills

| User intent | Monitor + |
| --- | --- |
| Dirty / wrong branch | `/st-pr-review-loop-worktree` (`ACTIVE_ROOT=$WORKTREE_DIR`) |
| Clean on PR branch | `/st-pr-review-loop-inplace` |
| Promote dev→stg | `/st-pr-promote` |

Loop skills **embed** this monitor — you do not need a separate skill
invocation if you follow Phase 1–2 inline.

## Phase 5 — Stop

When `node "$ST_REVIEW_STATUS" -- --pr "$PR_NUM"` exits `0` **and** 60m
Codex-quiet on HEAD, or user says stop, or PR merged:

```bash
bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" stop --pr "$PR_NUM"
```

## Final report

- In-chat terminal task id; webhook on/off
- ACTION rounds: ci-fail vs threads counts
- Last `>>> GREEN:` line
- Merge-ready? (0 threads, CI green on HEAD)
