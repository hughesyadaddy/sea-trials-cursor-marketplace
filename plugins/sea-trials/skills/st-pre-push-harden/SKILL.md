---
name: st-pre-push-harden
description: >-
  Optional pre-push pass for the Sea Trials monorepo: scoped validation,
  regression sweep, and review-agent fan-out when the user wants extra
  confidence before push. Per-commit agent-validate-changed is the
  permanent standard — this skill does not replay prepush or PR Checks
  locally. Use when the user says "harden before push", "pre-push
  check", "make sure this is push-ready", or before a cautious first push.
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

User-invoked **extra** pass before push. The standing rule for every
agent commit is scoped validation in the contract → **Per-commit
validation** (`agent-validate-changed` on explicit changed code + covering
tests). This skill adds regression checks and optional reviewers — it does
**not** fan out `pr-review-push --list-tasks`, `prepush`, or local CI.

**Also read:**
[`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)
(project lock, `$ST_REVIEW*`, push path).

## When to run

- User explicitly asks to harden / double-check before push
- Before opening a PR when the user wants a proactive pass
- **Not** a mandatory step on every review-loop push (loops use per-commit
  validate + `pr-review-push` only)

## Autonomy

- Fix objective failures from scoped validation without asking.
- Do **not** push unless the caller wants a push after READY.
- **AskQuestion** / **AskUserQuestion** only for product/API decisions.

---

## Phase 0 — Lock the root

```bash
ACTIVE_ROOT=$(git rev-parse --show-toplevel)
cd "$ACTIVE_ROOT"
```

All paths and tools stay under `$ACTIVE_ROOT`.

---

## Phase 1 — Scope the diff

Union of committed vs base, staged, and unstaged paths (same as before).
Docs-only → **READY (noop)**.

---

## Phase 2 — Scoped mechanical check (mandatory for READY)

Run once on the union of touched source + test paths:

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs" \
  <each changed lib/test path — or omit on dirty tree only>
```

Non-Dart: run only applicable scoped analyzers/tests on touched paths.

Loop: fail → fix → re-run on the same paths until green. **No**
`--list-tasks`, **no** `run-gate-task.mjs`, **no** `--check-only` token
prerequisite.

| Surface | Extra (when touched) |
| --- | --- |
| `supabase/migrations` / PowerSync | Migration workflow; `powersync validate` when rules/schema change |
| `functions/` | Scoped lint/test for touched modules |
| `web/` | Scoped lint/typecheck for touched app files |

---

## Phase 3 — Regression sweep (anti fix-one/break-many)

After scoped validation passes:

1. Packages with `lib/` changes have matching test updates when behavior
   changed.
2. Re-run `agent-validate-changed` on the union of lib + test paths after
   test edits.
3. Fix Sea Trials footguns (architecture imports, forbidden UI APIs, BLoC
   coupling, drive-bys).

---

## Phase 4 — Review fan-out (default ON unless docs-only)

One parallel turn: `code-simplicity-review-agent`,
`architecture-review-agent`, `vgv-review-agent`, `test-quality-review-agent`.
Raw reports under `$ACTIVE_ROOT/docs/reviews/raw/`. Critical/High → fix and
re-run Phase 2 on affected paths.

---

## Phase 5 — Verdict

```text
PRE-PUSH HARDEN: READY | BLOCKED
Root: <ACTIVE_ROOT>
Changed files: <count>
Scoped validate: <pass/fail>
Review fan-out: <ran/skipped-docs-only>; critical_open=<n>
Notes: <one-line summary>
```

**READY** — caller may `node "$ST_REVIEW_PUSH" --pr <n>` (not bare push).

---

## Integration with review loops

Review loops follow `review-loop-body.md` Step 4 (per-commit scoped
validate) and Step 5 (`pr-review-push`). They may **skip** this skill unless
the user asked for harden. Never weaken remote PR Checks, merge guards, or
hook denials (`--no-verify`, bare push).

## Non-negotiable rules

1. Stay inside `$ACTIVE_ROOT`.
2. Never `--force` / `--no-verify`.
3. Never legacy CI-parity fan-out for agents.
