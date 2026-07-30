# Sea Trials VGV Cursor Team Marketplace

Aggregator marketplace for Cursor Teams (one marketplace URL):

| Plugin | Content SoT |
| --- | --- |
| `vgv-wingspan` | git submodule → `hughesyadaddy/vgv-wingspan` |
| `vgv-ai-flutter-plugin` | git submodule → `hughesyadaddy/vgv-ai-flutter-plugin` |
| `sea-trials` | synced from Sea Trials `tools/sea-trials-cursor-plugin/` |

## Sync

```bash
# From sea_trials_universal:
./scripts/cursor-link-vgv-skills.sh --emit-cursor-plugin
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
# push both VGV forks, then:
./scripts/scaffold-vgv-cursor-marketplace.sh
cd ~/dev/sea-trials-vgv-cursor-marketplace
git submodule update --remote
# re-rsync sea-trials is done by the scaffold script
git add -A && git commit -m "chore: bump marketplace plugins" && git push
```

Import this repo in Cursor Dashboard → Team Marketplace. Enable Auto
Refresh. Set both VGV plugins + Sea Trials to **Default On**.
