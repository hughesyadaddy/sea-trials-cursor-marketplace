# Sea Trials Cursor Team Marketplace (private, unified)

**Sea Trials engineers on Team plan:** import **this repo only**.
Cursor Team currently indexes one marketplace import; VGV is pulled in
via git submodule, then vendored under `plugins/`.

| Plugin | Source of truth | In this repo |
| --- | --- | --- |
| `vgv-wingspan` | `hughesyadaddy/vgv-cursor-marketplace` | submodule + vendored `plugins/` |
| `vgv-ai-flutter-plugin` | `hughesyadaddy/vgv-cursor-marketplace` | submodule + vendored `plugins/` |
| `sea-trials` | `sea_trials_universal` | vendored `plugins/sea-trials/` |

See [MARKETPLACE_IMPORTS.md](MARKETPLACE_IMPORTS.md) for the import model.

## Install

1. Dashboard → Team Marketplaces →
   `https://github.com/hughesyadaddy/sea-trials-cursor-marketplace`
2. Auto Refresh on; enable all three plugins
3. Cmd+Q → reopen Cursor
4. Settings → MCP → Connect on `atlassian-seatrials` and
   `atlassian-allinpmprep` (URL-only OAuth, like Stripe)

## Structured questions (Cursor + Claude Code)

Sea Trials **`st-*` skills** use the same dual-host protocol as VGV Wingspan
(`/brainstorm`, `/plan`, `/build`, etc.).

| Priority | Tool | Host / source |
| --- | --- | --- |
| 1 | **AskQuestion** | Cursor host (some models / modes) |
| 2 | **AskUserQuestion** | Claude Code host |
| 3 | **ask_user_question** | MCP `vgv-ask-question` (Wingspan plugin) |
| 4 | Numbered chat list | Last resort only |

**Cursor:** enable **VGV Wingspan** + **Composer 2.5** for handoffs.
`vgv-ask-question` MCP ships in the Wingspan plugin — no hand `mcp.json`.

**Claude Code:** native **AskUserQuestion** is enough for most sessions.
Optional MCP: point at the cached Wingspan bundle under
`~/.cursor/plugins/cache/__DEFAULT__/vgv-wingspan/<hash>/mcp/vgv-ask-question-mcp/dist/index.js`
when the host tool is absent.

Canonical protocol (vendored from VGV):
[`plugins/vgv-wingspan/references/structured-questions-protocol.md`](plugins/vgv-wingspan/references/structured-questions-protocol.md)

After marketplace or submodule updates: Dashboard → **Refresh** on this
marketplace → **Cmd+Q** → reopen Cursor so rules, skills, and MCP reload.

## Maintainer sync

From `sea_trials_universal`, **public VGV first**, then this aggregator:

```bash
./scripts/cursor-link-vgv-skills.sh --emit-wingspan-shareable
./scripts/cursor-link-vgv-skills.sh --emit-cursor-plugin
./scripts/scaffold-vgv-only-cursor-marketplace.sh
cd ~/dev/vgv-cursor-marketplace && git add -A && git commit && git push

./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
./scripts/scaffold-sea-trials-cursor-marketplace.sh
cd ~/dev/sea-trials-cursor-marketplace
git add -A && git commit && git push
```
