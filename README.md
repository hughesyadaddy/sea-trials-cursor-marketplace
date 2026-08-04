# Sea Trials Cursor Team Marketplace (private — Sea Trials plugin only)

**Sea Trials engineers only.** Import **both** Team Marketplaces in Cursor:

| Marketplace | Repo | Visibility | Plugins |
| --- | --- | --- | --- |
| VGV | `hughesyadaddy/vgv-cursor-marketplace` | **Public** | Wingspan + Flutter |
| Sea Trials | `hughesyadaddy/sea-trials-vgv-cursor-marketplace` | **Private** | Sea Trials only |

Other teams import `vgv-cursor-marketplace` only — never this repo.

GitHub repo must stay **private** (Atlassian auth placeholders, custom skills).

## Install (Sea Trials monorepo)

1. Dashboard → Team Marketplaces → import **both** repos above
2. Enable **VGV Wingspan**, **VGV AI Flutter**, and **Sea Trials**
3. Cmd+Q → reopen Cursor

## Sync (maintainers)

```bash
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
./scripts/scaffold-vgv-cursor-marketplace.sh
cd ~/dev/sea-trials-vgv-cursor-marketplace
git add -A && git commit -m "chore: bump sea-trials plugin" && git push
gh repo edit hughesyadaddy/sea-trials-vgv-cursor-marketplace --visibility private
```

VGV plugin updates: `scaffold-vgv-only-cursor-marketplace.sh` → `vgv-cursor-marketplace`.
