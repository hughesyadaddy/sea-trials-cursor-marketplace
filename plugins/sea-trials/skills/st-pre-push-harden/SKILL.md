---
name: st-pre-push-harden
description: >-
  Proactive pre-push quality gate for the Sea Trials monorepo. Runs
  scoped validation, catches fix-one/break-many regressions, and
  optionally fans out review agents on the pending diff before any
  git push. Use when the user says "harden before push", "pre-push
  check", "make sure this is push-ready", "don't break other things",
  before pushing a feature branch, or when a PR review loop is about to
  push. Works in the current project checkout or inside a
  .review-worktrees/ worktree.
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


# Pre-Push Harden

Stop fix-one / break-many loops **before** bots open another review
round. Run this skill in the active repo root (user checkout or
`$REPO_ROOT/.review-worktrees/...`) and only allow `git push` when the
verdict is **READY**.

**Also read:**
[`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)
for the project-directory lock and **Sea Trials plugin CLI** (`$ST_REVIEW*`
paths) shared with the review loops.

## When to run

- User asks to harden / validate before push
- Immediately before Phase 4 push in `pr-review-loop-inplace` or
  `pr-review-loop-worktree`
- After any merge recovery that touches code
- Before opening or updating a PR when the user wants a proactive pass

## Autonomy

- Fix objective failures (analyze, format, lint, failing tests in
  touched packages) without asking.
- Do **not** push unless the caller (user or review-loop skill)
  explicitly wants a push after READY — this skill's job is the gate.
- Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) only when a fix requires a product/API
  decision or would expand far beyond the pending diff.

---

## Phase 0 — Lock the root

```bash
ACTIVE_ROOT=$(git rev-parse --show-toplevel)
cd "$ACTIVE_ROOT"
```

Confirm:

1. You are inside the Sea Trials monorepo (or a git worktree of it).
2. If this is a review-loop worktree, `ACTIVE_ROOT` is under
   `.review-worktrees/`.
3. All subsequent tool `working_directory` values and file paths are
   absolute under `$ACTIVE_ROOT`.

Forbidden: running harden against a different clone, bare `/tmp` tree,
or the user's primary checkout while a review-loop worktree is the
intended edit root.

---

## Phase 1 — Scope the diff

Resolve what is about to be pushed:

```bash
# Prefer upstream; fall back to merge-base with main/master
git fetch origin --quiet || true
BASE=$(git merge-base HEAD "origin/$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo main)" 2>/dev/null \
  || git merge-base HEAD origin/main 2>/dev/null \
  || git merge-base HEAD origin/master)
```

Collect:

1. `git diff --name-only "$BASE"...HEAD`
2. `git diff --name-only` + `git diff --cached --name-only` (uncommitted)
3. Union = `$CHANGED_FILES`

If there are no changes → verdict **READY (noop)** and stop.

Classify touched surfaces: Flutter/Dart packages, `functions/`, `web/`,
`supabase/`, `powersync/`, scripts/hooks, docs-only.

---

## Phase 2 — Single mechanical gate (mandatory)

Run from `$ACTIVE_ROOT`. **`agent-validate` is iteration-only** — it is
NOT sufficient before push. The gate runs **once**, fanned out; do not
stack `st-parallel-tasks` + `pnpm prepush` + `pr-review-push` — they
replay the same lanes.

### Always before push (non-docs changes)

1. **Emit the gate plan** (dirty tree, committed diff, PR CI parity —
   `dart-static`, `dart-analyze`, `dart-test`, script tests, …):

   ```bash
   node "$ST_REVIEW_PUSH" -- --pr <n> --list-tasks
   ```

2. **Fan out once.** Dispatch one worker per JSON line in a single
   parent turn (Cursor: `Task`; Claude Code: `Agent`; batch by 16).
   Each worker runs exactly

   ```bash
   node "$ST_PLUGIN_ROOT/scripts/hooks/run-gate-task.mjs" '<json-line>'
   ```

   honouring the line's `subagent_type` and model hints (Cursor
   `model: composer-2.5`, Claude `model: haiku`). Zero or one line →
   run inline.

3. **Fix** every red lane at the root cause, then re-run **that lane**
   (same JSON line) until green. Do not re-run the whole plan for one
   red lane.

4. **Confirm once, without pushing:**

   ```bash
   node "$ST_REVIEW_PUSH" -- --pr <n> --check-only
   ```

   This replays the plan against the committed tree and records a
   gate-pass token (`scripts/hooks/lib/gate-pass-token.mjs`). Because
   of that token the husky pre-push skips lanes already proven on an
   unchanged tree, so the caller's real `pr-review-push --pr <n>` does
   not pay for the gate twice. Any edit after this step invalidates the
   token — re-run step 4.

5. During iteration (before commit): `pnpm agent-validate` on changed
   paths is fine for fast feedback — never a substitute for steps 1–4.

6. Never suggest `--no-verify`. Never skip hooks. Never bare `git push`.

### Surface-specific

| Surface | Extra gate |
| --- | --- |
| `supabase/migrations` / PowerSync | Follow migration workflow; `powersync validate` when sync rules/schema touched |
| `functions/` | Scoped lint/test for touched functions |
| `web/` | Scoped lint/typecheck used by that app |
| Docs-only | Skip Flutter gates; still check markdownlint if editing `.md` |

Loop: fail → fix root cause (not suppress) → re-run the same gate →
continue only when green.

---

## Phase 3 — Regression sweep (anti fix-one/break-many)

After mechanical gates pass:

1. List packages whose `lib/` changed.
2. For each such package, ensure corresponding tests under `test/` were
   updated when behavior changed. If not, add or extend tests (defer
   style to the `testing` skill).
3. Re-run `pnpm agent-validate` on the **union** of all touched lib +
   test paths after those edits.
4. Scan the pending diff for common Sea Trials footguns:
   - Architecture imports (client/repo/BLoC isolation)
   - `showDialog` / `CircularProgressIndicator` / hardcoded UI
   - BLoC-to-BLoC coupling
   - Drive-by refactors unrelated to the stated change
5. If any footgun is present → fix or revert the drive-by before READY.

---

## Phase 4 — Review fan-out (default ON)

**Always** fan out in **one** parallel Task turn unless the diff is
docs-only (no `lib/`, `test/`, `functions/`, `web/` source):

- `code-simplicity-review-agent`
- `architecture-review-agent`
- `vgv-review-agent`
- `test-quality-review-agent`

Write raw reports under
`$ACTIVE_ROOT/docs/reviews/raw/` (absolute paths in prompts). Parent
consolidates:

- **Critical / High** → must fix before READY
- Medium / Low → fix if cheap in this diff; otherwise note for the user

After Critical/High fixes: re-run only the affected gate lanes, then
Phase 2 step 4 (`--check-only`) once more.

---

## Phase 5 — Verdict

Emit exactly one verdict block:

```text
PRE-PUSH HARDEN: READY | BLOCKED
Root: <ACTIVE_ROOT>
Changed files: <count>
Gate lanes: <n> fanned out; red=<n> fixed; check-only=<pass/fail>
Review fan-out: <ran/skipped-docs-only>; critical_open=<n>
Notes: <one-line summary>
```

- **READY** — caller may push (review loops must push after READY).
- **BLOCKED** — do not push; list remaining failures with paths.

Do not declare READY from memory. Re-read the latest command output.

---

## Integration with review loops

`st-pr-review-loop-inplace` and `st-pr-review-loop-worktree` follow the
shared review-loop body, whose Step 4 (parallel local gate) **is** this
skill's Phase 2. They MUST:

1. Run the single gate (Phase 2) before every push; commit only after
   it is green.
2. Push via **`node "$ST_REVIEW_PUSH" -- --pr <n>`** after READY (not
   bare `git push`).
3. Treat BLOCKED as a hard stop on that push attempt.
4. After a successful push, restart **`node "$ST_REVIEW_LOOP"`** in the
   background and spot-check with **`node "$ST_REVIEW_STATUS"`** —
   threads **and** CI must be green on HEAD and the settled machine
   must reach `DONE` before the loop completes. Harden does not replace
   that watch.

## Non-negotiable rules

1. Stay inside `$ACTIVE_ROOT` for all edits and gates.
2. Explicit `git add` paths only if this skill commits (prefer letting
   the caller commit; commit only when fixing gate failures mid-loop
   and the caller authorized autonomy).
3. Never `--force` / `--no-verify`.
4. Never weaken gates to get green.
5. Prefer root-cause fixes over local suppressions.
