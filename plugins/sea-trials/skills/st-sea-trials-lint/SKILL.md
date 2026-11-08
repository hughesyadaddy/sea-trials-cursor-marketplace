---
name: st-sea-trials-lint
description: >-
  Run sea-trials-lint and dart architecture rules on changed files,
  explain tier violations (client/repo/vgv-bloc isolation, widget_function,
  forbidden APIs). Use when agent-validate-changed or scoped custom lint fails.
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

Scoped custom lint on **changed files only** — not full-tree analyze.

## Phase 1 — Scope

```bash
ACTIVE_ROOT=$(git rev-parse --show-toplevel)
cd "$ACTIVE_ROOT"
```

Collect changed Dart paths from git diff (staged + unstaged).

## Phase 2 — Run

```bash
# Rust linter (architecture + design system tiers) on explicit paths
tools/st-sea-trials-lint/bin/st-sea-trials-lint check <files...>
```

`agent-validate-changed` already invokes custom lint for Dart paths in the
diff. Use the binary directly when you need a focused re-run on one file.

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
node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs <fixed paths…>
```

Do not commit until scoped validation is clean.
