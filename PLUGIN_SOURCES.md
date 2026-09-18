# Plugin source pins

| Plugin | Source | SHA / note |
| --- | --- | --- |
| vgv-wingspan | git submodule `imports/vgv-cursor-marketplace` → `hughesyadaddy/vgv-cursor-marketplace` | `e8db1bc4d6c597fb3d45cc8f6decce7acb6d2b20` |
| vgv-ai-flutter-plugin | git submodule `imports/vgv-cursor-marketplace` → `hughesyadaddy/vgv-cursor-marketplace` | `e8db1bc4d6c597fb3d45cc8f6decce7acb6d2b20` |
| sea-trials | this repo `plugins/sea-trials/` (committed SoT; self-contained runtime) | (update on publish) |

Vendored `plugins/vgv-*` are copied from `imports/vgv-cursor-marketplace`
after a submodule bump. Edit `plugins/sea-trials/` in this repo directly;
never hand-edit `plugins/vgv-*`.
