---
name: pre-push-harden
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

## Phase 2 — Mechanical gates (mandatory)

Run from `$ACTIVE_ROOT`. Prefer the lightest gate that still covers the
diff; escalate when the diff is broad or a prior push broke CI.

### Always (non-docs changes)

1. **Tier 2 — local push gate:**

   ```bash
   pnpm agent-validate -- $CHANGED_LIB_AND_TEST_PATHS
   ```

   Pass explicit paths. Do not rely on a clean `git status` alone when
   reviewing commits already made.

2. Review loops call **`node "$ST_REVIEW_PUSH" -- --pr <n>`** after READY
   (runs `agent-prepush` then `git push` with the prepush hook). Do not
   bypass with a bare `git push`.

3. If Flutter/Dart packages changed and agent-validate is green but the
   change spans package public APIs / multiple packages: run
   `pnpm prepush` (or the same format + analyze + `sea-trials-lint`
   scope the pre-push hook would use). Fix failures in place.

4. Never suggest `--no-verify`. Never skip hooks.

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

## Phase 4 — Optional review fan-out

When the user asked for a thorough pre-push, or the diff is large
(rough guide: **≥15** touched source files or cross-package API
change), fan out in **one** parallel Task turn:

- `code-simplicity-review-agent`
- `architecture-review-agent`
- `vgv-review-agent`
- `test-quality-review-agent` (if tests or behavior changed)

Write raw reports under
`$ACTIVE_ROOT/docs/reviews/raw/` (absolute paths in prompts). Parent
consolidates:

- **Critical / High** → must fix before READY
- Medium / Low → fix if cheap in this diff; otherwise note for the user

Re-run Phase 2 after Critical/High fixes.

Skip fan-out for tiny single-file doc or comment-only changes.

---

## Phase 5 — Verdict

Emit exactly one verdict block:

```text
PRE-PUSH HARDEN: READY | BLOCKED
Root: <ACTIVE_ROOT>
Changed files: <count>
Gates: agent-validate=<pass/fail>; prepush=<pass/fail/skipped>; ...
Review fan-out: <ran/skipped>; critical_open=<n>
Notes: <one-line summary>
```

- **READY** — caller may push (review loops must push after READY).
- **BLOCKED** — do not push; list remaining failures with paths.

Do not declare READY from memory. Re-read the latest command output.

---

## Integration with review loops

`pr-review-loop-inplace` and `pr-review-loop-worktree` MUST:

1. Call this skill (follow these phases) before every push.
2. Push via **`node "$ST_REVIEW_PUSH" -- --pr <n>`** after READY (not bare
   `git push`).
3. Treat BLOCKED as a hard stop on that push attempt.
4. After a successful push, run **`node "$ST_REVIEW_LOOP"`** in background
   and **`node "$ST_REVIEW_STATUS"`** for spot checks — threads **and**
   CI must be green on HEAD before the loop completes. Harden does not
   shorten the 30-minute poll window.

## Non-negotiable rules

1. Stay inside `$ACTIVE_ROOT` for all edits and gates.
2. Explicit `git add` paths only if this skill commits (prefer letting
   the caller commit; commit only when fixing gate failures mid-loop
   and the caller authorized autonomy).
3. Never `--force` / `--no-verify`.
4. Never weaken gates to get green.
5. Prefer root-cause fixes over local suppressions.
