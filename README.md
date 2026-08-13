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
