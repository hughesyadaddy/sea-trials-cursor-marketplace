# VGV import (private unified marketplace)

Cursor **Team plan allows one** marketplace import. VGV plugin **source of
truth** stays in the public repo `hughesyadaddy/vgv-cursor-marketplace`.

## How import works

| Layer | Mechanism |
| --- | --- |
| **Link** | Git submodule `imports/vgv-cursor-marketplace` → public marketplace repo |
| **Runtime** | Vendored copies under `plugins/vgv-*` (Cursor indexes committed files) |

Cursor does **not** yet support `marketplace.json` entries like
`{"type":"github","owner":"...","repo":"..."}` for cross-repo plugin
imports (Cursor staff, Mar 2026). Submodules alone are also skipped at
index time — so scaffold vendors plugin trees on each publish.

## Update VGV in the private marketplace

```bash
# 1. Edit + push public marketplace (SoT)
./scripts/scaffold-vgv-only-cursor-marketplace.sh
cd ~/dev/vgv-cursor-marketplace && git push

# 2. Bump import submodule + vendor into plugins/
./scripts/scaffold-sea-trials-cursor-marketplace.sh
cd ~/dev/sea-trials-cursor-marketplace
git add imports/ plugins/vgv-* PLUGIN_SOURCES.md .gitmodules
git commit -m "chore: bump VGV import from vgv-cursor-marketplace"
git push
```

Never hand-edit `plugins/vgv-*` — re-run scaffold after bumping the import.
