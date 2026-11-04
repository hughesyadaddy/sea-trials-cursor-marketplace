<!-- GENERATED from skills/_sources/sprint-cards-cli.md — do not edit; run node scripts/sync-skill-sources.mjs -->
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
| `connect <dir> [same flags] [--story-points-field customfield_N] [--sprint-field customfield_N]` | Save site, cloud id, project, board, sprint and field ids in `compare/index.json` and `plan.json`. | no |
| `new <dir> epic\|story\|subtask --title T [--parent ID] [--points N] [--labels a,b]` | New card from the template, last under its parent, then renumber. `--parent` takes a local id, Jira key or folder. | no |
| `ids <dir>` | Fill local ids and parent links from the nesting; rebuild `index.json`. Never changes a Jira key. | no |
| `number <dir>` | `order`, `plan_number`, `User Story N:` from the sibling order. | no |
| `lint <dir> [--json]` | Card format check. Exit 1 on errors. | no |
| `manifest <dir>` | Rebuild `compare/manifest.json`. | no |
| `serve <dir> [--viewer DIR] [--port N] [--strict-port]` | Run `python3 sprint-plan-viewer/spv.py serve --plan <dir>` from the submodule (see the folder format). Exit 3 when the submodule is missing. | no |
| `viewer <config\|build\|check\|resync\|import-jira\|push\|serve> <dir> [spv args]` | Run that `spv.py` command with `--plan <dir>`; the args after `<dir>` go through untouched. `push --apply` here writes. | `push --apply` only |
| `auth status\|login --email E\|logout` | The user key (never printed). | no |
| `discover [--project-key K] [--board N]` | User key: list projects, boards, sprints. | no (GET) |
| `pull <dir> [--epic KEY]... [--adopt] [--no-images] [--builtin]` | User key: refresh every Jira copy and image. With the viewer present it runs `spv.py resync --images`. `--adopt` (built-in only) makes local cards for issues in the sprint or epics that have none. | no (GET) |
| `import-jira <dir> <issues.json> [more.json...] [--builtin]` | MCP path: write Jira copies from issue JSON. With the viewer present it runs `spv.py import-jira`. | no |
| `push <dir> [--keys K,..] [--only create,update,transition,upload,sprint,rank] [--backlog]` | Dry run: list every operation. | no |
| `push <dir> --apply [--builtin]` | User key: run the operations. Refused while lint has errors. With the viewer present, updates, creates and images go through `spv.py push --apply --keys/--create/--images` (the dry run prints that command), then the CLI does transitions, sprint moves and rank. | **yes** |
| `push <dir> --mcp-plan FILE` | MCP path: write the steps for the agent to run. | no |
| `record <dir> <local_id> --key KEY [--id N]` | Save a key made through MCP into the card and its children. Prints a reminder when the folder still says `LOCAL`. | no |
| `folders <dir> [--apply]` | Dry run: list card folders that still say `LOCAL` although the card has a Jira key (the viewer hides those keys). `--apply` renames them, children first, and rebuilds `index.json`. Run it after `record` or `push --apply` creates cards, then `lint`. | no |
| `doctor <dir>` | Node version, folder, saved Jira data, connection mode, viewer found or not. | no |

Exit codes: 0 ok, 1 problems found (lint errors, failed operations), 2 bad input, 3 the user key or the viewer is needed. Viewer commands pass on the viewer's exit code.

`JIRA_READ_ONLY=1` makes every REST write fail before it leaves the machine, and makes `push --apply` stop before any network call. Use it for tests and reviews. `SPRINT_CARDS_NO_KEYCHAIN=1` makes the CLI skip the OS keychain.
