# VGV Wingspan — dual-host port (Cursor + Claude)

Upstream: [VeryGoodOpenSource/vgv-wingspan](https://github.com/VeryGoodOpenSource/vgv-wingspan)  
Cursor packaging: dual-manifest port (AskQuestion, flat agents, `/code-review`)  
Claude packaging: upstream tree at plugin root (`skills/`, `agents/`, `hooks/`)

## Layout

| Path | Host |
| --- | --- |
| `cursor/skills/`, `cursor/agents/`, `cursor/hooks/` | Cursor |
| `skills/`, `agents/`, `hooks/` | Claude Code |
| `rules/` | Cursor only (always-on `.mdc`) |
| `mcp.json` | Cursor (`${CURSOR_PLUGIN_ROOT}`) |
| `.mcp.json` | Claude (context7 via npx) |

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

1. Rsync upstream Claude tree into plugin root:
   `skills/`, `agents/`, `hooks/`, `.claude-plugin/`, `.mcp.json`
2. Diff upstream against `cursor/skills/` and `cursor/agents/`.
3. Re-apply Cursor port transforms (see table above).
4. Bump versions in `.cursor-plugin/plugin.json` and `.claude-plugin/plugin.json`.
5. Run `claude plugin validate plugins/vgv-wingspan`.

License: MIT (see `LICENSE`).
