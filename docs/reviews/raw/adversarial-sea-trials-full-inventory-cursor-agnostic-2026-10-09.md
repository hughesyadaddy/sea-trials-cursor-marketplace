# Adversarial synthesis: sea-trials plugin inventory + Cursor-agnostic install

**Repo:** `/Users/alexhughes/Desktop/sea-trials-cursor-marketplace`  
**Plugin version after fixes:** `2026.10.09.4`  
**Research:** [Cursor Plugins](https://cursor.com/docs/plugins), [reference](https://cursor.com/docs/reference/plugins), [Skills](https://cursor.com/docs/skills), [MCP](https://cursor.com/guides/coding-agent-mcp)

## Executive verdict

| Area | Status |
| --- | --- |
| Team Marketplace self-contained plugin | **Good** — skills/agents/hooks/MCP ship in cache |
| Agnostic any-repo operation | **Fixed in 2026.10.09.4** — unified bootstrap, `CURSOR_PLUGIN_ROOT`, `print-st-plugin-root.mjs` |
| Cursor feature utilization | **Strong** — hooks, Task subagents, MCP, slash skills; gaps below |
| Consumer repo pollution | **Risk** — legacy `front-end/scripts/jira-*` (out of plugin scope) |

---

## Inventory (plugins/sea-trials)

### Skills (19 `st-*`, slash-invoked)

| Skill | Agnostic? | Notes |
| --- | --- | --- |
| `st-sprint-plan` | Yes | Phase 0 bootstrap; fanout uses Read not paste |
| `st-sprint-refine` | Yes | Same bootstrap |
| `st-sprint-retro` | Yes | Same |
| `st-jira-upload` | Yes | MCP + REST; needs site OAuth |
| `st-jira-board-vet` | Yes | |
| `st-jira-test-review` | Yes | |
| `st-jira-to-pr-loop` | Yes | PR loop; needs `gh` + git remote |
| `st-build-with-subagents` | Partial | Assumes repo shard layout / `shards.json` |
| `st-e2e-checkpoint` | Partial | App-specific env |
| `st-flake-quarantine` | Yes | review-loop contract |
| `st-pre-push-harden` | Partial | Expects `.husky` + lane registry in repo |
| `st-pr-review-loop-*` | Yes | origin remote, not hardcoded repo |
| `st-pr-review-monitor` | Yes | background Task |
| `st-pr-promote` / `st-pr-ship` | Yes | |
| `st-sea-trials-lint` | Partial | Rust lint binary optional in repo |
| `st-vgv-chain` | Yes | delegates to vgv-wingspan plugin |
| `st-powersync-triage` | **No** | Sea Trials monorepo paths/IDs by design |

### Agents (13)

| Agent | Scope |
| --- | --- |
| `st-sprint-author` / `st-sprint-critic` | Any repo with sprint folder |
| `st-jira-uploader` / `st-jira-verifier` / `st-jira-browser-operator` | Jira site via MCP |
| `st-shard-worker` / `st-shard-integrator` | Build shards |
| `st-retro-writer` / `st-flake-triager` | PR/sprint metadata |
| `powersync-migration-operator` | **Sea Trials only** |
| `macos-appstore-signing` | **Sea Trials iOS/macOS only** |

### Scripts entrypoints

| Entry | Role |
| --- | --- |
| `scripts/st-run.mjs` | Hook router; sets `ST_PLUGIN_ROOT`; `print-plugin-root` |
| `scripts/lib/resolve-st-plugin-root.mjs` | Cache walk, newest wins |
| `scripts/lib/print-st-plugin-root.mjs` | CLI bootstrap for agents |
| `scripts/sprint/*` | Sprint lint, ADF, Jira REST |

### Hooks + MCP

- **Hooks:** `guard-git-push`, session model probe — run with plugin cwd
- **MCP:** Atlassian (2 sites), chrome-devtools — OAuth per user; no secrets in repo

### Shared sources

- `_sources/sprint-contract.md`, `sprint-dev-voice.md`, `review-loop-contract.md`, …
- `sync-skill-sources.mjs --check` in CI — **required** after `_sources` edits

---

## Adversarial findings (by lens)

### Architecture

1. **RESOLVED:** Bash `_st_plugin_root` + `find | head -1` on plugin roots → Node bootstrap.
2. **RESOLVED:** Document `CURSOR_PLUGIN_ROOT` per Cursor plugin reference.
3. **OPEN:** `tools/sea-trials-cursor-plugin` emit tree — maintainer-only; document as dev escape hatch.
4. **OPEN:** Dual MCP Atlassian servers — correct for two sites; consumers must connect both if needed.
5. **OPEN:** `st-sea-trials-lint` / Rust tool — optional repo-local binary; skill should fail with install hint, not assume path.

### VGV / workflow

1. Sprint pipeline aligns with Wingspan separation (plan in app vs sprint cards in plugin) — **good**.
2. Subagent prompts should always pass `ST_PLUGIN_ROOT` — fanout templates **good** since 2026.10.09.3.
3. Cloud agents: document `ST_PLUGIN_ROOT` secret when bootstrap find fails (sandboxed `$HOME`).

### Simplicity

1. Bootstrap block duplicated in 6 SKILL.md files — acceptable until `_sources/st-plugin-bootstrap.md` fan-out (optional).
2. 23 generated contract copies — justified by dual-host `references/` resolution.

### PR / publish readiness

1. Bump **both** `.cursor-plugin` and `.claude-plugin` versions together.
2. `validate-manifests.mjs` + `sync-skill-sources --check` + `node --test`.
3. GHA `mapfile` — use portable `find` + `node --test` on macOS dev (marketplace CI).

---

## Cursor best-practice checklist (agnostic install)

| Practice | sea-trials |
| --- | --- |
| Distribute via Team Marketplace git repo | Yes |
| `.cursor-plugin/plugin.json` manifest | Yes |
| Skills in plugin, not copied to app | Yes |
| MCP in plugin `mcp.json` | Yes |
| Hooks for lifecycle automation | Yes |
| Subagents via `Task` + `subagent_type` | Yes |
| `${CURSOR_PLUGIN_ROOT}` for MCP paths when needed | Documented; resolver reads env |
| No absolute paths in plugin code | Yes (tests use fixtures) |
| Optional consumer shim only | `st-run` delegation |

---

## Remaining work (priority)

1. **Consumer repos:** Remove pinned cache SHA in legacy Jira scripts; use `resolve-sea-trials-plugin.mjs` or bootstrap only.
2. **CI:** `sprint:lint --changed` on PRs when `sprint_planning/**` changes.
3. **Plugin:** Consider `commands/` or `variables` in manifest for documented env schema (future Cursor feature).
4. **Repo-specific agents:** Rename or tag `powersync-migration-operator` / `macos-appstore-signing` as `sea-trials-only` in description (already partially done).

---

## Ship note

After pull: Dashboard → Refresh marketplace → **Cmd+Q** Cursor. Verify:

```bash
node "$(find ~/.cursor/plugins -path '*/sea-trials/scripts/st-run.mjs' 2>/dev/null | head -1)" print-plugin-root
node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" sprint-lint -- /path/to/sprint_planning/<folder>
```
