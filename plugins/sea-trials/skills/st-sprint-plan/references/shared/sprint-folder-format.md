<!-- GENERATED from skills/_sources/sprint-folder-format.md — do not edit; run node scripts/sync-skill-sources.mjs -->
# Sprint folder format

A sprint folder lives at `sprint_planning/<sprint-slug>/` in the app repo. The viewer and the CLI read only this folder. There is no other config file: what the tools need to know about Jira is data in the folder, in the `jira` block of `compare/index.json` and its mirror in `plan.json` (the settings file the viewer reads; `init`, `connect` and `pull` keep the two in step).

```
sprint_planning/<sprint-slug>/
  CARD-FORMAT.md            copy of the card format (written by init)
  SPRINT-CHANGES.md         one line per plan change, newest first
  OPEN-QUESTIONS.md         anything still open; never inside a card
  README.md                 how to view, check and push this folder
  plan.json                 Jira settings for the viewer: site, project, board_id, sprint_id,
                            sprint_name, story_points_field, sprint_field (and read_only)
  .gitignore                ignores viewer state, snapshots, logs, Jira images
  PUSH-LOG-YYYYMMDD.jsonl   what push --apply did (no secrets)
  PUSH-BACKUP-YYYYMMDD.jsonl  Jira fields before each update
  jira-snapshot-YYYYMMDD/   raw Jira JSON and Markdown from pull
  compare/
    index.json              jira block + one record per card
    manifest.json           viewer data (written by manifest, pull, import-jira)
    .state/ui.json          reviewed ticks and notes from the viewer
    NN-epic-<KEY>-<slug>/
      epic.local.md         the plan (edit this)
      epic.jira.md          the Jira copy (read only)
      images/manifest.json  image records
      images/jira/          files downloaded from Jira
      images/staged/        files to attach on the next push
      NN-story-<KEY>-<slug>/
        story.local.md
        story.jira.md
        subtasks/
          NN-<KEY>-<slug>/
            subtask.local.md
            subtask.jira.md
```

`<KEY>` is the Jira key, or `LOCAL` for a card that is not in Jira yet. `NN` is a two digit position; it does not have to match `order`.

## compare/index.json

```json
{
  "version": 2,
  "jira": {
    "site": "https://<JIRA_SITE>",
    "cloud_id": "<cloud id from getAccessibleAtlassianResources>",
    "project_key": "<PROJECT_KEY>",
    "board_id": 12,
    "sprint_id": 345,
    "sprint_name": "<SPRINT_NAME>"
  },
  "field_ids": { "storyPoints": "customfield_10016", "sprint": "customfield_10020" },
  "pulled_at": "2026-01-01T00:00:00.000Z",
  "items": {
    "loc-PROJ-123": {
      "jira_key": "PROJ-123", "jira_id": "10123", "folder": "01-epic-PROJ-123-slug",
      "kind": "epic", "summary": "...", "parent_local_id": null, "parent_jira_key": null,
      "jira_updated": "...", "content_hash_at_pull": "...", "local_content_hash": "...",
      "jira_content_hash": "...", "sync_status": "in_sync"
    }
  }
}
```

- The `jira` block is written by `init` and `connect`. The skill finds the values at run time (see the Jira connection reference) and saves them here so the next run does not ask again.
- `field_ids` is written by `pull` with the user key. On the MCP path the skill writes it with `connect --story-points-field customfield_N --sprint-field customfield_N` once it knows the ids (from `getJiraIssueTypeMetaWithFields`).
- `items` is rebuilt by `ids` on every run. `sync_status` is one of `in_sync`, `local_edited`, `jira_edited`, `conflict` or `local_only`.

## images/manifest.json

A JSON list. One record per file:

```json
[{ "filename": "screen.png", "sha256": "...", "status": "staged", "path": "images/staged/screen.png", "jira_attachment_id": null }]
```

`status` is `in_jira` (attached), `staged` (attach on the next push), or `removed_in_jira`. A file dropped into `images/staged/` without a record is also staged. Push never attaches the same sha256 twice, and checks the issue's attachments for the same file name and size before and after an upload.

## The viewer (sprint-plan-viewer)

The web viewer is its own project-agnostic repo, https://github.com/hughesyadaddy/sprint-plan-viewer (private). Each project adds it as a git submodule of its sprint planning repo, next to the sprint folders:

```
<sprint planning folder>/        (often sprint_planning/ in the app repo)
  sprint-plan-viewer/            git submodule
  <sprint-slug>/compare/...
```

Set it up once per project, from the planning folder:

```bash
git submodule add https://github.com/hughesyadaddy/sprint-plan-viewer.git sprint-plan-viewer
git commit -m "Add sprint-plan-viewer"
```

After a fresh clone: `git submodule update --init sprint-plan-viewer`. It needs Python 3.9+ and PyYAML (`python3 -m pip install pyyaml`).

Its CLI is `python3 sprint-plan-viewer/spv.py <command> --plan <sprint folder>` (`--plan` takes a path, a folder name or part of one; without it the newest plan is used). Commands: `list`, `config`, `serve [--port N] [--strict-port]` (also `serve.py`), `resync [--dry] [--images]` (GET only), `import-jira FILE...`, `build`, `check`, `push` (dry run; writes only with `--apply` plus `--keys K1,K2`, `--create <local_ids>` or `--images`) and `convert SRC [--out DIR] [--jira-json FILE] [--allow-push]`. Its README is the guide to its options.

Start it either way:

```bash
python3 sprint-plan-viewer/spv.py serve --plan <sprint-slug>     # from the planning folder
node <CLI> serve <sprint-folder> [--port N] [--strict-port]       # same thing, found from the sprint folder
```

`node <CLI> serve` finds `sprint-plan-viewer/spv.py` in the sprint folder or any folder above it, up to the git root (or `--viewer DIR`, or `SPRINT_PLAN_VIEWER`), writes `plan.json` from the saved Jira data, and runs `spv.py serve --plan <sprint folder>` from the folder that holds the viewer. An empty `sprint-plan-viewer/` (submodule not initialised) does not count. Without the viewer it exits 3 and prints the submodule command. `node <CLI> viewer <command> <sprint-folder> [spv args]` runs any other `spv.py` command the same way. This plugin does not ship a viewer of its own.

Which tool does what when the viewer is there (one implementation each):

| Job | Viewer present | No viewer |
| --- | --- | --- |
| View, reorder | `spv.py serve` | not available |
| Resync with the user key (GET) | `spv.py resync` (`node <CLI> pull` runs it) | `node <CLI> pull` |
| Resync on the MCP path | `spv.py import-jira FILE...` (`node <CLI> import-jira` runs it) | `node <CLI> import-jira` |
| Updates, creates, images with the user key | `spv.py push --apply --keys/--create/--images` (`node <CLI> push --apply` runs it) | `node <CLI> push --apply` |
| Transitions, sprint moves, rank | `node <CLI> push --apply` (the viewer does not do these) | `node <CLI> push --apply` |
| Writes on the MCP path | `node <CLI> push --mcp-plan` + `record` | same |
| Card ids, numbering, lint | `node <CLI> ids / number / lint` (`spv.py check` also parses) | same |

`--builtin` on `pull`, `import-jira` or `push` uses this plugin's code even when the viewer is there. `pull --epic` / `--adopt` and `import-jira --adopt` always use the built-in code (the viewer has no such options).
