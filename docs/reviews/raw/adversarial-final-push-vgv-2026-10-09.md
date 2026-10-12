# VGV Code Review — sea-trials plugin final push 2026.10.09.4–5

**Date:** 2026-10-09  
**Repo:** `sea-trials-cursor-marketplace`  
**Scope:** `plugins/sea-trials` — commits `8907d95` (agnostic install), `c2c12b7` + `e6bb43f` (in-chat PR monitor), version **2026.10.09.5** in both host manifests.  
**Artifacts:** skills (`_sources` + synced copies), scripts (`resolve-st-plugin-root`, `st-run`, `bootstrap-st-env`, hooks unchanged in this range), docs (`CURSOR_AGNOSTIC_INSTALL.md`). Hooks JSON under `plugins/sea-trials/hooks/` were not modified in these commits.

**Validation run:** `node --test plugins/sea-trials/scripts/lib/resolve-st-plugin-root.test.mjs` → 11/11 pass; `node scripts/sync-skill-sources.mjs --check` → 25 copies up to date (6 sources).

---

## VGV Code Review

### Summary

The push delivers two real improvements: a **tested, centralized plugin-root resolver** (`resolve-st-plugin-root.mjs` + `CURSOR_PLUGIN_ROOT`) and **Cursor-native PR monitor guidance** (in-chat Shell + `Await`, `--silence 60`, webhook-first). Version bumps are aligned across `.cursor-plugin` and `.claude-plugin`. However, **`st-pr-review-monitor` ships without `references/shared/review-loop-contract.md` while the skill and synced body still require it**, breaking standalone `/st-pr-review-monitor` and any agent that follows the documented read order. That self-containment gap is a merge blocker until fixed (re-sync contract into the monitor skill or rewrite references + inline minimal bootstrap). Secondary issues: duplicated bootstrap prose, a bash typo in monitor docs, and reliance on `find | head -1` for the print script path (acceptable for script discovery but still nondeterministic with multiple installs).

**Verdict:** **FAIL** (1 critical). Fix the missing contract bundle, then ship.

---

### 🔴 Critical — Must Fix Before Merge

- **`plugins/sea-trials/skills/st-pr-review-monitor/SKILL.md:54`** — References `review-loop-contract.md` for `$ST_PLUGIN_ROOT` / `$ST_REVIEW*` bootstrap, but **`references/shared/review-loop-contract.md` was removed** in `c2c12b7` (only `cursor-in-chat-monitor.md`, `review-loop-body.md`, `review-loop-monitor.md` remain).
  - Why: `/st-pr-review-monitor` is user-invocable and advertised as pairable but usable alone. Agents cannot resolve hook paths or fan-out rules from bundled refs; they hit a dead link while `review-loop-body.md` also says “Read `shared/review-loop-contract.md` first.”
  - Fix: Re-add `shared/review-loop-contract.md` to the monitor skill’s sync link set (run `node scripts/sync-skill-sources.mjs` from repo root), **or** remove all contract references and add a minimal inline bootstrap block (env chain + `ST_REVIEW*` exports) in `SKILL.md` only.

---

### 🟡 Important — Should Fix

- **`plugins/sea-trials/skills/_sources/cursor-in-chat-monitor.md:19`** (copied to 3 skills) — Bash example has a stray quote: `stop --pr <n>" || true`.
  - Why: Copy-paste failures in production monitor setup.
  - Fix: `stop --pr <n> || true`.

- **Bootstrap story (2026.10.09.4)** — `scripts/bootstrap-st-env.sh` exists but **no skill references it**; six sprint skills still inline the same ~12-line `find … print-st-plugin-root.mjs | head -1` block.
  - Why: Violates “single bootstrap entrypoint”; drift risk vs `_sources/sprint-contract.md` §11 and `review-loop-contract.md`.
  - Fix: Phase 0 in skills → `source` bootstrap script or one documented `node …/print-st-plugin-root.mjs` after env injection; trim duplicated blocks from `SKILL.md` files.

- **`plugins/sea-trials/skills/_sources/review-loop-contract.md:1–7`** — Shared-by list omits `st-pr-review-monitor` (and loop skills now depend on monitor docs).
  - Why: Maintainers and agents misidentify canonical contract consumers.
  - Fix: Extend header list; keep `_sources` as single truth.

- **Process enforcement gap** (documented in adversarial monitor note) — Nothing in hooks/scripts prevents Cursor agents from starting detached `daemonctl --daemon` only.
  - Why: Codex wake bug returns if the agent ignores skill prose.
  - Fix (follow-up): Optional guard when `CURSOR_AGENT` (or similar) is set; not required for this patch if contract link is fixed.

---

### 🔵 Suggestions — Nice to Have

- **`docs/CURSOR_AGNOSTIC_INSTALL.md:41–44` vs `:69`** — Primary bootstrap snippet still uses `find | head -1`; anti-pattern section forbids it on plugin *roots* only. Clarify that finding **`print-st-plugin-root.mjs`** is a last-resort fallback, or prefer `st-run print-plugin-root` once `ST_PLUGIN_ROOT` is partially known.
- **`st-run.mjs`** — Already calls `resolveStPluginRoot()` (good); mention in README/contract that `st-run print-plugin-root` is the preferred CLI bootstrap over filesystem search.
- **Monitor doc layering** — `review-loop-monitor.md` and `st-pr-review-monitor/SKILL.md` repeat Option B daemon commands; trim SKILL to read-order + autonomy and link shared files only (~50 LOC).

---

### Simplicity Assessment

- Lines that could be removed: ~120–180 (duplicate bootstrap blocks in sprint skills; redundant monitor bash in SKILL.md).
- Unnecessary abstractions: None new; resolver earns its keep vs ad-hoc cache paths.
- YAGNI violations: Extra monitor prose layers (4 shared files for loop skills) without strict single-source layering; `bootstrap-st-env.sh` shipped but unused.
- Complexity verdict: **Minor tweaks needed** for bootstrap dedup; **one structural fix** (monitor contract bundle) before merge.

---

### Testing Assessment

- New code with tests: **✅** — `resolve-st-plugin-root.test.mjs` (11 cases: env precedence, invalid `ST_PLUGIN_ROOT`, cache mtime, `installed_plugins.json`, subprocess `HOME`).
- Test quality: **Meaningful** — covers resolution order and failure modes; no tests for `print-st-plugin-root.mjs` / `st-run print-plugin-root` (thin wrappers; acceptable).
- State management test coverage: N/A (plugin orchestration docs + Node scripts).
- UI component test coverage: N/A.

---

### Architecture & Conventions (Pass 2)

| Area | Assessment |
| --- | --- |
| Layer separation | **Pass** — skills reference `$ST_PLUGIN_ROOT` paths; hooks/sprint scripts run in consumer repo via `st-run` + `ST_REPO_ROOT`. |
| Plugin resolution | **Pass** — marker file validation, strict `ST_PLUGIN_ROOT`, ignore foreign `CLAUDE_PLUGIN_ROOT`, newest cache by mtime. |
| Dual-host manifests | **Pass** — both at `2026.10.09.5`. |
| Skill sync | **Pass** — `--check` clean; monitor orphan of contract is a **content** bug, not sync drift. |
| Hooks (unchanged in range) | **Pass** — no regression in this diff. |

---

## Structured outcome (caller)

| Field | Value |
| --- | --- |
| **PASS/FAIL** | **FAIL** |
| **Critical findings** | **1** |
| **Important findings** | **4** |
| **Suggested findings** | **3** |
