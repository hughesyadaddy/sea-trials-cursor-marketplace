# Architecture review: sea-trials agnostic Team Marketplace install

**Scope:** `/plugins/sea-trials` in `sea-trials-cursor-marketplace` — agnostic install (any git repo, no vendoring).  
**Focus:** `st-run`, `resolve-st-plugin-root`, skills/agents/hooks/MCP vs [Cursor Plugins](https://cursor.com/docs/plugins) and [Plugins reference](https://cursor.com/docs/reference/plugins).  
**Plugin version reviewed:** `2026.10.09.4` (`.cursor-plugin/plugin.json`).

---

## Architecture Review

### Layer Separation

**Intended layers (plugin-internal):**

| Layer | Location | May depend on |
| --- | --- | --- |
| Orchestration (skills, agents) | `skills/`, `agents/` | Documented `$ST_PLUGIN_ROOT` paths only; consumer repo via `$REPO_ROOT` / git |
| Application scripts | `scripts/hooks/`, `scripts/sprint/`, `scripts/ci/` | Node stdlib, `scripts/lib/`, consumer cwd (git root) |
| Resolution / bootstrap | `scripts/lib/resolve-st-plugin-root.mjs`, `scripts/st-run.mjs` | Host env, filesystem caches |

**Violations found: 2 (product-scope, not import-graph)**

1. **`agents/powersync-migration-operator.md`** — Hard-wires Sea Trials monorepo paths (`supabase/`, `powersync/`, project IDs). For “any repo” marketplace positioning, this is **presentation-layer leakage**: a consumer on `front-end` or another repo still sees a Flutter/Supabase specialist in the same plugin bundle. Prefer a separate plugin or repo-scoped rules, not the agnostic core.

2. **Duplicated contract corpora** — `sprint-contract.md` is copied under six skill trees (`st-sprint-plan`, `st-jira-upload`, `st-jira-board-vet`, `st-sprint-refine`, `st-jira-test-review`, plus `_sources`). Byte sizes differ (`st-sprint-plan` 20472 B vs `_sources` 20356 B), so copies have **already drifted**. Skills/agents that point at different paths risk inconsistent lint/upload behavior without a single canonical file + sync step.

**Clean dependency direction (imports):**

- Skills/agents do not `import` hook modules; they reference shell paths — OK.
- `scripts/sprint/sprint-lint.mjs` imports `resolve-st-plugin-root.mjs` and runs against **consumer** `sprint_planning/` — correct (plugin logic, repo data).
- Hook scripts resolve plugin libs via `import.meta.url` / relative paths under the installed tree — no reverse dependency from `scripts/` into `skills/`.

**Clean files (checked):** `scripts/st-run.mjs`, `scripts/lib/resolve-st-plugin-root.mjs`, `hooks/scripts/session-start.mjs`, `hooks/scripts/guard-git-push.mjs`, `hooks/cursor/hooks.json`, marketplace `ci/setup/action.yml`.

---

### State Management Assessment

Not applicable in the Redux/BLoC sense. **Orchestration state** (gate-pass tokens, model-probe cache, PR review daemons) lives under consumer `.git` / temp paths via `scripts/hooks/lib/*` — appropriate.

- **`st-run`:** Stateless dispatcher; injects `ST_PLUGIN_ROOT` + `ST_REPO_ROOT` into child env — **Correct**.
- **`resolveStPluginRoot()`:** Pure resolution from env + filesystem — **Correct**; strict validation on `ST_PLUGIN_ROOT`, loose on host-injected roots (marker file is sea-trials-specific).

---

### Dependency Direction

**Violations found: 1 (bootstrap ergonomics)**

1. **Dual bootstrap stories** — Runtime truth is split across:
   - **`st-run.mjs`:** Plugin root = directory containing `scripts/` (via `import.meta.url`). Does not call `resolveStPluginRoot()`. Correct when the invoked binary lives in the installed plugin.
   - **`resolve-st-plugin-root.mjs`:** Used by `sprint-lint`, `print-st-plugin-root.mjs`, and documented in contracts.
   - **Shell snippets in ~23 skill/contract files:** `find … print-st-plugin-root.mjs | head -1` then `node`.

   Direction is still plugin → repo, but **multiple entrypoints** increase the chance app repos re-vendor shims (e.g. consumer `scripts/lib/resolve-sea-trials-plugin.mjs` in `front-end`). Agnostic install should treat **`node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" print-plugin-root`** (or only `print-st-plugin-root.mjs` with explicit path from Customize docs) as the sole bootstrap, and delete `find | head -1` from skills.

**Clean:**

- Hooks → `scripts/hooks/lib` only downward.
- No circular package deps (single plugin tree).
- Team Marketplace repo uses `.cursor-plugin/marketplace.json` multi-plugin layout per Cursor reference — **Correct**.

---

### Package Structure

| Check | sea-trials |
| --- | --- |
| Cursor manifest | `.cursor-plugin/plugin.json` — **Complete** |
| Claude manifest | `.claude-plugin/plugin.json` — **Complete** (dual-host) |
| Default discovery dirs | `skills/`, `agents/`, root `mcp.json` — **Complete** |
| `rules/` | **Missing** (optional for Cursor; not required) |
| Tests | Hook/sprint/st-run tests under `scripts/` — **Present** |
| Validator | Marketplace `scripts/validate-manifests.mjs` — **Complete** |

**Findings:**

1. **`.cursor-plugin/plugin.json:17`** — Uses `"mcp": "./mcp.json"`. Cursor reference documents **`mcpServers`** for manifest overrides; default discovery is root `mcp.json` anyway. The marketplace validator explicitly allows Cursor field `mcp` — likely works, but **non-canonical** vs public docs; prefer `"mcpServers": "./mcp.json"` for forward compatibility.

2. **`displayName`** in Cursor manifest — Not in reference schema; harmless if ignored.

3. **`mcp.json` / `.mcp.json`** — Byte-identical policy documented in README; Atlassian HTTP + chrome-devtools stdio — aligns with reference (remote `type: http` required for Claude).

4. **Hooks path split** — `hooks/cursor/hooks.json` vs `hooks/claude/hooks.json`; Claude uses `${CLAUDE_PLUGIN_ROOT}` in commands (reference-aligned). Cursor uses relative `node ./hooks/scripts/...` (reference: plugin-relative commands) — **Correct**.

5. **`session-start.mjs:17-18`** — Derives plugin root from hook file location (`../..`), not `CURSOR_PLUGIN_ROOT`. Valid for Cursor hook cwd; differs from Claude `${CLAUDE_PLUGIN_ROOT}` pattern but consistent within host.

---

### Cursor docs alignment (agnostic install)

| Reference feature | sea-trials usage | Assessment |
| --- | --- | --- |
| Team Marketplace multi-plugin repo | Root `.cursor-plugin/marketplace.json` + `plugins/sea-trials` | **Aligned** |
| Skills / Agents auto-discovery | Explicit `./skills/`, `./agents/` in manifest | **Aligned** |
| Hooks (`hooks/hooks.json`) | `./hooks/cursor/hooks.json`; `beforeShellExecution` + `failClosed` push guard | **Aligned** |
| MCP at plugin root | `mcp.json`; OAuth HTTP Atlassian | **Aligned** (no secrets in repo) |
| `${CURSOR_PLUGIN_ROOT}` in MCP | Not used (npx chrome-devtools); optional for future bundled bins | **OK** |
| Required / Default On install | Documented in `docs/CURSOR_AGNOSTIC_INSTALL.md` | **Ops, not code** |
| Cloud agents | `ST_PLUGIN_ROOT` override documented | **Required gap filled** |
| Local test | README `rsync` to `~/.cursor/plugins/local/sea-trials` | **Aligned** with docs; not vendoring into app repo |

**Gaps vs agnostic goal:**

1. **Bootstrap anti-pattern still embedded** — `docs/CURSOR_AGNOSTIC_INSTALL.md:41-44` and Phase 0 blocks in multiple skills still use `find | head -1` to locate `print-st-plugin-root.mjs`. Contract §11 says not to use `head -1` on **roots**, but the same fragility applies when multiple cached SHAs exist (nondeterministic which resolver copy runs). Prefer: Cursor-injected `CURSOR_PLUGIN_ROOT`, or `st-run print-plugin-root` after a one-time `ST_PLUGIN_ROOT` from Customize.

2. **GHA vs IDE install** — `ci/setup/action.yml` assumes marketplace checkout at `.st-plugin` in the **app repo** workflow. That is a valid agnostic pattern (pin SHA, no vendoring into tree), but distinct from Team Marketplace cache paths; document clearly so teams do not mix “IDE Required plugin” with “workflow submodule checkout” without setting `ST_PLUGIN_ROOT`.

3. **chrome-devtools MCP** — Fixed `http://127.0.0.1:9333`; agnostic across repos but not across machines without local CDP. Acceptable if runbooks state the prerequisite.

---

### `st-run` and `resolve-st-plugin-root` (deep dive)

**`st-run.mjs`**

- Single CLI entry: `hooks/*`, `ci/*`, `sprint/*` (e.g. `sprint-lint`).
- Sets `ST_PLUGIN_ROOT` to its own plugin tree and `ST_REPO_ROOT` from git — **correct agnostic contract** for app repos.
- Subcommand `print-plugin-root` — should be referenced in skills instead of `find`.

**`resolve-st-plugin-root.mjs`**

- Resolution order: `ST_PLUGIN_ROOT` (strict) → `CURSOR_PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` → repo `tools/sea-trials-cursor-plugin` → newest cache by marker mtime → dev self — **sound**.
- Marker `scripts/resolve-plugin-root.mjs` uniquely identifies sea-trials — **good**.
- **`newestRoot()` by mtime** — Reasonable for parallel cache versions; teams on Required install should still pin via env on CI/cloud.

**`print-st-plugin-root.mjs`** — Thin wrapper; **Correct**.

---

### Skills / agents (agnostic behavior)

**Strengths**

- `st-sprint-plan/references/fanout-prompts.md` — Instructs Read by absolute path, not paste full contract — **aligned with agnostic + context limits**.
- Agents (`st-sprint-author`, `st-sprint-critic`) — Require parent to pass `ST_PLUGIN_ROOT` and shared paths — **Correct** pattern.

**Weaknesses**

- Phase 0 bash blocks duplicated across many skills with identical `find | head -1` — consolidate to one shared snippet file or mandate host env only.
- **`st-build-with-subagents`** references `$ST_PLUGIN_ROOT` without always defining bootstrap in skill body — relies on prior phases or parent (documented in skill but easy to fail in fresh chat).

---

### Verdict

**Fix 4 architectural issues before calling agnostic install “done”:**

1. Eliminate `find | head -1` bootstrap from skills/contracts; standardize on `st-run print-plugin-root` / `print-st-plugin-root.mjs` via known `ST_PLUGIN_ROOT` or `CURSOR_PLUGIN_ROOT`.
2. Deduplicate `sprint-contract.md` (and review-loop copies) — one canonical path under `skills/_sources/` or `references/shared/` at plugin root with a release sync check in `validate-manifests.mjs`.
3. Align Cursor manifest MCP key with reference (`mcpServers`) or document reliance on default `mcp.json` discovery only.
4. Split or gate monorepo-specific agents (`powersync-migration-operator`) from the “any repo” narrative, or scope their descriptions to “Sea Trials monorepo only.”

**Otherwise:** Plugin structure matches Cursor Team Marketplace + Cursor Plugin format; `st-run` + repo-local `sprint_planning/` is the right agnostic boundary; hooks and MCP are properly host-packaged without app-repo vendoring.

---

## Structured findings (for triage)

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| A1 | Medium | Bootstrap | ~23 files use `find … print-st-plugin-root.mjs \| head -1`; nondeterministic with multiple cache SHAs; contradicts agnostic doc spirit. |
| A2 | Medium | Data / DRY | Six copies of `sprint-contract.md`; sizes differ — drift risk across lint vs upload skills. |
| A3 | Low | Manifest | Cursor `plugin.json` uses `"mcp"` not `"mcpServers"` (docs + discovery fallback). |
| A4 | Low | Product scope | `powersync-migration-operator` embeds monorepo-only paths in global plugin. |
| A5 | Info | CI vs IDE | GHA composite action expects `.st-plugin` checkout; separate from marketplace cache — document one pattern per environment. |
| A6 | Info | Consumer | App repos may duplicate resolver (`front-end/scripts/lib/resolve-sea-trials-plugin.mjs`); prefer `st-run` only. |
| A7 | Positive | Entry | `st-run` sets `ST_PLUGIN_ROOT`/`ST_REPO_ROOT` for all hooks — clean agnostic API. |
| A8 | Positive | Hooks | Push guard `failClosed: true` + repo opt-in via `.husky/st-plugin-run.sh` — correct cross-repo gate. |
| A9 | Positive | Cursor format | Multi-plugin marketplace manifest, skills/agents/hooks/MCP layout matches reference discovery. |

---

## References

- [Cursor Plugins overview](https://cursor.com/docs/plugins) — Team marketplaces, component bundle, `${CURSOR_PLUGIN_ROOT}` note for Agent Plugins MCP.
- [Plugins reference](https://cursor.com/docs/reference/plugins) — Manifest fields, hooks events, default directory discovery, marketplace.json.
