---
name: pr-ship
description: >-
  Intent router for "get this PR merge-ready". Detects PR state, picks
  worktree vs in-place, then delegates to /pre-push-harden and
  /pr-review-loop-worktree or -inplace. Use when the user shares a PR
  link, says ship or merge-ready or clear review threads, or wants
  end-to-end PR
  completion without remembering skill names.
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


# PR Ship (intent router)

Route to the **right existing skill** — do not re-document gate tables.

**Read:** [`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)

## Autonomy

Default: finish without asking. Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) only for
irreversible cleanup (force-remove dirty worktree).

## Phase 0 — Detect intent

| User signal | Route |
| --- | --- |
| Plan not implemented yet | `/build-with-subagents` or `/build` |
| Code done; validate before push | `/pre-push-harden` |
| PR open; clear review threads | Review loop (below) |
| Push only | `pnpm pr-review-push` |

## Phase 1 — Resolve PR

```bash
ACTIVE_ROOT=$(git rev-parse --show-toplevel)
cd "$ACTIVE_ROOT"
```

Infer PR from message or `gh pr view`. Record `PR_NUM` and base ref.

## Phase 2 — Worktree vs in-place

| Condition | Skill |
| --- | --- |
| Dirty tree, wrong branch, WIP collision | `/pr-review-loop-worktree` |
| Clean tree on PR branch | `/pr-review-loop-inplace` |

**Invoke the chosen review-loop skill now** — it owns sync, fix, harden,
push, and 30-minute CI poll.

## Phase 3 — If no review threads yet

When the user only needs gates before first push:

1. Invoke `/pre-push-harden` through READY
2. `pnpm pr-review-push` (or `$ST_REVIEW_PUSH` from contract)

## Forbidden

- Bare `git push` / `--no-verify`
- `/create-pr skip-checks`
- Re-implementing `agent-prepush` or `pr-local-ci` tables here
