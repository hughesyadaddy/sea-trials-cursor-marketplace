# Plugin source pins

| Plugin | Source | SHA / note |
| --- | --- | --- |
| vgv-wingspan | git submodule `imports/vgv-cursor-marketplace` → `hughesyadaddy/vgv-cursor-marketplace` | `5622046867a18a7d4d1e4a8e0d9e16b60accec62` |
| vgv-ai-flutter-plugin | git submodule `imports/vgv-cursor-marketplace` → `hughesyadaddy/vgv-cursor-marketplace` | `5622046867a18a7d4d1e4a8e0d9e16b60accec62` |
| sea-trials | this repo `plugins/sea-trials/` (committed SoT; self-contained runtime) | (update on publish) |

Vendored `plugins/vgv-*` are copied from `imports/vgv-cursor-marketplace`
via `node scripts/sync-vendor-plugins.mjs` after a submodule bump. Edit
`plugins/sea-trials/` in this repo directly; never hand-edit `plugins/vgv-*`.

## SHA format

- **vgv-wingspan** and **vgv-ai-flutter-plugin** share one submodule pin —
  record the same 40-character commit SHA for both rows after each bump.
- Update SHAs in this file **after** `git submodule update --remote` and
  **before** commit; the sync script does not write SHAs automatically.
- Parent build agent / maintainer updates this table; subagents only run
  scoped sync.
