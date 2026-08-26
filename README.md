# Sea Trials Cursor Team Marketplace (private, unified)

**Sea Trials engineers on Team plan:** import **this repo only** in Cursor
Dashboard → Team Marketplaces. Cursor indexes a single marketplace import;
this aggregator bundles public VGV plugins plus the team `sea-trials` plugin.

## What you get (three plugins)

| Plugin | Role | Ships |
| --- | --- | --- |
| `vgv-wingspan` | VGV workflows + review | **15** skills (including PR review trio), 10 review agents, adapter rules, `context7`, `vgv-ask-question` MCP |
| `vgv-ai-flutter-plugin` | Flutter/Dart | Flutter skills, `dart` + `very-good-cli` MCP, `flutter-reviewer` agent |
| `sea-trials` | Team-only surface | **Agents + MCP + hooks only** — no workflow skills |

PR review skills (`/pr-review-loop-inplace`, `/pr-review-loop-worktree`,
`/pre-push-harden`) live in **vgv-wingspan** (vendored from the public VGV
marketplace pin), not in `sea-trials`.

## Submodule + vendored copy model

| Layer | Path | Purpose |
| --- | --- | --- |
| **Import (git submodule)** | `imports/vgv-cursor-marketplace` | Tracks `hughesyadaddy/vgv-cursor-marketplace` at a pinned commit |
| **Runtime (vendored)** | `plugins/vgv-wingspan`, `plugins/vgv-ai-flutter-plugin` | Full plugin trees Cursor actually indexes |
| **Team plugin** | `plugins/sea-trials` | Emitted from the app monorepo `tools/sea-trials-cursor-plugin/` |

Cursor does **not** index submodule checkouts for marketplace discovery — only
committed files under `plugins/`. After bumping the submodule, always re-run
scaffold so `plugins/vgv-*` match the pin.

Current VGV import pin: `143a3f1` (see `git submodule status` and
[PLUGIN_SOURCES.md](PLUGIN_SOURCES.md)).

## Install

1. Dashboard → Team Marketplaces → import
   `https://github.com/hughesyadaddy/sea-trials-cursor-marketplace`
2. Turn on **Auto Refresh**; enable all three plugins.
3. **Cmd+Q** → reopen Cursor.
4. **Atlassian MCP (OAuth Connect only)** — Settings → MCP → **Connect** on:
   - `atlassian-seatrials` → `https://mcp.atlassian.com/v1/mcp`
   - `atlassian-allinpmprep` → `https://mcp.atlassian.com/v1/mcp/authv2`
     (separate URL so two Atlassian sites do not collapse into one session)

   No API keys, no `Authorization` headers, and no Atlassian env vars in
   `mcp.json`. Each engineer completes their own OAuth grant; it is not
   delegable.

5. **chrome-devtools** (local only): start Chrome with the team debug profile
   (for example `./scripts/chrome-agent-profile.sh`) so DevTools listens on
   `http://127.0.0.1:9333`, then use the MCP server from the `sea-trials`
   plugin. Cloud agents cannot reach your localhost browser.

## Maintainer sync

From the application monorepo, **public VGV marketplace first**, then this
aggregator:

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

See [MARKETPLACE_IMPORTS.md](MARKETPLACE_IMPORTS.md) for import mechanics.