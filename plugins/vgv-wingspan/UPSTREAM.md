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

## Fork-only additions (present in both host copies)

These sections do not exist upstream. They are additive, so re-apply them
after an upstream sync and keep the two copies identical
(`node scripts/check-skill-copies.mjs` at the repo root enforces this):

| Addition | Where |
| --- | --- |
| `## Parallel execution map` plan section + Model tiering | `skills/plan/SKILL.md`, `cursor/skills/plan/SKILL.md` |
| `## Parallel build` mode (rolling-window fan-out, integrator) | `skills/build/SKILL.md`, `cursor/skills/build/SKILL.md` |
| Spec reference `parallel-execution-map.md` | `skills/shared/references/` (symlinked from plan/build/plan-technical-review) and `cursor/skills/{plan,build,plan-technical-review}/references/` |
| Map preserve/validate paragraphs | brainstorm, plan-technical-review, refine-approach (both copies); `plan-review.md` copies |
| Model tiers + rolling-window anti-patterns | `rules/vgv-wingspan-agents.mdc` (Cursor only) |

## Refreshing from upstream

When VGV ships a new Wingspan release:

1. Rsync upstream Claude tree into plugin root:
   `skills/`, `agents/`, `hooks/`, `.claude-plugin/`, `.mcp.json`
2. Diff upstream against `cursor/skills/` and `cursor/agents/`.
3. Re-apply Cursor port transforms (see table above).
4. Bump versions in `.cursor-plugin/plugin.json` and `.claude-plugin/plugin.json`.
5. Run `claude plugin validate plugins/vgv-wingspan`.
6. Run `node scripts/check-skill-copies.mjs` and
   `node --test scripts/check-skill-copies.test.mjs` from the repo root.

License: MIT (see `LICENSE`).
