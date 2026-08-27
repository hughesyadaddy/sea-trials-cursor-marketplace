# Sea Trials Cursor plugin

Team Marketplace plugin for Sea Trials–owned Cursor components:

- Agents: `powersync-migration-operator`, `macos-appstore-signing`
- Skills: `pr-review-loop-inplace`, `pr-review-loop-worktree`,
  `pre-push-harden`
- Scripts: PR review CLI under `scripts/hooks/` (resolve plugin root via
  `scripts/resolve-plugin-root.mjs`)
- MCP: Atlassian (`atlassian-seatrials`, `atlassian-allinpmprep`),
  `chrome-devtools`
- Hooks: Flutter plugin deny-list shim

## Source of truth

| Component | Source | Ships in |
| --- | --- | --- |
| Skills | `.cursor/skill-custom/` | sea-trials |
| Review scripts | `scripts/hooks/pr-review-*.mjs` | sea-trials `scripts/hooks/` |
| Agents | `.cursor/agent-sources/` | sea-trials |
| Rules | `.cursor/rule-sources/` | vgv-wingspan |

Regenerate after editing those sources:

```bash
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
./scripts/cursor-link-vgv-skills.sh --emit-wingspan-shareable
```

Do not hand-edit generated files under `agents/`, `skills/`, or
`scripts/` — they are overwritten by the emitter.

## Local install (smoke)

```bash
rsync -a --delete \
  tools/sea-trials-cursor-plugin/ \
  ~/.cursor/plugins/local/sea-trials/
```

Quit Cursor fully (Cmd+Q) after install.

## Team Marketplace

Vendored as `plugins/sea-trials` in the private unified Team Marketplace
`hughesyadaddy/sea-trials-cursor-marketplace`. That repo also vendors
Wingspan + Flutter from a git submodule of the public
`vgv-cursor-marketplace` (Cursor Team indexes one marketplace import).

Atlassian MCP is URL-only OAuth. After install, Connect
`atlassian-seatrials` and `atlassian-allinpmprep` under Settings → MCP.

**Jira in agent sessions** uses Atlassian MCP OAuth above. **CLI sprint
scripts** (e.g. `sprint_planning/*/jira_state.json` tooling) still use
`JIRA_API_TOKEN` / `./scripts/setup-secrets.sh` separately — that token
is not injected into Cursor MCP.

Publish order: push public VGV first, then run
`scaffold-sea-trials-cursor-marketplace.sh` so the submodule pin and
vendored `plugins/vgv-*` stay in sync.
