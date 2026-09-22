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
copies under `plugins/` are synced from the submodule on each publish.

## Update VGV in the private marketplace

```bash
# 1. Edit + push public VGV marketplace (SoT)
cd ~/Desktop/vgv-cursor-marketplace
git add -A && git commit && git push

# 2. Bump import submodule + scoped vendor sync into plugins/
cd ~/Desktop/sea-trials-cursor-marketplace
git submodule update --remote imports/vgv-cursor-marketplace

# Preview what would change (safe — no writes)
node scripts/sync-vendor-plugins.mjs --dry-run

# Apply scoped sync (never rsync --delete at plugin root)
node scripts/sync-vendor-plugins.mjs

# 3. Update PLUGIN_SOURCES.md VGV SHAs (parent agent / maintainer after bump)
git add imports/ plugins/vgv-* PLUGIN_SOURCES.md .gitmodules
git commit -m "sync(vgv): bump import from vgv-cursor-marketplace"
git push
# Dashboard → Refresh → Cmd+Q
```

### Why scoped sync (not blind `rsync --delete`)

Dual-host packaging keeps **Cursor** trees (`cursor/`, `rules/`, `mcp.json`,
`.cursor-plugin/`) and **Claude** trees (`skills/`, `agents/`, `hooks/`,
`.claude-plugin/`, `.mcp.json`) under the same `plugins/vgv-*` directory.
A root-level `rsync -a --delete` would wipe whichever host tree the import
checkout does not currently carry.

`scripts/sync-vendor-plugins.mjs` rsyncs **only** declared subtrees and root
files per plugin. `--delete` is allowed **inside** a synced directory (for
example `cursor/`), never at `plugins/vgv-wingspan/` or
`plugins/vgv-ai-flutter-plugin/` root.

## Sea Trials plugin

Edit `plugins/sea-trials/` directly in this repo — it is the source of
truth for push-gate and PR-review orchestration (app repos keep CI config
only). Shared skill text lives once in
`plugins/sea-trials/skills/_sources/`; regenerate the per-skill copies with
`node scripts/sync-skill-sources.mjs` (CI runs `--check`). Bump `version`
in both `plugin.json` files before publishing — Claude caches by version.
