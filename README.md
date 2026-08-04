# Sea Trials Cursor Team Marketplace (private, unified)

**Sea Trials engineers on Team plan:** import **this repo only**.

| Plugin | Source of truth | In this repo |
| --- | --- | --- |
| `vgv-wingspan` | `hughesyadaddy/vgv-cursor-marketplace` | submodule import + vendored `plugins/` |
| `vgv-ai-flutter-plugin` | `hughesyadaddy/vgv-cursor-marketplace` | submodule import + vendored `plugins/` |
| `sea-trials` | `sea_trials_universal` | vendored `plugins/sea-trials/` |

See [MARKETPLACE_IMPORTS.md](MARKETPLACE_IMPORTS.md) for the import model.

## Install

1. Dashboard → Team Marketplaces →
   `https://github.com/hughesyadaddy/sea-trials-cursor-marketplace`
2. Auto Refresh on; enable all three plugins
3. Cmd+Q → reopen Cursor

## Maintainer sync

```bash
./scripts/scaffold-vgv-only-cursor-marketplace.sh && \
  (cd ~/dev/vgv-cursor-marketplace && git push)
./scripts/scaffold-sea-trials-cursor-marketplace.sh && \
  (cd ~/dev/sea-trials-cursor-marketplace && git add -A && git commit && git push)
```
