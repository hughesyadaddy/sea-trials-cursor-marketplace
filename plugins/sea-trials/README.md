# Sea Trials plugin (Cursor + Claude Code)

Self-contained dual-host plugin for Sea Trials. One tree, two manifests:

| Host | Manifest | Hooks | MCP |
| --- | --- | --- | --- |
| Cursor | `.cursor-plugin/plugin.json` | `hooks/cursor/hooks.json` | `mcp.json` |
| Claude Code | `.claude-plugin/plugin.json` | `hooks/claude/hooks.json` | `.mcp.json` |

Shared components (loaded by both hosts):

- **Agents:** `agents/*.md` (`powersync-migration-operator`,
  `macos-appstore-signing`, `st-shard-*`, `st-jira-*`, `st-sprint-*`).
  Cursor lists `"agents": "./agents/"`; Claude auto-discovers `agents/`
  at the plugin root — `claude plugin validate` rejects a directory string
  for `agents` (only arrays of `.md` paths are accepted), so the Claude
  manifest deliberately omits the key, like every official Claude plugin.
- **Skills:** 10 `st-*` skills (`st-pre-push-harden`, `st-pr-review-loop-*`,
  `st-build-with-subagents`, …) under `skills/`
- **Scripts:** push gate, PR review, parallel fan-out under `scripts/hooks/`
- **Entry:** `scripts/st-run.mjs <hook> [-- args]` (or `pnpm` shortcuts in
  app repos that delegate via `.husky/st-plugin-run.sh`)
- **MCP:** Atlassian (`atlassian-seatrials`, `atlassian-allinpmprep`, HTTP
  OAuth) and `chrome-devtools` (stdio)
- **Hooks:** session-start model probe; block bare / `--no-verify` /
  `--force` `git push` unless a fresh gate-pass token exists

`mcp.json` and `.mcp.json` must stay byte-identical; every remote server
declares `"type": "http"` because Claude hard-errors on a bare `url`.
`node scripts/validate-manifests.mjs` (marketplace root) enforces this.

## Install

### Cursor (Team Marketplace)

1. Dashboard → Team Marketplaces → import
   `https://github.com/hughesyadaddy/sea-trials-cursor-marketplace`
2. Enable **sea-trials**, **vgv-wingspan**, **vgv-ai-flutter-plugin**
3. Cmd+Q → reopen Cursor
4. Settings → MCP → **Connect** on `atlassian-seatrials` and
   `atlassian-allinpmprep`

Local smoke without the marketplace:

```bash
rsync -a --delete plugins/sea-trials/ ~/.cursor/plugins/local/sea-trials/
```

### Claude Code

The Claude marketplace name is the `name` in the repo's
`.claude-plugin/marketplace.json` — **`sea-trials-claude-marketplace`** —
not the GitHub repo name.

```text
/plugin marketplace add hughesyadaddy/sea-trials-cursor-marketplace
/plugin install sea-trials@sea-trials-claude-marketplace
```

Optionally also `vgv-wingspan@sea-trials-claude-marketplace` and
`vgv-ai-flutter-plugin@sea-trials-claude-marketplace`. Do **not** add
`VeryGoodOpenSource/very-good-claude-code-marketplace` as well — the
aggregator already vendors Wingspan and Flutter.

Claude caches the plugin by **version**
(`~/.claude/plugins/cache/sea-trials-claude-marketplace/sea-trials/<version>/`),
so every publish must bump `version` in **both** `plugin.json` files
(`YYYY.MM.DD`). Unbumped changes are never picked up on Claude.

## Namespacing on Claude Code

Claude prefixes plugin skills and MCP tools with the plugin name:

| Component | Cursor | Claude Code |
| --- | --- | --- |
| Skill | `/st-pre-push-harden` | `/sea-trials:st-pre-push-harden` |
| Agent (Task type) | `powersync-migration-operator` | `sea-trials:powersync-migration-operator` |
| MCP tool | `plugin-sea-trials-<server>` namespace | `mcp__plugin_sea-trials_<server>__<tool>` |

Bare `/st-*` may also resolve on Claude when unambiguous, but skill bodies
and docs should use the namespaced form when addressing Claude explicitly.

## Dual-host differences

| Concern | Cursor | Claude Code |
| --- | --- | --- |
| Subagent dispatch | **Task** tool, `subagent_type: "<agent name>"` | **Agent** tool, `subagent_type: "sea-trials:<agent name>"` |
| Agent `model` | Cursor slugs (`composer-2.5`, `claude-sonnet-5`) or `inherit` | Aliases `sonnet` / `opus` / `haiku` / `inherit` — plugin agents use `inherit` |
| Agent-only fields | `readonly: true` (Cursor only) | `tools`, `disallowedTools`, `permissionMode`, `maxTurns`, `isolation`, `background` |
| Hooks file | `{"version":1,"hooks":{"beforeShellExecution":[{"command":"./…"}]}}`; cwd = plugin root | `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/…"}]}]}}` |
| Plugin root at runtime | No env; scripts resolve it (`ST_PLUGIN_ROOT` or cache walk) | `${CLAUDE_PLUGIN_ROOT}` in hooks, MCP, skill bodies |
| Structured questions | **AskQuestion** (some models) | **AskUserQuestion** |
| Context resets | Same-chat handoffs only | Clear-context handoffs allowed |

Both hook files call the same Node scripts. `hooks/scripts/guard-git-push.mjs`
reads the tool-call JSON on stdin, parses the `git push` argv (flags, `-C`,
`&&` chains) and denies `--no-verify`, `--force`, `-f`, `--force-with-lease`
and any bare push whose branch has an open PR — unless
`pr-review-push` wrote a fresh gate-pass token for the current HEAD and
tree. Cursor gets `{"permission":"allow|deny"}`; Claude gets
`hookSpecificOutput.permissionDecision`. `hooks/scripts/session-start.mjs`
refreshes the model probe (`st-model-probe`) once per session so shard and
gate fan-outs pin slugs the host actually accepts. See
`skills/st-pre-push-harden/references/hooks.md`.

## Speed and quality layers

| Capability | Entry point | Notes |
| --- | --- | --- |
| Single push gate (dirty → committed → CI lanes) | `st-run pr-review-push -- --pr N` | Coalesces duplicate tasks across phases, fails fast, writes the gate-pass token so the husky pre-push does not rerun |
| Fine-grained fan-out | `pr-review-push --list-tasks --granularity fine` | One JSON line per worker; `run-gate-task` honours machine-wide analyzer slots |
| Content-hash gate cache | automatic; `ST_GATE_CACHE=0` to disable | Dependency-aware `dart analyze` keys; shared across worktrees |
| Worker telemetry | `st-run st-gate-stats` | p50/p95 per task kind, slowest packages, cache hit rate |
| Adaptive PR review loop | `st-run pr-review-loop -- --pr N [--webhook]` | Settled-state machine on Codex/Bugbot/CI signals; ETag probes, rate-limit backoff |
| Flaky-test quarantine | `/st-flake-quarantine`, `flake-quarantine.mjs` | Classifies, retries, quarantines with `skip:` + tracking issue |
| Build sharding | `st-run st-build-shard-tasks`, `sprint-to-shards.mjs` | Disjoint file ownership; sprint folders become `shards.json` |
| Host model probe | `st-run st-model-probe` | Detects host + accepted model slugs; `resolveModel()` picks worker tiers |
| Sprint → Jira | `/st-sprint-plan`, `/st-jira-upload`, `/st-jira-test-review`, `/st-sprint-retro` | Markdown ↔ ADF round-trip lint, REST fallbacks, human-cadence writes |

### Plugin root resolution (`scripts/lib/resolve-st-plugin-root.mjs`)

Scripts that need the plugin tree call `resolveStPluginRoot()`, which tries
in order:

1. `ST_PLUGIN_ROOT` (explicit; must contain `scripts/resolve-plugin-root.mjs`)
2. `CLAUDE_PLUGIN_ROOT` (set by Claude for hooks/MCP; used only if it is
   this plugin)
3. `tools/sea-trials-cursor-plugin` inside the current git checkout
4. Host caches, newest wins — Cursor
   `~/.cursor/plugins/cache/<marketplace>/sea-trials/<sha>` and
   `~/.cursor/plugins/local/sea-trials`; Claude
   `~/.claude/plugins/installed_plugins.json` → `installPath`,
   `~/.claude/plugins/cache/<marketplace>/sea-trials/<version>`,
   `~/.claude/plugins/marketplaces/<name>/plugins/sea-trials`
5. The tree this module lives in (dev checkout fallback)

`scripts/st-run.mjs` always exports `ST_PLUGIN_ROOT` to the hook it spawns,
so hooks under `scripts/hooks/` never guess.

## Shared skill references: `_sources` → copies

`skills/_sources/*.md` is the **only** editable copy of text shared by
several skills (e.g. `review-loop-contract.md`). Each skill ships its own
copy at `skills/st-*/references/shared/<name>.md` because both hosts resolve
`references/` relative to the skill directory.

- Edit `skills/_sources/<name>.md`, then run
  `node scripts/sync-skill-sources.mjs` from the marketplace root.
- Copies start with `<!-- GENERATED from skills/_sources/<name>.md … -->`.
  Never edit them; CI runs `--check` and fails on drift.

## Source of truth

**Edit this directory** in `sea-trials-cursor-marketplace` — not
`sea_trials_universal`. Orchestration **and** the CI lane runners live
here (`scripts/hooks/`, `scripts/ci/`). App repos keep only
`scripts/ci/pr-lane-registry.mjs` (lane data), the `scripts/ci/st-plugin.mjs`
import shim plus their config-parity tests (`scripts/ci/*.test.mjs`), and
`.husky/` wiring. Their GitHub workflows check this marketplace out and run
the runners from it via [`ci/setup`](ci/README.md).

| Layer | Location |
| --- | --- |
| Orchestration (push gate, PR review loop) | `plugins/sea-trials/scripts/hooks/` (this plugin) |
| CI lane runners + shared hook libs | `plugins/sea-trials/scripts/ci/`, `scripts/hooks/lib/` (this plugin) |
| GitHub Actions entry point | `plugins/sea-trials/ci/setup` — exports `ST_PLUGIN_ROOT` / `ST_PLUGIN_SHA` ([ci/README.md](ci/README.md)) |
| Repo CI config | checkout `scripts/ci/pr-lane-registry.mjs`, `scripts/ci/st-plugin.mjs`, `scripts/ci/*.test.mjs` (per app repo) |
| Git hook wiring | checkout `.husky/st-plugin-run.sh` (resolves plugin path) |

## Publish checklist

1. Bump `version` in `.claude-plugin/plugin.json` **and**
   `.cursor-plugin/plugin.json` (same value)
2. `node scripts/sync-skill-sources.mjs` if `_sources/` changed
3. `node scripts/validate-manifests.mjs` and `claude plugin validate .`
4. Push → Cursor Dashboard → Refresh → Cmd+Q; Claude
   `/plugin marketplace update sea-trials-claude-marketplace`
