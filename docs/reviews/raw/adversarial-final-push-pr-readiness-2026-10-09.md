# PR Readiness Review — final push (2026-10-09)

**Scope:** Push readiness for `main` on both marketplaces.

| Repo | Path | `HEAD` |
| --- | --- | --- |
| sea-trials (aggregator) | `/Users/alexhughes/Desktop/sea-trials-cursor-marketplace` | `e6bb43f` (= `origin/main`) |
| vgv (public VGV stack) | `/Users/alexhughes/Desktop/vgv-cursor-marketplace` | `5622046` (= `origin/main`) |

**sea-trials plugin version (requested):** `2026.10.09.5`

---

## PASS/FAIL checklist (executive)

| # | Check | Result |
| --- | --- | --- |
| 1 | sea-trials: both host `plugin.json` versions = `2026.10.09.5` | **PASS** |
| 2 | sea-trials: `node scripts/validate-manifests.mjs` | **PASS** |
| 3 | sea-trials: `node scripts/sync-skill-sources.mjs --check` | **PASS** (25 copies, 6 sources) |
| 4 | sea-trials: CI-equivalent `node --test` (48 files) | **PASS** (1047 pass, 0 fail, 7 skipped) |
| 5 | sea-trials: submodule `imports/vgv-cursor-marketplace` = vgv repo `HEAD` | **PASS** (`5622046867a18a7d4d1e4a8e0d9e16b60accec62`) |
| 6 | sea-trials: `PLUGIN_SOURCES.md` SHAs match submodule | **FAIL** (documents `beaf81d`; actual pin `5622046`) |
| 7 | sea-trials: vendored `plugins/vgv-*` vs submodule (no stray hand-edits) | **WARN** — one intentional overlay (see Debug / drift) |
| 8 | sea-trials: branch synced with remote (`main`…`origin/main`) | **PASS** (nothing to push) |
| 9 | vgv: `node --test scripts/check-skill-copies.test.mjs` | **PASS** (9/9) |
| 10 | vgv: README sprint / `st-run` pointers to sea-trials aggregator | **PASS** |
| 11 | vgv: branch synced with remote | **PASS** (nothing to push) |
| 12 | Claude `plugin validate` (local) | **NOT RUN** (requires global `@anthropic-ai/claude-code`; CI matrix covers three plugins) |

**Overall:** **FAIL** on maintainer doc pin (#6) until `PLUGIN_SOURCES.md` is updated; runtime/CI mechanical gates **PASS**.

---

## sea-trials-cursor-marketplace

### Formatting

- **Status:** Clean (N/A)
- No root formatter/linter; Node scripts + manifest validators only.

### Static analysis

- **Errors:** 0  
- **Warnings:** 0  
- **Infos:** 0  

### Validation commands (local)

```text
validate-manifests: OK
sync-skill-sources: 25 copies up to date (6 source(s))
node --test (48 CI paths): 1047 pass, 0 fail, 7 skipped (~64s)
```

Matches `.github/workflows/validate-marketplace.yml` jobs `manifests` and `node-tests`.

### Debug artifacts

- **Violations:** 0 in shipped plugin/scripts for recent feature commits (`2026.10.09.4`–`.5`).
- **Informational:** CLI `console.log` in sprint-lint / st-run paths is user-facing output, not ad-hoc debug.
- **Informational:** `TODO:` strings in sprint lint tests and contract prose are rule fixtures, not unfinished code.

### Drift vs vgv submodule

| Item | Status |
| --- | --- |
| Git submodule pointer | Matches `vgv-cursor-marketplace` `main` at `5622046` |
| `PLUGIN_SOURCES.md` | **Stale** — both VGV rows still `beaf81d` (pre-`057a1f7` / `5622046` bumps) |
| `plugins/vgv-ai-flutter-plugin` vs import | Identical (`diff -rq`) |
| `plugins/vgv-wingspan` vs import | **One file:** `cursor/skills/build/references/consumer-push-gate.md` — vendored copy adds Sea Trials `/st-pr-review-monitor` / `/st-pr-promote` bullets (since `f2169bd`). Conflicts with README rule “never hand-edit `plugins/vgv-*`”; next `sync-vendor-plugins.mjs` run would drop that block unless moved to sea-trials-only docs or upstream vgv |

`node scripts/sync-vendor-plugins.mjs --dry-run` reports 33 scoped rsync targets (normal for full plugin trees); the only content diff found via `diff -rq` is `consumer-push-gate.md`.

### Commit hygiene

- **Commits reviewed:** `8907d95` … `e6bb43f` (on `main`, already on `origin/main`)
- **Messages:** Descriptive (version bumps in subject where applicable).
- **Untracked (local only):** `docs/reviews/raw/adversarial-final-push-{architecture,simplicity,vgv}-2026-10-09.md` — not required for marketplace publish; optional to commit.

### Auto-fixable

1. Update `PLUGIN_SOURCES.md` VGV rows to `5622046867a18a7d4d1e4a8e0d9e16b60accec62` (or short `5622046`) and commit.
2. (Optional) Relocate Sea Trials monitor bullets out of vendored `consumer-push-gate.md` into sea-trials skill references to survive vendor sync.

### Verdict (sea-trials)

**Needs work** — fix `PLUGIN_SOURCES.md` before treating the push as fully clean; CI gates otherwise green.

---

## vgv-cursor-marketplace

### Formatting / static analysis

- **Status:** Clean (N/A) — no manifest validator script in repo root; CI uses Claude validate + skill-copy checker.

### Tests

```text
node --test scripts/check-skill-copies.test.mjs: 9 pass, 0 fail
```

Aligns with `.github/workflows/validate-claude-plugins.yml` job `skill-copies`.

### README / cross-repo consistency

- README documents sprint skills on **sea-trials** aggregator (`/st-sprint-plan`, `/st-jira-upload`, `st-run` sprint-lint).
- `PLUGIN_SOURCES.md` pins monorepo SHAs (`f46110af…`) — independent from sea-trials submodule table; no conflict.

### Submodule pointer (from sea-trials)

- sea-trials records submodule at **`5622046`** (`docs: document st-run sprint-lint for app repos`).
- Matches vgv local `HEAD` — **PASS**.

### Commit hygiene

- **Branch:** `main` up to date with `origin/main`.
- Recent history: doc + Wingspan parallel-first + Sea Trials decoupling from public plugin (`beaf81d`).

### Verdict (vgv)

**Ready to merge / already on main** — no mechanical blockers from this review.

---

## Combined verdict

| Repo | Verdict |
| --- | --- |
| `vgv-cursor-marketplace` | **Ready** (on `main`, tests pass) |
| `sea-trials-cursor-marketplace` | **Needs work** — update `PLUGIN_SOURCES.md` SHAs; optional vendor-overlay hygiene |

After #6 fix: **Ready** for marketplace refresh (Dashboard Auto Refresh + Cmd+Q), assuming GitHub Actions `claude-plugin-validate` stays green on `main`.
