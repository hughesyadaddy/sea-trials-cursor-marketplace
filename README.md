# Sea Trials VGV Cursor Team Marketplace

Aggregator marketplace for Cursor Teams (one marketplace URL):

| Plugin | Content SoT | Vendored from |
| --- | --- | --- |
| `vgv-wingspan` | `hughesyadaddy/vgv-wingspan` | fork working dir (pinned SHA below) |
| `vgv-ai-flutter-plugin` | `hughesyadaddy/vgv-ai-flutter-plugin` | fork working dir |
| `sea-trials` | Sea Trials `tools/sea-trials-cursor-plugin/` | monorepo |

**Not git submodules.** Cursor's Team Marketplace clone does not run
`git submodule update --init`, so submodule plugin dirs install empty.

## Sync

```bash
# From sea_trials_universal:
./scripts/cursor-link-vgv-skills.sh --emit-cursor-plugin
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
# push both VGV forks, then:
./scripts/scaffold-vgv-cursor-marketplace.sh
cd ~/dev/sea-trials-vgv-cursor-marketplace
git add -A && git commit -m "chore: bump marketplace plugins" && git push
```

Import this repo in Cursor Dashboard → Plugins. Enable Auto Refresh.
Set all three plugins to **Default On**.
