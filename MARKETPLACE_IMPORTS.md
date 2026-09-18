# VGV import (private unified marketplace)

Cursor **Team plan allows one** marketplace import. VGV plugin **source
of truth** stays in the public repo `hughesyadaddy/vgv-cursor-marketplace`.

## How import works

| Layer | Mechanism |
| --- | --- |
| **Link** | Git submodule `imports/vgv-cursor-marketplace` → public marketplace repo |
| **Runtime** | Vendored copies under `plugins/vgv-*` (Cursor indexes committed files) |

Cursor does **not** yet support `marketplace.json` entries like
`{"type":"github","owner":"...","repo":"..."}` for cross-repo plugin
imports. Submodules alone are also skipped at index time — so committed
copies under `plugins/` are rsynced from the submodule on each publish.

## Update VGV in the private marketplace

```bash
# 1. Edit + push public VGV marketplace (SoT)
cd ~/Desktop/vgv-cursor-marketplace
git add -A && git commit && git push

# 2. Bump import submodule + vendor into plugins/
cd ~/Desktop/sea-trials-cursor-marketplace
git submodule update --remote imports/vgv-cursor-marketplace
rsync -a --delete imports/vgv-cursor-marketplace/plugins/vgv-wingspan/ \
  plugins/vgv-wingspan/
rsync -a --delete imports/vgv-cursor-marketplace/plugins/vgv-ai-flutter-plugin/ \
  plugins/vgv-ai-flutter-plugin/
# update PLUGIN_SOURCES.md VGV SHAs, then:
git add imports/ plugins/vgv-* PLUGIN_SOURCES.md .gitmodules
git commit -m "sync(vgv): bump import from vgv-cursor-marketplace"
git push
# Dashboard → Refresh → Cmd+Q
```

Never hand-edit `plugins/vgv-*` — re-vendor from `imports/` after bumping
the submodule.

## Sea Trials plugin

Edit `plugins/sea-trials/` directly in this repo. After changing PR review
hooks in `sea_trials_universal`, copy
`scripts/hooks/pr-review-*.mjs` (and `lib/`) into
`plugins/sea-trials/scripts/hooks/`.
