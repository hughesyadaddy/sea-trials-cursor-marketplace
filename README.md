# Sea Trials Cursor Team Marketplace (private)

**Sea Trials engineers only.** Do not share this repo or marketplace URL with
other teams — use `vgv-cursor-marketplace` for them.

GitHub repo must stay **private** (team MCP, Atlassian auth placeholders,
custom skills).

| Plugin | Content SoT | Vendored from |
| --- | --- | --- |
| `vgv-wingspan` | `hughesyadaddy/vgv-wingspan` | fork working dir (pinned SHA below) |
| `vgv-ai-flutter-plugin` | `hughesyadaddy/vgv-ai-flutter-plugin` | fork working dir |
| `sea-trials` | Sea Trials `tools/sea-trials-cursor-plugin/` | monorepo |

**Not git submodules.** Cursor's Team Marketplace clone does not run
`git submodule update --init`, so submodule plugin dirs install empty.

## First-time GitHub repo (private)

```bash
gh repo create hughesyadaddy/sea-trials-vgv-cursor-marketplace --private \
  --source=. --remote=origin --push
```

Import in Cursor Dashboard → Team Marketplaces (Sea Trials Cursor org only).
Enable Auto Refresh. Set all three plugins to **Default On**.

## Sync

```bash
# From sea_trials_universal:
./scripts/cursor-link-vgv-skills.sh --emit-cursor-plugin
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
./scripts/cursor-link-vgv-skills.sh --emit-wingspan-shareable
# push both VGV forks, then:
./scripts/scaffold-vgv-cursor-marketplace.sh
cd ~/dev/sea-trials-vgv-cursor-marketplace
git add -A && git commit -m "chore: bump marketplace plugins" && git push
```
