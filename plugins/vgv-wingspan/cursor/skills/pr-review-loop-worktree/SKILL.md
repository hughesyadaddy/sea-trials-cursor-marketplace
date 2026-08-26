---
name: pr-review-loop-worktree
description: >-
  Autonomous PR review loop that resolves every open review thread
  inside an isolated git worktree under this Sea Trials repo
  (.review-worktrees/). Use when the user asks for a PR review loop,
  "fix reviews in a worktree", wants isolation from the current
  checkout, or the working tree is dirty / on the wrong branch.
  Enforces a 30-minute bot-silence window, project-local worktree
  (not bare /tmp), and pre-push-harden before every push. Leaves the
  user's original checkout untouched.
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


# PR Review Loop (Worktree)

Autonomous resolution for every unresolved PR review thread, working in
an **isolated git worktree under this project**. The user's current
branch, uncommitted files, and IDE state must remain untouched.

**Before Phase 0:** read
[`../shared/review-loop-contract.md`](../shared/review-loop-contract.md)
(or `references/shared/review-loop-contract.md` after install). That
contract is binding — especially the **30-minute silence**,
**project-local worktree**, and **pre-push-harden** rules.

## Autonomy policy

**Default: do not ask. Just finish.**

- Infer PR number/URL from the user message or `gh pr view`.
- Create the worktree, sync, merge, harden, fix, commit, push, and poll
  **without** asking.
- Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) only for irreversible blockers (force-remove
  dirty worktree cleanup unless already authorized).
- Never ask about non-fast-forward / origin ahead — Sync recovery.
- Never ask permission to push review-fix commits from this skill.

## When to use which skill

| Situation | Skill |
| --- | --- |
| Dirty tree, wrong branch, or isolation required | **This skill** (default safe) |
| Clean tree, already on PR branch, fix here | `pr-review-loop-inplace` |
| About to push any branch (proactive) | `pre-push-harden` |

## Context

- **User checkout:** `$REPO_ROOT` — never edit/commit/push here
- **Working directory:** `$WORKTREE_DIR` under
  `$REPO_ROOT/.review-worktrees/` (full monorepo worktree)
- **Scope:** every unresolved review thread
- **Standard:** minimal diff, zero regression, zero open threads,
  30 minutes silence after last push, harden-green before every push

## Execution model

- `gh` from any cwd (repo-aware via remote)
- All file ops inside `$WORKTREE_DIR` (absolute paths)
- **Repo hooks** from `$WORKTREE_DIR` for threads + CI gates:
  - `pnpm pr-review-status -- --pr <n>`
  - `pnpm pr-review-loop -- --pr <n> --interval 15 --silence 30`
  - `pnpm pr-review-push` (after commit; runs from worktree root)
- **Task** subagents when **5+** unresolved threads; adversarial
  validation for Codex/Bugbot findings
- Aligns with `git-safe-worktree`: no checkout/switch/pull on the
  user's primary worktree
- Before every push: **`pre-push-harden`** then **`pnpm pr-review-push`**
  from `$WORKTREE_DIR`

---

## Sync & push recovery

Run **inside `$WORKTREE_DIR`** when the worktree and
`origin/$PR_BRANCH` diverge or push is rejected:

1. `git fetch origin "$PR_BRANCH"`
2. `git merge --ff-only "origin/$PR_BRANCH"` when possible
3. Else `git merge --no-edit "origin/$PR_BRANCH"` (never rebase+force)
4. Resolve conflicts with the smallest correct merge
5. Run **`pre-push-harden`** from `$WORKTREE_DIR`; fix until READY
6. `git push origin HEAD:$PR_BRANCH`
7. Up to **5** race retries; then report. No AskQuestion (Cursor; AskUserQuestion on Claude Code) about merge.

Forbidden: recovery from `$REPO_ROOT`; skipping harden after merge.

---

## Phase 0 — Project-local worktree setup

Do **not** modify the user's current branch or working tree.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
USER_BRANCH=$(git -C "$REPO_ROOT" branch --show-current)
USER_STATUS=$(git -C "$REPO_ROOT" status --porcelain)
PR_NUMBER=<number>
PR_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName -q .headRefName)

git fetch origin "$PR_BRANCH"

# Project-local worktree (never bare /tmp as the only checkout).
# Monorepo tools need the Sea Trials tree layout under this repo.
WORKTREE_PARENT="$REPO_ROOT/.review-worktrees"
mkdir -p "$WORKTREE_PARENT"
WORKTREE_DIR="$WORKTREE_PARENT/${PR_BRANCH//\//-}-$(date -u +%Y%m%dT%H%M%SZ)"

# Throwaway local branch — Git allows a branch in only one worktree.
# Phase 4 pushes with HEAD:$PR_BRANCH, so the local name is irrelevant.
WORKTREE_BRANCH="review-loop/${PR_BRANCH}"
git worktree add -B "$WORKTREE_BRANCH" "$WORKTREE_DIR" "origin/$PR_BRANCH"
cd "$WORKTREE_DIR"
```

Confirm:

1. `pwd` is `$WORKTREE_DIR` and it is under `$REPO_ROOT/.review-worktrees/`
2. `git branch --show-current` equals `$WORKTREE_BRANCH`
3. Worktree clean: `git status --porcelain` empty
4. User `$REPO_ROOT` status unchanged vs `$USER_STATUS`

If creation fails → abort and report. Do not fall back to in-place
silently. Do not AskQuestion (Cursor; AskUserQuestion on Claude Code).

When `origin/$PR_BRANCH` moves ahead during the loop → Sync recovery
inside `$WORKTREE_DIR`.

---

## Phase 1 — Full discovery

Same contract as in-place (paginated REST comments + paginated GraphQL
`reviewThreads` with nested comment `pageInfo` / REST fallback).
Manifest of unresolved only. Zero → Phase 5 once, then Phase 6 cleanup.

---

## Phase 2 — Independent triage & fix

Work **only** under `$WORKTREE_DIR`:

1. Full comment chain.
2. Diff hunk + file at worktree HEAD.
3. Classify (a)–(d) as in-place; smallest correct change only.

Batch all code fixes → one harden → one push per bot round.

---

## Phase 3 — Reply & resolve

1. Reply REST (`in_reply_to` = original `databaseId`).
2. Resolve GraphQL `resolveReviewThread` (`PRRT_kwDO...`).

Every thread: reply + resolve.

---

## Phase 4 — Harden, commit, push (from worktree)

Inside `$WORKTREE_DIR`:

1. Only intentional review-fix changes in `git status`.
2. Stage explicit paths only.
3. Commit with a clear review-round message.
4. Run **`pre-push-harden`** from `$WORKTREE_DIR` until READY.
5. Run **`pre-push-harden`** from `$WORKTREE_DIR` until READY.
1. **`pnpm pr-review-push`** from `$WORKTREE_DIR` (`agent-prepush` +
   `git push`). Exit `8` = CI pending — continue Phase 5.
7. On rejection → Sync recovery inside `$WORKTREE_DIR`.
8. Record push timestamp (UTC) — **resets the 30-minute timer**.

Do **not** push from `$REPO_ROOT`. Do **not** merge into the user's
local branch as part of this skill.

---

## Phase 5 — Bot review + CI polling (30-minute silence)

Start background watch from `$WORKTREE_DIR`:

```bash
cd "$WORKTREE_DIR"
pnpm pr-review-loop -- --pr <n> --interval 15 --silence 30
```

1. Record last push timestamp (UTC).
1. **`pnpm pr-review-status -- --pr <n>`** — threads + CI on HEAD.
3. Triage **every unresolved thread** (not `createdAt`-only). Catch
   reopened threads whose latest comment is after last push.
1. **CI gate:** all checks green on HEAD before completion.
5. New thread or CI fail → Phase 2–4 → reset timer.
6. Complete only after **30 continuous minutes** of silence from the
   **last** push with zero unresolved threads **and** CI green on HEAD
   on every poll.

If `pr-review-loop` exits `2` or `3`, read
`docs/code-review/<scope>/pr-review-queue.json` and resume fixes
**autonomously** (no AskQuestion / AskUserQuestion). Fix every queued
thread, push, reply+resolve, then **restart** the background watcher
from `.

When a background terminal is already running the watcher, treat exit
`2`/`3` as the signal to wake this skill — same as the user saying
"fix the new Codex reviews". Never ask permission to continue.

Do **not** exit early. Do **not** use a 10/15-minute substitute. Do
**not** declare done with CI pending or failing.

---

## Phase 6 — Cleanup & original-checkout verification

1. Return and remove the worktree:

   ```bash
   cd "$REPO_ROOT"
   git worktree remove "$WORKTREE_DIR"
   ```

   If remove fails (dirty leftover): finish/commit/push recovery in the
   worktree first. If still blocked → **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) once:
   Force remove (Recommended) / Leave it.

2. Verify user checkout undisturbed:
   - Still on `$USER_BRANCH`
   - `git status --porcelain` matches `$USER_STATUS`
   - No stash/reset/clean/switch in `$REPO_ROOT`

3. Report cleanup status + whether original checkout stayed intact.

---

## Non-negotiable rules

1. Do not skip any unresolved thread.
2. No unrelated refactors.
3. No regressions; harden before every push.
4. Zero unresolved threads at completion.
5. Evaluate independently — do not rubber-stamp bots.
6. Never edit/commit/push from the user's primary checkout.
7. Never switch/stash/reset/clean the user's primary checkout.
8. Prefer zero questions (AskQuestion (Cursor; AskUserQuestion on Claude Code) only for force-remove).
9. Explicit paths only for `git add`.
10. Full **30-minute** silence after last push — no shorter substitute.
11. Never `--force` / `--no-verify`.
12. Worktree MUST live under `$REPO_ROOT/.review-worktrees/`.
13. Always clean up the worktree (or report if blocked).

---

## Final report

- Worktree path; cleanup status
- Original checkout intact? (yes/no + evidence)
- Sync/merge recoveries
- Threads fixed / replied / resolved
- Remaining unresolved (must be 0)
- Harden runs: pass/fail before each push
- Push gate: `pr-review-push` exit codes
- Polling: loop/status iterations, CI pass/fail/pending, new reviews,
  final silence duration
- Push SHA(s) on `$PR_BRANCH`
