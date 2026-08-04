# Sea Trials Cursor Team Marketplace (private)

**Sea Trials engineers only.** This repo ships the **Sea Trials plugin**
only — not VGV Wingspan or Flutter.

Sea Trials monorepo devs import **two** Team Marketplaces in Cursor:

| Marketplace | Repo | Plugins |
| --- | --- | --- |
| VGV | `hughesyadaddy/vgv-cursor-marketplace` (public) | Wingspan + Flutter |
| Sea Trials | `hughesyadaddy/sea-trials-cursor-marketplace` (private) | Sea Trials only |

Keep this GitHub repo **private** (Atlassian auth placeholders, custom
skills, internal agents).

## Install (Sea Trials monorepo)

1. Dashboard → Team Marketplaces → import both repos above
2. Enable **VGV Wingspan**, **VGV AI Flutter**, and **Sea Trials**
3. Cmd+Q → reopen Cursor

Do **not** share this repo or marketplace URL with other teams.

## Maintainer sync

From `sea_trials_universal`:

```bash
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
./scripts/scaffold-sea-trials-cursor-marketplace.sh
cd ~/dev/sea-trials-cursor-marketplace
git add -A && git commit -m "chore: bump sea-trials plugin" && git push
```

VGV plugin updates: `scaffold-vgv-only-cursor-marketplace.sh` →
`vgv-cursor-marketplace`.
