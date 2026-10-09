# Architecture review: final push on `main` (sea-trials plugin)

**Repo:** `sea-trials-cursor-marketplace`  
**Branch:** `main` @ `e6bb43f` (2026-10-09)  
**Plugin version:** `2026.10.09.5` (`.cursor-plugin/plugin.json` / `.claude-plugin/plugin.json`)  
**Scope:** Recent commits from `28a9660` (CI lane runners in plugin) through `e6bb43f` (review-loop description tweak), with emphasis on:

- Agnostic install (`8907d95` — 2026.10.09.4)
- In-chat PR monitor (`c2c12b7`, `e6bb43f` — 2026.10.09.5)
- `st-run`, `resolve-st-plugin-root`, `print-st-plugin-root`, `bootstrap-st-env.sh`
- Review-loop skills, `cursor-in-chat-monitor.md`, `pr-review-daemon*`
- Sprint pipeline (`st-run sprint-lint`, `sprint-contract`, agents)

**Method:** Import-graph scan, skill/reference inventory, `node scripts/sync-skill-sources.mjs --check`, local `st-run print-plugin-root`, adversarial cross-read of shipped docs vs commit messages.

---

## Architecture Review

### Layer Separation

**Intended layers (plugin-internal):**

| Layer | Location | May depend on |
| --- | --- | --- |
| Orchestration | `skills/`, `agents/` | Documented env vars + Read paths under `$ST_PLUGIN_ROOT`; consumer repo via `$REPO_ROOT` / git |
| Application scripts | `scripts/hooks/`, `scripts/sprint/`, `scripts/ci/` | Node stdlib, `scripts/lib/*`, consumer cwd |
| Resolution | `scripts/lib/resolve-st-plugin-root.mjs`, `scripts/st-run.mjs` | Host env, filesystem caches |

**Violations found: 3**

1. **`skills/st-pr-review-monitor/SKILL.md:54`** — Phase 0 says “Resolve `$ST_PLUGIN_ROOT` per `review-loop-contract.md`”, but **`references/shared/review-loop-contract.md` was removed** in `c2c12b7` from this skill tree (only `cursor-in-chat-monitor.md`, `review-loop-body.md`, `review-loop-monitor.md` remain). Standalone `/st-pr-review-monitor` has **no bundled bootstrap** for `$ST_PLUGIN_ROOT` / `$ST_REVIEW*`. Presentation layer points at a missing artifact.

2. **`agents/powersync-migration-operator.md`** (unchanged in this push) — Monorepo-only paths (`supabase/`, `powersync/`) ship inside the “any repo” marketplace plugin. **Product-scope leakage** at the agents layer; not an import violation but breaks the agnostic positioning.

3. **Skills ↔ host terminal API** — `cursor-in-chat-monitor.md` and review-loop skills require **Cursor Shell** (`block_until_ms: 0`, `notify_on_output`, **Await**). That is correct for Cursor Agent chat but is **presentation-layer coupling to host tools**; Claude Code and headless subagents cannot satisfy the “mandatory in-chat monitor” contract without a parallel path (daemonctl only). Not a reverse dependency into `scripts/`, but a **layer boundary blur** between portable skill text and Cursor-only runtime.

**Clean (checked):**

- `scripts/hooks/*.mjs` import `./lib/*` and consumer repo via `getRepoRoot()` — no imports from `skills/`.
- `scripts/sprint/sprint-lint.mjs` → `resolve-st-plugin-root.mjs` + consumer `sprint_planning/` — correct direction.
- Hooks manifest `hooks/cursor/hooks.json` — plugin-relative `node ./hooks/scripts/*` — aligned with Cursor plugin layout.
- Marketplace `scripts/sync-skill-sources.mjs` fans `_sources/` → `skills/st-*/references/shared/` only — tooling does not depend on app repos.

---

### State Management Assessment

Orchestration state (PR daemon PID locks, handoff ack files, gate-pass tokens) lives under consumer `docs/code-review/<scope>/` and `.git` — **appropriate** for a cross-repo plugin.

| Unit | Verdict | Notes |
| --- | --- | --- |
| `st-run.mjs` | **Correct** | Calls `resolveStPluginRoot()` at load; injects `ST_PLUGIN_ROOT` + `ST_REPO_ROOT` into child env; `print-plugin-root` subcommand. |
| `resolveStPluginRoot()` | **Correct** | Strict `ST_PLUGIN_ROOT`; loose host roots; newest cache by marker mtime; dev emit tree + self fallback. |
| `pr-review-daemon.mjs` | **Correct** | Long-lived watch; deduped sentinels; does not exit on handoff; webhook + poll paths in lib. |
| `pr-review-daemonctl.sh` | **Issues** | Detached mode still first-class; **no coordination** with Cursor in-chat requirement beyond docs. |
| Review-loop skills | **Issues** | Parent agent loop state (terminal task id, Await chunks) lives **only in chat** — not persisted if skill text is ignored. |

**Finding:** `pr-review-daemon.mjs:75` — `parsePrArgs` default `--silence` is **30** minutes while skills mandate **`--silence 60`**. Skills are authoritative for agents, but default CLI drift invites wrong behavior when commands are copied without flags.

---

### Dependency Direction

**Violations found: 2**

1. **Bootstrap multiplicity (post–2026.10.09.4)** — Commit `8907d95` claims unified resolution via `CURSOR_PLUGIN_ROOT` + `st-run`, yet **the same commit leaves** `find … print-st-plugin-root.mjs | head -1` in:
   - `skills/_sources/sprint-contract.md` §11 (`:476`)
   - `skills/_sources/review-loop-contract.md` (`:138`)
   - Every sprint skill Phase 0 (`st-sprint-plan`, `st-jira-upload`, …)
   - `docs/CURSOR_AGNOSTIC_INSTALL.md:42-44`
   - `scripts/bootstrap-st-env.sh:10`

   Direction remains plugin → repo, but **four bootstrap stories** coexist: env vars, `st-run print-plugin-root`, `node print-st-plugin-root.mjs` (via find), `source bootstrap-st-env.sh`. App repos may keep duplicate shims (e.g. consumer `resolve-sea-trials-plugin.mjs`).

   **Risk:** `head -1` on the **script path** picks an arbitrary cached SHA; `print-st-plugin-root.mjs` then runs **that copy’s** resolver. Newer marketplace installs are only guaranteed if resolver logic is backward-compatible. Old cache + new skills = subtle breakage.

2. **`agent-promotion-review-loop.mjs:17-21`** — Derives `pluginRoot` from `import.meta.url` instead of `resolveStPluginRoot()`. Safe when the script is always invoked from the installed plugin tree; **inconsistent** with `st-run` / `sprint-lint` pattern and wrong if the file is ever copied or symlinked outside cache layout.

**Clean:**

- No circular npm/package deps (single plugin tree).
- Promotion / PR hooks scoped to `origin` via `resolveGithubOwnerRepo` — no hardcoded consumer repo in new promotion commits.
- CI lane runners moved into plugin (`28a9660`) — dependency flows marketplace → plugin → app checkout on GHA, not app → vendored scripts.

---

### Package Structure

| Check | Status |
| --- | --- |
| Dual manifests (`2026.10.09.5`) | **Complete** |
| Skills / agents / hooks / MCP | **Complete** |
| `_sources/` + `sync-skill-sources.mjs --check` in GHA | **Complete** (`validate-claude-marketplace.yml`) |
| Plugin-local tests (`*.test.mjs`) | **Present** (hooks, sprint, resolver) |
| Agnostic install runbook | **Added** (`docs/CURSOR_AGNOSTIC_INSTALL.md`) |

**Findings:**

1. **`cursor-in-chat-monitor.md`** — Added to `_sources/` and synced to loop skills; **not** a dependency of `st-pr-review-monitor`’s missing contract file. Monitor skill read list is correct; Phase 0 bootstrap is not.

2. **`st-pr-review-monitor` bundle shrink** — Deleting `review-loop-contract.md` from that skill without inlining § bootstrap (or linking to a skill that ships the file) is a **packaging defect**.

3. **Marker indirection** — `resolve-st-plugin-root.mjs` uses marker `scripts/resolve-plugin-root.mjs` (thin shim printing parent of `scripts/`). Works; slightly opaque vs naming `resolve-st-plugin-root.mjs` as marker.

4. **Daemon + promotion surface area** — `pr-review-daemon.mjs`, `pr-review-daemonctl.sh`, `agent-promotion-review-loop.mjs`, `pr-promotion-ensure.mjs` increase hook layer size; boundaries remain under `scripts/hooks/` with shared `lib/` — **acceptable** if skills consistently route through `st-run`.

---

### Commit-series assessment (architecture lens)

| Commit | Architectural note |
| --- | --- |
| `28a9660` CI lanes in plugin | Correct ownership; app repos invoke via `st-run ci/*`. |
| `2dccd79` / `c3d0089` sprint-lint + rules | Single lint entry via `st-run sprint-lint`; rules module separates parser from contract prose — **good**. |
| `f2160bd`–`fd543e3` PR daemon + promotion in marketplace | Moves orchestration out of app repos; forbids app-repo watcher scripts — **correct boundary**. |
| `8907d95` agnostic install | **`st-run` → `resolveStPluginRoot()`** is the right fix; **skills/contracts not fully updated** despite commit message. |
| `c2c12b7` in-chat monitor | Splits Cursor protocol into `cursor-in-chat-monitor.md`; demotes detached daemon — **sound design**, **weak enforcement**. |
| `e6bb43f` | Description-only; no structural change. |

---

### In-chat PR monitor (2026.10.09.5 deep dive)

**Design:** Foreground `pr-review-daemon.mjs` in chat-owned background terminal + `Await` on `>>> ACTION:` + optional `notify_on_output`. Webhook default; `--no-webhook --interval 180` fallback. **Architecturally coherent** with Cursor Agent capabilities.

**Gaps:**

| Gap | Severity | Why it is architectural |
| --- | --- | --- |
| No hook/skill guard when agent runs `daemonctl --daemon` only | **High** | Correct behavior depends entirely on LLM following markdown; prior failure mode unchanged if ignored. |
| `st-pr-review-monitor` missing contract/bootstrap | **High** | Broken reference chain for standalone entry skill. |
| Monitor stop rule (60m Codex quiet) spans daemon `--silence`, status JSON, and skill prose | **Medium** | Three sources of truth; agents can stop early or late. |
| Subagents (`Task`) lack Shell/Await | **Medium** | Review-loop fan-out assumes parent owns monitor; workers cannot wake on Codex. |

---

### `st-run` / resolver (corrected vs prior review)

Prior note that `st-run` did not call `resolveStPluginRoot()` is **obsolete**. Current `scripts/st-run.mjs:23` resolves at module load and re-exports hook paths with injected env. **`print-plugin-root`** subcommand (`:89-91`) should be the documented bootstrap for skills instead of bash `find`.

---

### Verdict

**FAIL — fix 3 blockers before treating 2026.10.09.5 as architecture-complete.**

1. Repair **`st-pr-review-monitor`** bootstrap: restore `review-loop-contract.md` (or extract § env bootstrap into `cursor-in-chat-monitor.md` / Phase 0) and remove dangling reference.
2. Finish **agnostic bootstrap consolidation**: replace `find | head -1` blocks in skills + runbook with `CURSOR_PLUGIN_ROOT` → `st-run print-plugin-root` (or document-only env for cloud); one canonical snippet synced via `_sources`.
3. Add **runtime guardrail** for Cursor (hook env check, or daemonctl refusing detached when in-agent) so in-chat monitor is not documentation-only.

**Strengths to preserve:** Team Marketplace layout, `st-run` as single CLI façade, sprint lint self-containment, `sync-skill-sources --check` in CI, PR daemon lib extraction, promotion loop ownership in marketplace.

---

## Structured findings (for triage)

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | **Blocker** | Skills packaging | `st-pr-review-monitor/SKILL.md:54` references missing `review-loop-contract.md`. |
| F2 | **Blocker** | Bootstrap | `8907d95` incomplete: `find \| head -1` remains in §11, Phase 0 skills, bootstrap script, runbook. |
| F3 | **Blocker** | Enforcement | In-chat monitor mandatory in markdown only; detached daemon still valid at runtime. |
| F4 | Medium | CLI defaults | Daemon default `--silence 30` vs skill `--silence 60`. |
| F5 | Medium | Consistency | `agent-promotion-review-loop.mjs` uses `import.meta.url` not shared resolver. |
| F6 | Low | Product scope | `powersync-migration-operator` in global plugin vs agnostic narrative. |
| F7 | Low | Manifest | Cursor `"mcp"` vs reference `mcpServers` (unchanged). |
| F8 | Positive | Entry API | `st-run` + `resolveStPluginRoot()` + env injection. |
| F9 | Positive | DRY | `_sources/` + GHA `sync-skill-sources --check` (25 copies, 6 sources, pass on `main`). |
| F10 | Positive | PR watch | Daemon lib + sentinels + webhook path; promotion scoped to repo origin. |

---

## References

- [Cursor Plugins](https://cursor.com/docs/plugins)
- [Plugins reference](https://cursor.com/docs/reference/plugins)
- Prior audits: `adversarial-sea-trials-agnostic-architecture-2026-10-09.md`, `adversarial-pr-review-in-chat-monitor-2026-10-09.md`
