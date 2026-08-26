# VGV import (private unified marketplace)

Cursor **Team plan allows one** marketplace import. VGV plugin **source of
truth** stays in the public repo `hughesyadaddy/vgv-cursor-marketplace`.

## How import works

| Layer | Mechanism |
| --- | --- |
| **Link** | Git submodule `imports/vgv-cursor-marketplace` → public marketplace repo |
| **Runtime** | Vendored copies under `plugins/vgv-*` (Cursor indexes committed files) |
| **Team overlay** | `plugins/sea-trials` — agents, MCP, hooks only |

Cursor does **not** support cross-repo plugin entries in `marketplace.json`
(for example `{"type":"github","owner":"...","repo":"..."}`) as a substitute
for vendoring. Submodules alone are also skipped at index time — scaffold
copies plugin trees into `plugins/` on each publish.

## Submodule contents (at pinned SHA)

When you bump `imports/vgv-cursor-marketplace`, you vendor **entire** public
marketplace plugin trees, including:

### `plugins/vgv-wingspan` (from submodule)

| Component | Count / servers |
| --- | --- |
| Skills | **15** (`brainstorm`, `plan`, `build`, `code-review`, … plus `pr-review-loop-inplace`, `pr-review-loop-worktree`, `pre-push-harden`) |
| Review agents | 10 under `cursor/agents/` |
| Adapter rules | `rules/*.mdc` (AskQuestion, handoffs, CLI tiers, Wingspan agent map) |
| MCP | `context7` (HTTP), `vgv-ask-question` (stdio launcher) |

PR review loop skills moved here in **2026-08-26** architecture — they are
**not** duplicated under `plugins/sea-trials/`.

### `plugins/vgv-ai-flutter-plugin` (from submodule)

| Component | Count / servers |
| --- | --- |
| Skills | Flutter/Dart workflow set under `cursor/skills/` |
| Agents | `flutter-reviewer` |
| MCP | `dart`, `very-good-cli` (stdio; require local toolchain / MCP bootstrap) |

### `plugins/sea-trials` (team emit, not from submodule)

| Component | Ships |
| --- | --- |
| Agents | `powersync-migration-operator`, `macos-appstore-signing` |
| MCP | `atlassian-seatrials`, `atlassian-allinpmprep` (URL OAuth Connect), `chrome-devtools` (local `127.0.0.1:9333`) |
| Hooks | Cursor hooks JSON when emitted |
| Skills | **None** — use vendored Wingspan for all slash skills |

## Update VGV in the private marketplace

```bash
# 1. Edit + push public marketplace (SoT)
./scripts/scaffold-vgv-only-cursor-marketplace.sh
cd ~/dev/vgv-cursor-marketplace && git push

# 2. Bump import submodule + vendor into plugins/
./scripts/scaffold-sea-trials-cursor-marketplace.sh
cd ~/dev/sea-trials-cursor-marketplace
git add imports/ plugins/vgv-* plugins/sea-trials PLUGIN_SOURCES.md .gitmodules
git commit -m "chore: bump VGV import from vgv-cursor-marketplace"
git push
```

Never hand-edit `plugins/vgv-*` — re-run scaffold after bumping the import.