<!-- GENERATED from skills/_sources/sprint-folder-format.md — do not edit; run node scripts/sync-skill-sources.mjs -->
# Sprint folder format

A sprint folder lives at `sprint_planning/<sprint-slug>/` in the app repo. The viewer and the CLI read only this folder. There is no other config file: what the CLI needs to know about Jira is data in `compare/index.json`.

```
sprint_planning/<sprint-slug>/
  CARD-FORMAT.md            copy of the card format (written by init)
  SPRINT-CHANGES.md         one line per plan change, newest first
  OPEN-QUESTIONS.md         anything still open; never inside a card
  README.md                 how to view, check and push this folder
  .gitignore                ignores viewer state, snapshots, logs, Jira images
  PUSH-LOG-YYYYMMDD.jsonl   what push --apply did (no secrets)
  PUSH-BACKUP-YYYYMMDD.jsonl  Jira fields before each update
  jira-snapshot-YYYYMMDD/   raw Jira JSON and Markdown from pull
  compare/
    index.json              jira block + one record per card
    manifest.json           viewer data (rebuilt on every view)
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
- `field_ids` is written by `pull` with the user key. On the MCP path the skill can write it with `connect` once it knows the ids.
- `items` is rebuilt by `ids` on every run. `sync_status` is one of `in_sync`, `local_edited`, `jira_edited`, `conflict` or `local_only`.

## images/manifest.json

A JSON list. One record per file:

```json
[{ "filename": "screen.png", "sha256": "...", "status": "staged", "path": "images/staged/screen.png", "jira_attachment_id": null }]
```

`status` is `in_jira` (attached), `staged` (attach on the next push), or `removed_in_jira`. A file dropped into `images/staged/` without a record is also staged. Push never attaches the same sha256 twice, and checks the issue's attachments for the same file name and size before and after an upload.

## The viewer

`node <CLI> serve <sprint-folder>` starts a local page at `http://127.0.0.1:8766/` (the next free port when 8766 is taken; `--port N` or `SPRINT_VIEWER_PORT` to pick one). It shows each card next to its Jira copy with a diff, field changes, numbering problems and images. Dragging a card saves `order` and renumbers. "Pull from Jira" runs the GET-only pull when the user key is set; without it, the viewer says to resync through the agent. The server listens on 127.0.0.1 only and refuses writes from other origins.
