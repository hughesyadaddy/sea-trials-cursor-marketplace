---
name: pr-review-loop-inplace
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

Autonomous resolution for every unresolved PR review thread, working
**directly in this project's checkout** (`$REPO_ROOT`). No worktree.
No temp dirs. Leave the checkout clean and fully pushed when done.

**Before Phase 0:** read
[`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md).
Resolve `$ST_REVIEW`, `$ST_REVIEW_LOOP`, `$ST_REVIEW_STATUS`, and
`$ST_REVIEW_PUSH` per the contract's **Sea Trials plugin CLI** section.
That contract is binding — especially the **30-minute silence** and
**project directory lock**.

## Autonomy policy

**Default: do not ask. Just finish.**

- Infer PR number/URL from the user message or
  `gh pr view --json number`.
- Sync, merge, harden, fix, commit, push, and poll **without** asking.
- Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) only for irreversible / unknowable blockers
  (dirty-tree preflight unless autonomy was already granted; discard
  confirm). Never invent plain-chat option lists.
- Never ask about non-fast-forward / origin ahead — use Sync recovery.
- Never ask permission to push review-fix commits from this skill.

## When to use which skill

| Situation | Skill |
| --- | --- |
| Clean tree, already on PR branch, fix here | **This skill** |
| Dirty tree, wrong branch, or isolation required | `pr-review-loop-worktree` |
| About to push any branch (proactive) | `pre-push-harden` |

If Phase 0 fails on branch mismatch → stop (do not auto-switch). Tell
the user to switch or run `pr-review-loop-worktree`.

## Context

- **Working directory:** `$REPO_ROOT` only (Sea Trials monorepo root)
- **Scope:** every unresolved review thread
- **Standard:** minimal diff, zero regression, zero open threads,
  30 minutes silence after last push, harden-green before every push

## Commit policy (in-place only)

In-place runs share one checkout with parallel agents and local WIP.
**Every push must include the entire pending working tree**, not only
files touched for review threads.

Before each review-round commit (Phase 4, Sync recovery, Phase 0 dirty-tree
commit):

1. From `$REPO_ROOT`, inspect `git status --porcelain`.
2. Stage **all** repo changes: `git add -A` (tracked + untracked that
   belong in git). Do **not** stage path-by-path for review fixes alone.
1. **Never** stage secrets or local-only env:
   - `.secrets/**`, untracked `.env`, `*.pem`, credentials JSON, etc.
   - If status is *only* forbidden paths, skip `git add -A`; resolve or
     leave them untracked — do not commit secrets.
4. One commit per push round is the default (bundle review fixes + any
   other agent edits). Split commits only for merge-recovery vs review
   work when both exist in one batch.

Worktree skill (`pr-review-loop-worktree`) keeps **explicit-path**
staging — only in-place uses this full-tree policy.

## Execution model

- `gh` for discovery / reply / resolve
- **Repo hooks** for threads + CI gates (mandatory on Sea Trials):
  - `node "$ST_REVIEW_STATUS" -- --pr <n>` — one-shot snapshot
  - `node "$ST_REVIEW_LOOP" -- --pr <n> --interval 15 --silence 30` — background watch
  - `node "$ST_REVIEW_PUSH" -- --pr <n>` — `agent-prepush` → `git push`
- **Task** subagents for parallel triage when **5+** unresolved threads
  (parent applies edits). For Codex/Bugbot threads, run adversarial
  validation before accepting findings.
- Do **not** write custom one-off poll scripts; use the hooks above.
- Before every push: run **`pre-push-harden`**, then
  **`node "$ST_REVIEW_PUSH" -- --pr <n>`** (or `agent-prepush` + `git push`
  from `$REPO_ROOT`).

---

## Sync & push recovery

Whenever local `$PR_BRANCH` and `origin/$PR_BRANCH` diverge, or push is
rejected as non-fast-forward:

1. `git fetch origin "$PR_BRANCH"`
2. `git merge --ff-only "origin/$PR_BRANCH"` when possible
3. Else `git merge --no-edit "origin/$PR_BRANCH"` (never rebase+force)
4. Resolve conflicts with the smallest correct merge
5. Run **`pre-push-harden`**; fix until READY; commit per **Commit policy**
6. `git push origin HEAD:$PR_BRANCH` (no `--force`, no `--no-verify`)
7. Retry up to **5** times on races; then report the exact error

---

## Phase 0 — Pre-flight

1. `REPO_ROOT=$(git rev-parse --show-toplevel)` and `cd "$REPO_ROOT"`.
2. `CURRENT_BRANCH=$(git branch --show-current)` — empty (detached) →
   abort.
3. `PR_BRANCH=$(gh pr view <n> --json headRefName -q .headRefName)`.
4. If `"$CURRENT_BRANCH" != "$PR_BRANCH"` → abort (suggest worktree).
5. Dirty tree (`git status --porcelain` non-empty):
   - Autonomy already granted → commit full working tree (Commit policy),
     continue.
   - Else **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) once: Commit all (Recommended) / Stash /
     Discard / Use worktree / Abort. Discard needs a second confirm.
   Tree must be empty afterward (everything committed or stashed).
6. `git fetch origin "$PR_BRANCH"` — if remote ahead/diverged, run Sync
   recovery (harden included). Do not push yet unless nothing else to do.

---

## Phase 1 — Full discovery

1. `gh pr view <n> --json title,body,state,headRefName,baseRefName`
2. List every review thread (paginated threads **and** full comment
   chains) via the canonical helper — do **not** hand-roll `gh api`:

   ```bash
   node "$ST_REVIEW" list --pr <n> \
     --repo hughesyadaddy/sea_trials_universal
   ```

   Add `--json` when you need machine-readable output. The helper
   paginates past 100 threads and loads every reply in each chain.

3. Manifest = **unresolved** only. Zero → still Phase 5 once, then 6.

---

## Phase 2 — Independent triage & fix

For each unresolved thread (or parallel triage when 5+):

1. Read the full comment chain.
2. Inspect the diff hunk **and** the file at HEAD (hunks go stale).
3. Classify: (a) valid → smallest fix; (b) already fixed → SHA;
   (c) intentional → rationale; (d) incorrect → evidence-based rebuttal.

Constraints: minimal, no drive-bys, architecture preserved, only files
relevant to that thread. Batch all code fixes before a single harden +
push (one push per bot round).

---

## Phase 3 — Reply & resolve

**Before replying:** run adversarial vet (Task subagents when 5+ threads).
Every reply MUST use `formatBotReviewReply` / `node "$ST_REVIEW" format`
so Codex sees **VALID / REJECT / STALE** — not bare "Fixed in …" or silent
resolves. See `shared/review-loop-contract.md` → Bot reply format.

Use the helper for every thread — it replies in-thread (`in_reply_to`),
resolves via GraphQL, verifies from a fresh read, and retries resolve
safely if the reply already posted:

```bash
BODY=$(node "$ST_REVIEW" format \
  --verdict reject \
  --summary "<evidence-based rebuttal>")

node "$ST_REVIEW" close --pr <n> \
  --repo hughesyadaddy/sea_trials_universal \
  --thread <PRRT_kwDO...> --body "$BODY"
```

Every thread: reply + resolve. No exceptions. Do **not** call
`gh api` REST/GraphQL for reply or resolve directly.

---

## Phase 4 — Harden, commit, push

1. `git status --porcelain` — review fixes **and** any other pending
   edits (other agents, WIP in this checkout).
2. Stage per **Commit policy** (`git add -A` from `$REPO_ROOT`, minus
   secrets). Include untracked files that belong in the repo.
3. Commit with a clear review-round message (mention review threads;
   note bundled non-review files in the body if present).
4. Run **`pre-push-harden`** from `$REPO_ROOT` until READY.
1. **`node "$ST_REVIEW_PUSH" -- --pr <n>`** from `$REPO_ROOT` (runs
   `agent-prepush`, then `git push` with prepush hook). Exit `8` after push
   means CI pending — continue to Phase 5, do not treat as failure.
6. On rejection → Sync recovery. No AskQuestion (Cursor; AskUserQuestion on Claude Code).
7. Record push timestamp (UTC). **This resets the 30-minute timer.**

---

## Phase 5 — Bot review + CI polling (30-minute silence)

**Start background watch** (leave running for the full silence window):

```bash
node "$ST_REVIEW_LOOP" -- --pr <n> --interval 15 --silence 30
```

While the loop runs (or between agent turns if hooks unavailable):

1. Record last push timestamp (UTC).
1. **`node "$ST_REVIEW_STATUS" -- --pr <n>`** — threads + CI on HEAD.
3. Triage **every unresolved thread** — do **not** require
   `thread.createdAt > last_push`. Bots often reply on existing threads.
   Also treat reopened threads (any comment after last push + unresolved)
   as new work.
1. **CI gate:** all checks must pass on current `headRefOid`. Pending
   is OK during the window; **fail** → fix or re-run flake, then push
   and reset timer. Light jobs (`ci-script-tests`, `dart-static`,
   `lint-migrations`, etc.) surface first in status output.
5. New thread or CI fail → Phase 2–4 → reset timer from the new push.
6. Complete only when **30 continuous minutes** elapsed since last push
   **and** every poll showed zero unresolved threads **and** CI green
   on HEAD.

If `node "$ST_REVIEW_LOOP"` exits `2` or `3`, read
`docs/code-review/<scope>/pr-review-queue.json` and resume fixes
**autonomously** (no AskQuestion). Fix every queued thread, push,
reply+resolve, then **restart** the background watcher.

When a background terminal is already running the watcher, treat exit
`2`/`3` as the signal to wake this skill — same as the user saying
"fix the new Codex reviews". Never ask permission to continue.

Do **not** exit early. Do **not** stop after one clean poll. Do **not**
substitute a 10/15-minute window. Do **not** declare done with CI
pending or failing on HEAD.

---

## Phase 6 — Final verification

1. `node "$ST_REVIEW_STATUS" -- --pr <n>` → exit `0` (threads clear, CI green)
2. `git status --porcelain` → empty
3. `git rev-list HEAD..origin/$PR_BRANCH --count` → 0
4. `git rev-list origin/$PR_BRANCH..HEAD --count` → 0
5. `git branch --show-current` → `$PR_BRANCH`
6. `pwd` / toplevel → `$REPO_ROOT`

---

## Non-negotiable rules

1. Do not skip any unresolved thread.
2. No unrelated refactors.
3. No regressions; harden before every push.
4. Zero unresolved threads at completion.
5. Evaluate independently — do not rubber-stamp bots.
6. Do not switch branches.
7. Prefer zero questions (AskQuestion (Cursor; AskUserQuestion on Claude Code) only as Phase 0 allows).
8. In-place: **full working tree** commits per Commit policy (not
   path-scoped `git add`). Worktree skill keeps explicit paths.
9. Full **30-minute** silence after last push — no shorter substitute.
10. Never `--force` / `--no-verify`.
11. Stay inside `$REPO_ROOT` for all file and tool operations.

---

## Final report

- Pre-flight + dirty-tree handling
- Sync/merge recoveries (count, SHAs)
- Threads fixed / replied / resolved
- Remaining unresolved (must be 0)
- Harden runs: pass/fail summary before each push
- Push gate: `ST_REVIEW_PUSH` exit codes
- Polling: `ST_REVIEW_LOOP` / status iterations, CI pass/fail/pending,
  new reviews, final silence duration
- Phase 6 checks
