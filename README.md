# Sea Trials Cursor Team Marketplace (private, unified)

**Sea Trials engineers on Team plan:** import **this repo only**.
Cursor Team currently indexes one marketplace import; VGV is pulled in
via git submodule, then vendored under `plugins/`.

| Plugin | Source of truth | In this repo |
| --- | --- | --- |
| `vgv-wingspan` | `hughesyadaddy/vgv-cursor-marketplace` | submodule + vendored `plugins/` |
| `vgv-ai-flutter-plugin` | `hughesyadaddy/vgv-cursor-marketplace` | submodule + vendored `plugins/` |
| `sea-trials` | this repo `plugins/sea-trials/` | committed `plugins/sea-trials/` |

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

**Import only this aggregator** — uninstall a separate
`vgv-cursor-marketplace` import if present (duplicate skills/MCP).

After marketplace or submodule updates: Dashboard → **Refresh** → **Cmd+Q**
→ reopen Cursor so rules, skills, and MCP reload.

## Maintainer sync

From this aggregator repo (and `vgv-cursor-marketplace` for VGV):

```bash
# 1. Edit + push public VGV marketplace
cd ~/Desktop/vgv-cursor-marketplace
git add -A && git commit && git push

# 2. Vendor VGV into this aggregator
cd ~/Desktop/sea-trials-cursor-marketplace
git submodule update --remote imports/vgv-cursor-marketplace
rsync -a --delete imports/vgv-cursor-marketplace/plugins/vgv-wingspan/ \
  plugins/vgv-wingspan/
rsync -a --delete imports/vgv-cursor-marketplace/plugins/vgv-ai-flutter-plugin/ \
  plugins/vgv-ai-flutter-plugin/

# 3. Edit plugins/sea-trials/ here; update PLUGIN_SOURCES.md SHAs
git add imports/ plugins/ PLUGIN_SOURCES.md .gitmodules
git commit && git push
# Dashboard → Refresh → Cmd+Q
```
