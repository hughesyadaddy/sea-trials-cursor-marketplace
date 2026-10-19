# sprint-cards CLI

One Node script, no dependencies (Node 20 or newer): `scripts/sprint-cards/cli.mjs` in this plugin.

## Find it

```bash
# 1. Claude Code writes the plugin path into the next line when it loads this skill.
CLI="${CLAUDE_PLUGIN_ROOT}/scripts/sprint-cards/cli.mjs"
# 2. Cursor and other hosts: plugin root env vars.
for root in "${CURSOR_PLUGIN_ROOT:-}" "${ST_PLUGIN_ROOT:-}"; do
  [[ -f "$CLI" ]] || CLI="$root/scripts/sprint-cards/cli.mjs"
done
# 3. Else the newest installed copy.
if [[ ! -f "$CLI" ]]; then
  CLI=""
  while IFS= read -r f; do [[ -z "$CLI" || "$f" -nt "$CLI" ]] && CLI="$f"; done \
    < <(find "$HOME/.claude/plugins" "$HOME/.cursor/plugins" -path '*/scripts/sprint-cards/cli.mjs' 2>/dev/null)
fi
[[ -f "$CLI" ]] || { echo "sprint-cards CLI not found: it is scripts/sprint-cards/cli.mjs two folders above this SKILL.md's folder" >&2; }
node "$CLI" --help >/dev/null && echo "CLI: $CLI"
```

When all three fail, set `CLI` by hand: the skill you are reading is at `<plugin>/skills/<skill>/SKILL.md`, so the CLI is `<plugin>/scripts/sprint-cards/cli.mjs`, for example `/Users/me/.cursor/plugins/cache/<marketplace>/<plugin>/<version>/scripts/sprint-cards/cli.mjs`. Use the same `$CLI` for the whole run and pass it to every subagent.

## Commands

| Command | What it does | Writes to Jira |
| --- | --- | --- |
| `init <dir> [--project-key K] [--site S] [--cloud-id C] [--board N] [--sprint-id N] [--sprint-name X]` | New sprint folder: `compare/`, `index.json`, `CARD-FORMAT.md`, `SPRINT-CHANGES.md`, `OPEN-QUESTIONS.md`, `README.md`, `.gitignore`. Keeps files that exist. | no |
| `connect <dir> [same flags]` | Save site, cloud id, project, board, sprint in `compare/index.json`. | no |
| `new <dir> epic\|story\|subtask --title T [--parent ID] [--points N] [--labels a,b]` | New card from the template, last under its parent, then renumber. `--parent` takes a local id, Jira key or folder. | no |
| `ids <dir>` | Fill local ids and parent links from the nesting; rebuild `index.json`. Never changes a Jira key. | no |
| `number <dir>` | `order`, `plan_number`, `User Story N:` from the sibling order. | no |
| `lint <dir> [--json]` | Card format check. Exit 1 on errors. | no |
| `manifest <dir>` | Rebuild `compare/manifest.json`. | no |
| `serve <dir> [--viewer DIR] [--port N]` | Start the `sprint-plan-viewer/` submodule on this folder (see the folder format). Exit 3 when the submodule is missing. | no |
| `auth status\|login --email E\|logout` | The user key (never printed). | no |
| `discover [--project-key K] [--board N]` | User key: list projects, boards, sprints. | no (GET) |
| `pull <dir> [--epic KEY]... [--adopt] [--no-images]` | User key: refresh every Jira copy and image. `--adopt` makes local cards for issues in the sprint or epics that have none. | no (GET) |
| `import-jira <dir> <issues.json>` | MCP path: write Jira copies from issue JSON. | no |
| `push <dir> [--keys K,..] [--only create,update,transition,upload,sprint,rank] [--backlog]` | Dry run: list every operation. | no |
| `push <dir> --apply` | User key: run the operations. Refused while lint has errors. | **yes** |
| `push <dir> --mcp-plan FILE` | MCP path: write the steps for the agent to run. | no |
| `record <dir> <local_id> --key KEY [--id N]` | Save a key made through MCP into the card and its children. | no |
| `doctor <dir>` | Node version, folder, saved Jira data, connection mode. | no |

Exit codes: 0 ok, 1 problems found (lint errors, failed operations), 2 bad input, 3 the user key is needed.

`JIRA_READ_ONLY=1` makes every REST write fail before it leaves the machine. Use it for tests and reviews.
