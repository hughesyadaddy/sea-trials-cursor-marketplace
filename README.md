# Sea Trials plugin marketplace (private, dual-host)

One repo, two marketplace manifests, three plugins — installable from
**Cursor** (Team Marketplace) and **Claude Code** (`/plugin`).

| Plugin | Source of truth | In this repo |
| --- | --- | --- |
| `sea-trials` | this repo, `plugins/sea-trials/` | committed, edited here |
| `vgv-wingspan` | public `hughesyadaddy/vgv-cursor-marketplace` | submodule `imports/` + vendored copy in `plugins/` |
| `vgv-ai-flutter-plugin` | public `hughesyadaddy/vgv-cursor-marketplace` | submodule `imports/` + vendored copy in `plugins/` |

This repo is the **private Sea Trials aggregator**. The public VGV
marketplace stays separate; it is pulled in as the git submodule
`imports/vgv-cursor-marketplace` and vendored into `plugins/vgv-*` by
`scripts/sync-vendor-plugins.mjs` (see [Maintainer sync](#maintainer-sync)).
Never hand-edit `plugins/vgv-*`. Import model:
[MARKETPLACE_IMPORTS.md](MARKETPLACE_IMPORTS.md); pins:
[PLUGIN_SOURCES.md](PLUGIN_SOURCES.md).

| Host | Root manifest | Marketplace `name` |
| --- | --- | --- |
| Cursor | `.cursor-plugin/marketplace.json` | `sea-trials-cursor-marketplace` |
| Claude Code | `.claude-plugin/marketplace.json` | `sea-trials-claude-marketplace` |

## Install

### Cursor

1. Dashboard → Team Marketplaces →
   `https://github.com/hughesyadaddy/sea-trials-cursor-marketplace`
2. Auto Refresh on; enable **sea-trials**, **vgv-wingspan**,
   **vgv-ai-flutter-plugin**
3. Cmd+Q → reopen Cursor
4. Settings → MCP → **Connect** on `atlassian-seatrials` and
   `atlassian-allinpmprep` (URL-only OAuth)

Import **only this aggregator**. If Dashboard also lists
`vgv-cursor-marketplace`, remove it → Refresh → Cmd+Q, optionally
`rm -rf ~/.cursor/plugins/cache/*vgv-cursor-marketplace*`. Two imports load
Wingspan and Flutter twice (duplicate skills, hooks, MCP).

### Claude Code

```text
/plugin marketplace add hughesyadaddy/sea-trials-cursor-marketplace
/plugin install sea-trials@sea-trials-claude-marketplace
/plugin install vgv-wingspan@sea-trials-claude-marketplace
/plugin install vgv-ai-flutter-plugin@sea-trials-claude-marketplace
```

The suffix after `@` is the **Claude marketplace name**
(`sea-trials-claude-marketplace`, from `.claude-plugin/marketplace.json`),
not the GitHub repo name. Do **not** also add
`VeryGoodOpenSource/very-good-claude-code-marketplace` — same duplication
problem as on Cursor.

Update later with `/plugin marketplace update sea-trials-claude-marketplace`.
Claude caches by plugin **version**, so a publish that does not bump
`plugins/sea-trials/.claude-plugin/plugin.json` `version` is invisible.

## Skill and tool names on Claude Code

Claude namespaces plugin components by plugin name; Cursor does not.

| Component | Cursor | Claude Code |
| --- | --- | --- |
| Sea Trials skill | `/st-pre-push-harden` | `/sea-trials:st-pre-push-harden` |
| Wingspan skill | `/code-review` (Cursor port) | `/vgv-wingspan:review` (upstream name) |
| Agent as subagent | Task `subagent_type: "vgv-review-agent"` | Agent `subagent_type: "vgv-wingspan:vgv-review-agent"` |
| MCP tool | namespace `plugin-sea-trials-chrome-devtools` | `mcp__plugin_sea-trials_chrome-devtools__<tool>` |

## Dual-host differences

| Concern | Cursor | Claude Code |
| --- | --- | --- |
| Subagents | **Task** tool | **Agent** tool |
| Agent `model` | Cursor slugs (`composer-2.5`, `claude-sonnet-5`) / `inherit` | `sonnet` / `opus` / `haiku` / `inherit` |
| Hooks format | `hooks/cursor/hooks.json` — `{"version":1,"hooks":{"beforeShellExecution":[…]}}`, relative `./` commands, cwd = plugin root | `hooks/claude/hooks.json` — `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[…]}]}}`, `${CLAUDE_PLUGIN_ROOT}/…` |
| Plugin root | resolved by `scripts/lib/resolve-st-plugin-root.mjs` → `ST_PLUGIN_ROOT` | `${CLAUDE_PLUGIN_ROOT}` (also honoured by the resolver) |
| MCP file | `mcp.json` | `.mcp.json` (identical; `url` servers must set `type`) |
| Structured questions | **AskQuestion** (some models) → MCP `ask_user_question` | native **AskUserQuestion** |
| Context resets | same-chat handoffs only | clear-context handoffs valid |

Full table and the plugin-root resolution order:
[`plugins/sea-trials/README.md`](plugins/sea-trials/README.md). Structured
question protocol (vendored from VGV):
[`plugins/vgv-wingspan/references/structured-questions-protocol.md`](plugins/vgv-wingspan/references/structured-questions-protocol.md).

## Shared skill text: `_sources` → copies

`plugins/sea-trials/skills/_sources/*.md` is the single editable source for
text shared across `st-*` skills. Every
`plugins/sea-trials/skills/st-*/references/shared/<name>.md` is a generated
copy with a `<!-- GENERATED … -->` banner.

```bash
node scripts/sync-skill-sources.mjs          # regenerate all copies
node scripts/sync-skill-sources.mjs --check  # CI: exit 1 on drift
```

## CI

`.github/workflows/validate-claude-marketplace.yml` runs on every PR and
push to `main` with bare Node 22 (no `pnpm install`):

| Job | What |
| --- | --- |
| `node-tests` | `node --test` over `plugins/sea-trials/scripts/**/*.test.mjs` and `scripts/*.test.mjs` |
| `manifests` | `node scripts/validate-manifests.mjs` + `node scripts/sync-skill-sources.mjs --check` |
| `claude-plugin-validate` | `claude plugin validate .` per plugin |

`validate-manifests.mjs` checks both marketplace manifests, both plugin
manifests per plugin (names, matching versions, existing `./` paths), every
`mcp.json` / `.mcp.json` (`url` ⇒ `type`), every `hooks.json` (referenced
scripts exist), and frontmatter `name` + `description` on all agents and
`SKILL.md` files.

## Maintainer sync

### Bump VGV (vendored plugins)

```bash
# 1. Edit + push the public VGV marketplace (source of truth)
cd ~/Desktop/vgv-cursor-marketplace
git add -A && git commit && git push

# 2. Bump the submodule pin in this aggregator
cd ~/Desktop/sea-trials-cursor-marketplace
git submodule update --remote imports/vgv-cursor-marketplace

# 3. Preview, then apply the scoped vendor sync
node scripts/sync-vendor-plugins.mjs --dry-run
node scripts/sync-vendor-plugins.mjs

# 4. Record the new submodule SHA in PLUGIN_SOURCES.md, verify, commit
git -C imports/vgv-cursor-marketplace rev-parse HEAD
node scripts/validate-manifests.mjs
git add imports/ plugins/vgv-* PLUGIN_SOURCES.md .gitmodules
git commit -m "sync(vgv): bump import from vgv-cursor-marketplace" && git push
```

`sync-vendor-plugins.mjs` rsyncs only the subtrees declared per plugin in
its `pluginSyncPlans` (Cursor `cursor/`, `rules/`, `mcp.json`,
`.cursor-plugin/`; Claude `skills/`, `agents/`, `hooks/`, `.mcp.json`,
`.claude-plugin/`; plus listed root files). `--delete` applies **inside**
those directories only — never at the plugin root — so the Cursor and
Claude trees under one `plugins/vgv-*` can never wipe each other. A subtree
missing from the import is skipped with a note (not yet merged upstream).
Add new upstream directories to `pluginSyncPlans` before they will vendor.

### Publish Sea Trials plugin changes

1. Edit `plugins/sea-trials/`; if `skills/_sources/` changed, run
   `node scripts/sync-skill-sources.mjs`
2. Bump `version` (`YYYY.MM.DD`) in **both**
   `plugins/sea-trials/.claude-plugin/plugin.json` and
   `plugins/sea-trials/.cursor-plugin/plugin.json`
3. `node scripts/validate-manifests.mjs` and
   `(cd plugins/sea-trials && claude plugin validate .)`
4. Commit, push → Cursor Dashboard → Refresh → Cmd+Q; Claude
   `/plugin marketplace update sea-trials-claude-marketplace`
