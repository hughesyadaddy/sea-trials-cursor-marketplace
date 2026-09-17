---
name: st-sea-trials-lint
description: >-
  Run sea-trials-lint and dart architecture rules on changed files,
  explain tier violations (client/repo/vgv-bloc isolation, widget_function,
  forbidden APIs). Use when prepush or agent-prepush fails custom lint.
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


# Sea Trials lint

Scoped custom lint — not full-tree analyze. Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code)
when a fix requires a product/API decision.

## Phase 1 — Scope

```bash
ACTIVE_ROOT=$(git rev-parse --show-toplevel)
cd "$ACTIVE_ROOT"
```

Collect changed Dart paths from git diff (staged + unstaged).

## Phase 2 — Run

```bash
# Rust linter (architecture + design system tiers)
tools/st-sea-trials-lint/bin/st-sea-trials-lint check <files...>

# Or via hook parity
pnpm prepush   # when committed diff is the target
pnpm agent-prepush  # when dirty tree
```

See `docs/runbooks/LINT_STAGES.md` for tier definitions.

## Phase 3 — Fix patterns

| Rule | Fix |
| --- | --- |
| Client isolation | Import repository, not firebase/algolia clients |
| BLoC isolation | No Firebase types in `*_bloc.dart` |
| widget_function | Extract StatelessWidget class |
| forbidden APIs | Use `showAppPopup`, `CupertinoActivityIndicator` |
| shared_deps | Add `show` clause on import |

## Phase 4 — Re-validate

```bash
pnpm agent-validate
```

Do not push until prepush-tier lint is clean.
