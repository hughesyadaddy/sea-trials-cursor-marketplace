# Agnostic install (any repo, no vendoring)

Goal: open **any** git checkout in Cursor, run `/st-*` skills and hooks,
without copying plugin files into the app repo.

## What you install once (team)

1. **Cursor** → Customize → Team Marketplace → import
   `hughesyadaddy/sea-trials-cursor-marketplace`
2. Enable **sea-trials** (and **vgv-wingspan** if you use `/plan` / `/build`)
3. Cmd+Q → reopen
4. MCP → Connect **atlassian-*** and **chrome-devtools** as needed

Cursor caches the plugin under `~/.cursor/plugins/cache/…/sea-trials/<sha>/`.
That tree is the **only** source for scripts, skills, agents, and hooks.

## What each app repo needs

| Required | Optional |
| --- | --- |
| `sprint_planning/<sprint>/` markdown + `sprint.json` | `npm run sprint:lint` shim → `st-run sprint-lint` |
| Git remote for PR review skills | `.husky/st-plugin-run.sh` for push gate |
| | `scripts/ci/st-plugin.mjs` for GHA lanes |

No `tools/sea-trials-*` copy, no pinned cache SHA paths, no
`rsync` into the repo (local smoke only).

## How the plugin finds itself

`scripts/lib/resolve-st-plugin-root.mjs`:

1. `ST_PLUGIN_ROOT` (explicit; `st-run` sets this for every hook)
2. `CURSOR_PLUGIN_ROOT` (Cursor plugin/MCP when injected)
3. `CLAUDE_PLUGIN_ROOT` (Claude Code)
4. `tools/sea-trials-cursor-plugin` in the **current** repo (maintainer dev only)
5. Newest install under `~/.cursor/plugins` / `~/.claude/plugins`
6. Dev fallback: tree containing this module

Agents bootstrap in shell:

```bash
node "$(find ~/.cursor/plugins ~/.claude/plugins \
  -path '*/sea-trials/scripts/st-run.mjs' 2>/dev/null | head -1)" print-plugin-root
```

That calls `resolveStPluginRoot()` (newest cache wins).

## Cursor features this plugin uses

| Feature | Use in sea-trials |
| --- | --- |
| Team Marketplace | Distribute plugin; Required/Default On for whole org |
| Skills (`st-*`) | Sprint, PR review, push gate, flake quarantine |
| Subagents (`Task`) | `st-sprint-author`, `st-jira-uploader`, shard workers, … |
| Hooks | Block unsafe `git push`; session model probe |
| MCP | Atlassian Jira, Chrome DevTools (Jira browser fallback) |
| Cloud agents | Set `ST_PLUGIN_ROOT` in secrets if bootstrap fails |

Official references: [Cursor Plugins](https://cursor.com/docs/plugins),
[Plugins reference](https://cursor.com/docs/reference/plugins),
[Agent Skills](https://cursor.com/docs/skills),
[MCP guide](https://cursor.com/guides/coding-agent-mcp).

## Anti-patterns

- Hardcoding `~/.cursor/plugins/cache/.../<sha>/` in app repos
- Duplicating `parse-sprint-folder.mjs` / Jira upload scripts in the app
- Pasting full `sprint-contract.md` into every subagent (use `ST_PLUGIN_ROOT` + Read)
- Bash `find … \| head -1` on plugin roots (use `print-st-plugin-root.mjs`)
