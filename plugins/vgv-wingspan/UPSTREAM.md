# VGV Wingspan — Cursor port (vendored)

Upstream: [VeryGoodOpenSource/vgv-wingspan](https://github.com/VeryGoodOpenSource/vgv-wingspan)  
Pinned tag: **v0.0.4** (skills content)  
Cursor packaging: dual-manifest port (AskQuestion, flat agents, `/code-review`)

## What was changed for Cursor

| Claude upstream | This Cursor port |
| --- | --- |
| `AskUserQuestion` | **AskQuestion** (dual-host dialect in skills) |
| Nested `agents/*/*` | Flat `cursor/agents/*.md` |
| `/review` | **`/code-review`** (avoids Cursor built-in `/review`) |
| Clear-context handoffs | Same-chat **Plan now** / **Build now** |
| Claude `PreToolUse` hooks | Empty `cursor/hooks/hooks.json` |
| `model: haiku` / `sonnet` | `composer-2.5` / `claude-sonnet-5` |

Adapter rules live in `rules/` and install to `~/.cursor/rules/` via
`scripts/install-cursor-vgv.sh`.

## Refreshing from upstream

When VGV ships a new Wingspan release:

1. Diff upstream `skills/` and `agents/` against this tree.
2. Re-apply Cursor port transforms (see internal port notes above).
3. Bump the version in `.cursor-plugin/plugin.json`.
4. Re-run `./scripts/install-cursor-vgv.sh` on each dev machine.

License: MIT (see `LICENSE`).
