# PR Readiness Review — sea-trials agnostic install (2026.10.09.4)

**Scope:** Uncommitted working tree on `main` in `sea-trials-cursor-marketplace` — version **2026.10.09.4**, `CURSOR_PLUGIN_ROOT`, `print-st-plugin-root.mjs`, contract sync, `docs/CURSOR_AGNOSTIC_INSTALL.md`, related skill/README updates.

**Stack:** Node.js (`.mjs`), `node --test` at marketplace root and under `plugins/sea-trials/scripts/lib/`. No Prettier/ESLint/Biome config at repo root.

**Checks run:**

```bash
node --test plugins/sea-trials/scripts/lib/resolve-st-plugin-root.test.mjs
node --test scripts/validate-manifests.test.mjs scripts/sync-skill-sources.test.mjs
node scripts/validate-manifests.mjs
node scripts/sync-skill-sources.mjs --check
```

---

## PR Readiness Review

### Formatting

- **Status:** Clean (no project formatter configured)
- No `.prettierrc`, ESLint, or Biome manifest at marketplace root; nothing to run in check mode.

### Static Analysis

- **Errors:** 0
- **Warnings:** 0
- **Infos:** 1
  - `plugins/sea-trials/scripts/lib/print-st-plugin-root.mjs` — [info] [coverage]: no dedicated unit test (behavior covered indirectly via `resolve-st-plugin-root.test.mjs` and manual smoke)

**Test results:**

| Suite | Pass | Fail |
| --- | ---: | ---: |
| `resolve-st-plugin-root.test.mjs` | 11 | 0 |
| `validate-manifests.test.mjs` + `sync-skill-sources.test.mjs` | 23 | 0 |
| `validate-manifests.mjs` (CLI) | OK | — |
| `sync-skill-sources.mjs --check` | 23 copies up to date | — |

### Debug Artifacts

- **Artifacts found:** 0 (in scope)
- New/changed production scripts (`resolve-st-plugin-root.mjs`, `print-st-plugin-root.mjs`, `st-run.mjs`) contain no ad-hoc `console.log`/`debugger`/merge markers.
- `resolve-st-plugin-root.test.mjs:219` — [informational]: `console.log` inside a generated subprocess test string (acceptable).
- Contract prose references `` `TODO:` `` as a sprint-lint banned phrase (not unfinished code).

**Informational (docs vs implementation):**

- Shared contracts (`sprint-contract.md`, `review-loop-contract.md`) guard empty `_ST_PRINT` with `exit 1`; several updated `SKILL.md` bootstrap blocks omit that guard (e.g. `st-sprint-plan`, `st-jira-upload`, `st-sprint-retro`). Agents may get opaque `node` errors if the plugin is not installed.

**Informational (dual print entry points):**

- `st-run.mjs` `print-plugin-root` prints the tree containing `st-run` (dev/rsync path).
- `print-st-plugin-root.mjs` uses `resolveStPluginRoot()` (newest cache wins). Documented intent; callers must pick the right one.

### Commit Hygiene

- **Commits reviewed:** 0 (`main..HEAD` empty — all work is unstaged/untracked)
- **Issues found:** 4

| Check | Result |
| --- | --- |
| Descriptive commits on a feature branch | **Fail** — 27 modified paths + 3 untracked items, no commits, work directly on `main` |
| Required new files tracked | **Fail** — `plugins/sea-trials/scripts/lib/print-st-plugin-root.mjs` untracked (skills/docs reference it) |
| Required new docs tracked | **Fail** — `plugins/sea-trials/docs/CURSOR_AGNOSTIC_INSTALL.md` untracked (linked from README) |
| Version bump (dual-host) | **Pass** — both `.cursor-plugin/plugin.json` and `.claude-plugin/plugin.json` → `2026.10.09.4` |
| Contract fan-out | **Pass** — `node scripts/sync-skill-sources.mjs --check` exit 0 |
| Manifest validation | **Pass** — `validate-manifests: OK` |
| Sensitive / generated junk | **Pass** — no `.env`/secrets in diff; untracked `docs/reviews/raw/adversarial-sea-trials-full-inventory-cursor-agnostic-2026-10-09.md` is review-only (exclude from plugin publish commit unless intentional) |

### Auto-Fixable

1. `git add` untracked `print-st-plugin-root.mjs` and `plugins/sea-trials/docs/CURSOR_AGNOSTIC_INSTALL.md`.
2. Create a feature branch and one or more imperative commits (e.g. `feat(sea-trials): CURSOR_PLUGIN_ROOT and agnostic install docs`).
3. Optionally align `SKILL.md` bootstrap snippets with contract §11 error handling for missing plugin.
4. Optionally add a small test invoking `print-st-plugin-root.mjs` with mocked `ST_PLUGIN_ROOT`.

### Verdict

**Needs work** — mechanical quality gates pass (tests, manifest validate, contract sync, version bump), but the change set is not PR-ready until untracked deliverables are added, committed on a branch, and pushed. Exclude or omit repo-root `docs/reviews/` from the marketplace release commit unless you want review artifacts in that repo.

---

## Pass/fail checklist (summary)

| Item | Pass |
| --- | --- |
| Dual-host version `2026.10.09.4` | Yes |
| `validate-manifests.mjs` | Yes |
| `sync-skill-sources.mjs --check` | Yes |
| Unit tests (`resolve-st-plugin-root`, marketplace scripts) | Yes |
| No debug artifacts in new/changed `.mjs` (scope) | Yes |
| `print-st-plugin-root.mjs` committed | No |
| `CURSOR_AGNOSTIC_INSTALL.md` committed | No |
| Commits + feature branch (not WIP on `main`) | No |
| SKILL bootstrap error handling matches contracts | No (minor / docs) |
