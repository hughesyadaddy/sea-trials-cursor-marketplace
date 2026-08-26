# Plugin source pins

| Plugin | Source | SHA / note |
| --- | --- | --- |
| vgv-wingspan | git submodule `imports/vgv-cursor-marketplace` → `hughesyadaddy/vgv-cursor-marketplace` | `143a3f15b4cd940ce4e5ad7bde386325b6b06f36` |
| vgv-ai-flutter-plugin | git submodule `imports/vgv-cursor-marketplace` → `hughesyadaddy/vgv-cursor-marketplace` | `143a3f15b4cd940ce4e5ad7bde386325b6b06f36` |
| sea-trials | sea_trials_universal `tools/sea-trials-cursor-plugin/` (agents + MCP only) | `5793debde3fd6f33a30df3f7f17c1e935df58cb1` |

Vendored `plugins/vgv-*` are generated from the submodule import on
scaffold. Never edit them by hand.

PR review loop skills (`pr-review-loop-inplace`, `pr-review-loop-worktree`,
`pre-push-harden`) live in **vgv-wingspan** via the public VGV marketplace
import — not duplicated under `plugins/sea-trials/`.
