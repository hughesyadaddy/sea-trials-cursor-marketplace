# Sea Trials Cursor plugin

Team Marketplace plugin for Sea Trials–owned Cursor components:

- Agents: `powersync-migration-operator`, `macos-appstore-signing`
- Skills: 10 `st-*` skills (see `skills/` — e.g. `st-pre-push-harden`,
  `st-pr-review-loop-inplace`, …)
- Scripts: PR review CLI under `scripts/hooks/` (resolve plugin root via
  `scripts/resolve-plugin-root.mjs`)
- MCP: Atlassian (`atlassian-seatrials`, `atlassian-allinpmprep`),
  `chrome-devtools`
- Hooks: Flutter plugin deny-list shim

## Source of truth

| Component | Source | Ships in |
| --- | --- | --- |
| Skills | `plugins/sea-trials/skills/` (this repo) | sea-trials |
| Review scripts | `sea_trials_universal/scripts/hooks/pr-review-*.mjs` → copy to `plugins/sea-trials/scripts/hooks/` | sea-trials |
| Agents | `plugins/sea-trials/agents/` (this repo) | sea-trials |
| Rules | `vgv-cursor-marketplace/plugins/vgv-wingspan/rules/` | vgv-wingspan |

Edit `plugins/sea-trials/` in this repo. After changing PR review hooks in
the monorepo, copy `sea_trials_universal/scripts/hooks/pr-review-*.mjs`
(and `lib/`) into `plugins/sea-trials/scripts/hooks/`.

## Local install (smoke)

```bash
rsync -a --delete \
  plugins/sea-trials/ \
  ~/.cursor/plugins/local/sea-trials/
```

Quit Cursor fully (Cmd+Q) after install.

## Team Marketplace

Vendored as `plugins/sea-trials` in the private unified Team Marketplace
`hughesyadaddy/sea-trials-cursor-marketplace`. That repo also vendors
Wingspan + Flutter from a git submodule of the public
`vgv-cursor-marketplace` (Cursor Team indexes one marketplace import).

**Import only this aggregator** — do not also import
`vgv-cursor-marketplace` separately (duplicate skills/MCP).

Atlassian MCP is URL-only OAuth. After install, Connect
`atlassian-seatrials` and `atlassian-allinpmprep` under Settings → MCP.

**Jira in agent sessions** uses Atlassian MCP OAuth above. **CLI sprint
scripts** (e.g. `sprint_planning/*/jira_state.json` tooling) still use
`JIRA_API_TOKEN` / `./scripts/setup-secrets.sh` separately — that token
is not injected into Cursor MCP.

Publish order: push public VGV first, then bump `imports/vgv-cursor-marketplace`
and re-vendor `plugins/vgv-*` in this repo (see root `README.md`).
