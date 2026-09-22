---
name: st-pr-review-loop-inplace
description: >-
  Autonomous PR review loop that resolves every open review thread in
  the current Sea Trials checkout (no worktree). Use when the user asks
  for an in-place review loop, "fix reviews here", "PR review loop
  in-place", or to clear review threads on the current branch without a
  worktree. Enforces a 30-minute bot-silence window, project-directory
  lock, and pre-push-harden before every push. Prefers zero questions:
  auto-merges origin when push is rejected, fixes regressions, re-pushes.
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


# PR Review Loop (In-Place)

Resolve every unresolved PR review thread **directly in this project's
checkout** (`$REPO_ROOT`). No worktree, no temp dirs. Leave the
checkout clean and fully pushed when done.

**Read first, in order:**

1. [`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)
   — `$ST_REVIEW*` paths, fan-out rules, bot reply format, hard stops.
2. [`references/shared/review-loop-body.md`](references/shared/review-loop-body.md)
   — the loop itself. **Follow it exactly.** This file only adds the
   in-place mode rules below; it never overrides the body.

## Mode: in-place

| Setting | Value |
| --- | --- |
| `$ACTIVE_ROOT` | `$REPO_ROOT` (`git rev-parse --show-toplevel`) |
| Staging | **Full tree:** `git add -A` from `$REPO_ROOT` (see below) |
| Branch policy | Must already be on the PR branch; never switch |
| Cleanup | None — checkout stays on `$PR_BRANCH`, clean, pushed |

### When to use which skill

| Situation | Skill |
| --- | --- |
| Clean tree, already on PR branch, fix here | **This skill** |
| Dirty tree, wrong branch, or isolation required | `st-pr-review-loop-worktree` |
| About to push any branch (proactive) | `st-pre-push-harden` |

### Preflight (before Step 1 of the body)

1. `REPO_ROOT=$(git rev-parse --show-toplevel)`; `cd "$REPO_ROOT"`.
2. `CURRENT_BRANCH=$(git branch --show-current)` — empty (detached) →
   stop.
3. `PR_BRANCH=$(gh pr view <n> --json headRefName -q .headRefName)`.
   If `"$CURRENT_BRANCH" != "$PR_BRANCH"` → stop; suggest the worktree
   skill. Do **not** auto-switch.
4. Dirty tree (`git status --porcelain` non-empty):
   - Autonomy already granted → commit the full working tree (Commit
     policy) and continue.
   - Else ask **once** via the host structured-question tool: Commit
     all (Recommended) / Stash / Discard / Use worktree / Abort.
     Discard needs a second confirm. Tree must be clean afterward.
5. `git fetch origin "$PR_BRANCH"` — remote ahead/diverged → Sync
   recovery from the contract (gate included). Do not push yet unless
   nothing else is pending.

### Commit policy (in-place only)

In-place runs share one checkout with parallel agents and local WIP.
**Every push must include the entire pending working tree**, not only
files touched for review threads.

1. Inspect `git status --porcelain` from `$REPO_ROOT`.
2. Stage **all** repo changes with `git add -A` — never path-by-path
   for review fixes alone.
3. **Never** stage secrets or local-only env: `.secrets/**`, untracked
   `.env`, `*.pem`, credential JSON. If status is *only* forbidden
   paths, skip `git add -A` and leave them untracked.
4. One commit per push round (review fixes + any other agent edits).
   Split only merge-recovery from review work when both exist.

The worktree skill keeps **explicit-path** staging; only in-place uses
this full-tree policy.

### Autonomy policy

**Default: do not ask. Just finish.**

- Infer PR number/URL from the message or `gh pr view --json number`.
- Sync, merge, gate, fix, commit, push, and watch **without** asking.
- Structured question only for irreversible/unknowable blockers
  (dirty-tree preflight above; discard confirm). Never plain-chat
  option lists.
- Never ask about non-fast-forward / origin ahead — Sync recovery.
- Never ask permission to push review-fix commits.

## Run the body

Execute `references/shared/review-loop-body.md` Steps 1–6 from
`$REPO_ROOT` until a hard stop condition holds. Every Shell
`working_directory`, Read/Edit path, and `pnpm`/`melos`/`dart`/`flutter`
call uses absolute paths under `$REPO_ROOT`.

## Final verification

1. `node "$ST_REVIEW_STATUS" -- --pr <n>` → exit `0` (threads clear,
   CI green, `settled.state` = `DONE`).
2. `git status --porcelain` → empty.
3. `git rev-list HEAD..origin/$PR_BRANCH --count` → 0 and
   `git rev-list origin/$PR_BRANCH..HEAD --count` → 0.
4. `git branch --show-current` → `$PR_BRANCH`; toplevel → `$REPO_ROOT`.

## Final report

- Preflight + dirty-tree handling
- Sync/merge recoveries (count, SHAs)
- Threads fixed / replied / resolved; remaining unresolved (must be 0)
- Gate lanes per round: pass/fail summary
- Push gate exit codes and pushed SHA(s)
- Watcher: settled states reached, CI pass/fail/pending, final quiet
  window duration
- Final verification results
