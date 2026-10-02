---
name: st-pr-promote
description: >-
  Promote a branch through an open promotion PR (e.g. Dev to STG) until
  merge-ready. Starts the 24h PR review monitor in a Cursor background
  terminal, then runs the autonomous review loop (worktree by default)
  on every CI failure or Codex thread — fix immediately, never wait for
  the next bot pass. Use when the user says promote, ship to staging,
  STG from Dev, merge-ready promotion PR, or shares a promotion PR link.
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


# PR Promote (`/st-pr-promote`)

Get a **promotion PR** (e.g. `STG <- Dev`, `main <- stg`) to
**merge-ready**: CI green on HEAD, zero unresolved bot threads.

This skill composes:

1. **`/st-pr-review-monitor`** — 24h watch in Cursor's background
   terminal (`>>> ACTION:` on CI fail or threads)
2. **`/st-pr-review-loop-worktree`** (default) or **`-inplace`** —
   fix pipeline

**Read:**

- [`references/shared/review-loop-monitor.md`](references/shared/review-loop-monitor.md)
- [`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)
- [`references/shared/review-loop-body.md`](references/shared/review-loop-body.md)

## Autonomy

Default: **finish without asking**. Promotion PRs are high-stakes —
CI failures are fixed **immediately** when the monitor fires
`ci-fail`; do not wait for Codex.

## Phase 1 — Identify promotion PR

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
```

| Input | Action |
| --- | --- |
| PR URL / number | `PR_NUM=<n>` |
| "Promote dev to stg" | `gh pr list --base stg --head dev --json number` or open one |
| Branch only | `gh pr view --json number` on current branch |

Record: `PR_NUM`, base branch, head branch, title.

## Phase 2 — Start monitor (mandatory)

Invoke **`/st-pr-review-monitor`** now with the PR number. The monitor
must be running **before** the first fix round.

For worktree promotion loops, set `ST_REPO_ROOT` to `$WORKTREE_DIR`
when starting the monitor (Phase 1 of worktree skill).

## Phase 3 — Choose loop mode

| Condition | Skill |
| --- | --- |
| Dirty tree, wrong branch, or WIP | `/st-pr-review-loop-worktree` |
| Clean on promotion head branch | `/st-pr-review-loop-inplace` |

Default: **worktree** (safe for promotion; leaves user checkout alone).

## Phase 4 — Run until merge-ready

```text
monitor AWAIT → ACTION → loop Steps 2–6 → ack → AWAIT → … → GREEN
```

**Hard completion** (all required):

1. `>>> GREEN:` from daemon (0 threads, CI green)
2. `pnpm pr-review-status -- --pr <n>` confirms
3. PR `mergeable=MERGEABLE`, `mergeState=CLEAN` (or report blocker)

Do **not** stop after one green poll if threads or CI regress on the
next push.

## Phase 5 — Promotion-specific rules

- **Sync recovery** before every push (promotion branches race often)
- **One push per bot round** — batch promotion fixes
- **Flake routing** — `/st-flake-quarantine` only when local gate green
  and failure not in PR diff
- **Never bare `git push`** — `pnpm pr-review-push -- --pr <n>` only
- **Merge** — report merge-ready; user or GitHub merges (out of scope
  unless explicitly asked)

## Forbidden

- Waiting for Codex while CI is red
- Stopping the monitor when `pr-review-loop` exits (loop is single-pass;
  daemon keeps watching)
- Hand-rolled poll loops in chat
- `--no-verify` / force-push on promotion branches

## Final report

- Promotion: `<head> → <base>`, PR link
- Monitor uptime / ACTION rounds (ci-fail vs threads)
- Threads fixed / SHAs pushed
- CI status on HEAD
- **Merge-ready: yes/no** with evidence
