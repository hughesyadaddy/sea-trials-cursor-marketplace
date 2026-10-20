---
name: st-jira-upload
description: >-
  Send a sprint card folder to Jira and keep the two in sync: dry run
  first, then create (parents first), update, transition, attach
  images, set parents, move to the sprint and rank, then read back and
  resync. Uses the Atlassian MCP (OAuth sign-in) by default, and the
  user's Atlassian API token for the full feature set when one is set.
  Done cards are never changed. Use when the user asks to upload,
  push, sync or update Jira from the sprint folder.
disable-model-invocation: true
user-invocable: true
---

<!-- CURSOR_VGV_PORT -->
> **Dual-host port:** use the host structured question
> tool — **AskQuestion** on Cursor, **AskUserQuestion**
> on Claude Code. Prefer whichever exists in the tool
> schema. Never ask option lists as plain chat text when
> a structured question tool is available.
> On Cursor: continue handoffs in this chat (Plan now /
> Build now). Never output `/clear` or `/new-chat`.
> On Claude Code: clear-context handoffs remain valid.

# Jira upload

The folder is the plan; Jira gets a copy. Every write is shown in a
dry run and approved by the user first.

**Read first:**

- [`references/shared/jira-connection.md`](references/shared/jira-connection.md) (both paths, the feature table, safety)
- [`references/shared/sprint-cards-cli.md`](references/shared/sprint-cards-cli.md)
- [`references/shared/sprint-folder-format.md`](references/shared/sprint-folder-format.md)
- [`references/shared/sprint-card-format.md`](references/shared/sprint-card-format.md) (what lint checks)

---

## Phase 0: Locate and pick the path

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
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
DIR="$REPO_ROOT/sprint_planning/<sprint-slug>"     # put the real folder the user named here
# doctor exits 1 while something is missing; its FAIL lines are things to fix, not a stop.
node "$CLI" doctor "$DIR" || true
node "$CLI" auth status "$DIR"
```

- `Mode: user key`: **key path** (REST, every feature).
- `Mode: Atlassian MCP`: **MCP path**. Check that the Atlassian MCP
  tools are there (`getAccessibleAtlassianResources`). When they are
  not, tell the user to enable the `atlassian` MCP server of this
  plugin and sign in, or to set the user key (`auth login --email`).

Missing site, project or sprint in `doctor`: find them as in
`jira-connection.md` and save them with `connect`.

---

## Phase 1: Resync and check (read only)

Run the resync from `/st-sprint-refine` Phase 1 (`pull`, or MCP search
plus `import-jira`), so the plan compares with live Jira. Then:

```bash
node "$CLI" lint "$DIR"                 # must exit 0; fix cards first
node "$CLI" push "$DIR"                 # dry run
```

Show the user the dry run (each line is one write), the notes, and
for the MCP path the steps that need the user key. Ask one structured
question: send all, send only some keys (`--keys K1,K2` or local ids),
only some kinds (`--only update,transition`), or stop. Nothing is
written before the user says yes.

---

## Phase 2a: Key path

```bash
node "$CLI" push "$DIR" --apply [--keys ...] [--only ...] [--backlog]
```

With the `sprint-plan-viewer/` submodule there, the dry run prints the
exact `spv.py push --apply --keys ... --create ... --images` command;
`--apply` runs it (the viewer writes updates, creates and images and
puts the new keys in the cards), then does the transitions, sprint
moves and rank that the viewer does not do. Show the user that command
in the dry run you ask them to approve. `--builtin` uses only this
plugin's code.

It creates parents first and searches before each create, so a rerun
never makes duplicates. Updates read the live issue first, skip Done,
and back up the old fields to `PUSH-BACKUP-*.jsonl`. Images are
attached once (sha256 and name and size checks). Then sprint moves,
rank, a read-back and fresh Jira copies. Every write is in
`PUSH-LOG-*.jsonl`, without secrets. Exit 1 lists the failed
operations; fix the cause and run the same command again.

## Phase 2b: MCP path

```bash
node "$CLI" push "$DIR" --mcp-plan /tmp/mcp-plan.json [--keys ...] [--only ...]
```

Start one `st-jira-uploader` (never in parallel) with the folder,
`$CLI`, the plan path and the line `User approved this plan.`. Or run
the steps yourself, exactly as in `jira-connection.md` ("Running an
MCP plan safely"): precheck search, create, `record` at once, the
Done and stale checks before each update. When the plan reports
`deferred_creates`, make a new plan and run it: the children of the
new parents are next. Tell the user which steps need the user key and
what to do by hand (attach in Jira, drag on the board).

---

## Phase 3: Verify

Start one `st-jira-verifier` with the folder, `$CLI` and the mode, or
run its steps yourself. The dry run after the push lists 0 operations
except the user-key steps the MCP path skipped. Add one line to
`SPRINT-CHANGES.md`. Start the viewer (the `sprint-plan-viewer/`
submodule) for the user:

```bash
node "$CLI" serve "$DIR"
```

## Report

| Local id | Key | Created / updated / skipped | Note |
| --- | --- | --- | --- |

Then the read-back result, the steps left for the user, and the log
file path.

---

## Subagents

| Host | Uploader or verifier |
| --- | --- |
| Claude Code | `Agent` (or `Task`) with `subagent_type: st-jira-uploader` / `st-jira-verifier` (may show as `<plugin>:<name>`) |
| Cursor | `Task` with `subagent_type: st-jira-uploader` / `st-jira-verifier` |
| No subagent tool | Run the steps yourself |

The uploader runs alone. Several verifiers may run in parallel, one
per epic.

## Forbidden

- Any write before the user approved the dry run.
- `--apply` while lint has errors (`--skip-lint` only when the user
  asks for it by name).
- Changing a card that is Done in Jira, deleting issues, or posting
  comments.
- Creating a card through MCP without the precheck search, or going
  to the next step before `record` saved the key.
- Printing, echoing or asking for the API token in chat. The user
  types it into the keychain prompt (`auth login`) or their shell.
- Writing to any Jira site other than the one in `compare/index.json`.
