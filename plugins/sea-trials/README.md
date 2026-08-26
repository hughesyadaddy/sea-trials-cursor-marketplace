# Sea Trials Cursor plugin

Team Marketplace plugin for Sea Trials–owned Cursor components:

- **Agents:** `powersync-migration-operator`, `macos-appstore-signing`
- **MCP:** Atlassian (×2, URL OAuth Connect), `chrome-devtools` (local browser)
- **Hooks:** emitted Cursor hooks when present in the source tree

Workflow and PR review **skills** ship in **vgv-wingspan** (public VGV
marketplace), including `/pr-review-loop-inplace`, `/pr-review-loop-worktree`,
and `/pre-push-harden`. Enable Wingspan in the same Team Marketplace import.

## Source of truth

| Component | Source (application monorepo) |
| --- | --- |
| Agents | `.cursor/agent-sources/` |
| MCP + hooks | `tools/sea-trials-cursor-plugin/` emit |

Regenerate after editing those sources:

```bash
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
```

Do not hand-edit generated files under `agents/`, `hooks/`, or `mcp.json` in
the vendored copy — they are overwritten by the emitter.

## Atlassian MCP

URL-only **OAuth Connect** via Cursor Settings → MCP → **Connect**:

| Server | URL |
| --- | --- |
| `atlassian-seatrials` | `https://mcp.atlassian.com/v1/mcp` |
| `atlassian-allinpmprep` | `https://mcp.atlassian.com/v1/mcp/authv2` |

No API keys and no per-user tokens in `mcp.json`. Each engineer grants access
in their own Cursor session.

## chrome-devtools

Local-only: attach to Chrome started with the team debug profile on
`http://127.0.0.1:9333`. Not available to cloud agents without your machine.

## Local install (smoke)

```bash
rsync -a --delete \
  tools/sea-trials-cursor-plugin/ \
  ~/.cursor/plugins/local/sea-trials/
```

Quit Cursor fully (Cmd+Q) after install. Prefer the private Team Marketplace
vendored copy for day-to-day use.

## Team Marketplace

Vendored as `plugins/sea-trials` in
`hughesyadaddy/sea-trials-cursor-marketplace`. That repo also vendors Wingspan
and Flutter from a git submodule of the public `vgv-cursor-marketplace`.

Publish order: push public VGV first, then run
`scaffold-sea-trials-cursor-marketplace.sh` so the submodule pin and vendored
`plugins/vgv-*` stay in sync.