---
name: st-pr-review-loop-worktree
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

Resolve every unresolved PR review thread inside an **isolated git
worktree under this project**. The user's current branch, uncommitted
files, and IDE state stay untouched.

**Read first, in order:**

1. [`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)
   — `$ST_REVIEW*` paths, fan-out rules, bot reply format, hard stops.
2. [`references/shared/review-loop-body.md`](references/shared/review-loop-body.md)
   — the loop itself. **Follow it exactly.** This file only adds the
   worktree mode rules below; it never overrides the body.

## Mode: worktree

| Setting | Value |
| --- | --- |
| `$ACTIVE_ROOT` | `$WORKTREE_DIR` under `$REPO_ROOT/.review-worktrees/` |
| Staging | **Explicit paths only** (`git add <path>…`) |
| Branch policy | Throwaway local branch `review-loop/<PR_BRANCH>`; push `HEAD:$PR_BRANCH` |
| Cleanup | Remove the worktree; verify the user checkout is unchanged |

### When to use which skill

| Situation | Skill |
| --- | --- |
| Dirty tree, wrong branch, or isolation required | **This skill** (default safe) |
| Clean tree, already on PR branch, fix here | `st-pr-review-loop-inplace` |
| About to push any branch (proactive) | `st-pre-push-harden` |

### Setup (before Step 1 of the body)

Do **not** modify the user's current branch or working tree.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
USER_BRANCH=$(git -C "$REPO_ROOT" branch --show-current)
USER_STATUS=$(git -C "$REPO_ROOT" status --porcelain)
PR_NUMBER=<number>
PR_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName -q .headRefName)

git fetch origin "$PR_BRANCH"

# Project-local worktree — monorepo tools need the tree layout here.
WORKTREE_PARENT="$REPO_ROOT/.review-worktrees"
mkdir -p "$WORKTREE_PARENT"
WORKTREE_DIR="$WORKTREE_PARENT/${PR_BRANCH//\//-}-$(date -u +%Y%m%dT%H%M%SZ)"

# Git allows a branch in one worktree only; pushes use HEAD:$PR_BRANCH.
WORKTREE_BRANCH="review-loop/${PR_BRANCH}"
git worktree add -B "$WORKTREE_BRANCH" "$WORKTREE_DIR" "origin/$PR_BRANCH"
cd "$WORKTREE_DIR"
CI=true pnpm bootstrap   # l10n, node_modules, linter — gate needs them
```

Confirm before the first edit:

1. `pwd` is `$WORKTREE_DIR`, under `$REPO_ROOT/.review-worktrees/`.
2. `git branch --show-current` equals `$WORKTREE_BRANCH`.
3. `git status --porcelain` empty; `git config core.hooksPath` →
   `.husky`.
4. User `$REPO_ROOT` status unchanged vs `$USER_STATUS`.

Creation failure → stop and report. Never fall back to in-place
silently. When `origin/$PR_BRANCH` moves ahead during the loop → Sync
recovery **inside `$WORKTREE_DIR`**.

### Autonomy policy

**Default: do not ask. Just finish.**

- Infer PR number/URL from the message or `gh pr view`.
- Create the worktree, sync, merge, gate, fix, commit, push, and watch
  **without** asking.
- Structured question only for irreversible blockers (force-removing
  a dirty worktree unless already authorized).
- Never ask about non-fast-forward / origin ahead — Sync recovery.
- Never ask permission to push review-fix commits.

## Run the body

Execute `references/shared/review-loop-body.md` Steps 1–6 from
`$WORKTREE_DIR` until a hard stop condition holds. All file ops use
absolute paths under `$WORKTREE_DIR`; `pnpm`/`melos` run from that
worktree root. Never edit, commit, or push from `$REPO_ROOT`; never
merge into the user's local branch.

## Teardown & original-checkout verification

1. Remove the worktree:

   ```bash
   cd "$REPO_ROOT"
   git worktree remove "$WORKTREE_DIR"
   git worktree prune
   ```

   If remove fails (dirty leftover): finish commit/push recovery in the
   worktree first. Still blocked → ask once via the host
   structured-question tool: Force remove (Recommended) / Leave it.

2. Verify the user checkout is undisturbed: still on `$USER_BRANCH`;
   `git status --porcelain` matches `$USER_STATUS`; no
   stash/reset/clean/switch happened in `$REPO_ROOT`.

## Final report

- Worktree path; cleanup status; original checkout intact (evidence)
- Sync/merge recoveries (count, SHAs)
- Threads fixed / replied / resolved; remaining unresolved (must be 0)
- Gate lanes per round: pass/fail summary
- Push gate exit codes and pushed SHA(s) on `$PR_BRANCH`
- Watcher: settled states reached, CI pass/fail/pending, final quiet
  window duration
