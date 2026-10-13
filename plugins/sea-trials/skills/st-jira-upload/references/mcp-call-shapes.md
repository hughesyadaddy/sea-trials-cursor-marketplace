# Atlassian MCP call shapes (v1 tool names)

Server: **only** the Atlassian connector named `atlassian-seatrials`
(plugin MCP) or whose id ends in `--seatrials` (Cursor dashboard, e.g.
`dashboard-team-<id>-Atlassian-allinpmprep--seatrials`). Never use an
`allinpmprep` connector without `--seatrials`. Before any call, run
`getAccessibleAtlassianResources` and stop unless an entry has
`url == "https://seatrials.atlassian.net"` (or `sprint.json.site`).
Read the tool schema before the first call of a session; parameter
names below were taken from the v1 schema and can drift.

## Discovery

| Need | Call |
| --- | --- |
| Cloud id | `getAccessibleAtlassianResources` → pick `id` whose `url` equals `sprint.json.site` |
| Issue types | `getJiraProjectIssueTypesMetadata` `{cloudId, projectIdOrKey}` → names for Story / Subtask |
| Account id | `assignees.json` first; else `lookupJiraAccountId` `{cloudId, searchString: "<display name or email>"}`. More than one match: prefer the account with recent activity in the project (JQL `assignee = <id> AND updated >= -30d`); still ambiguous: stop and ask |
| Story points field | `node "$SPRINT/jira-rest.mjs" fields --name "Story point"` (REST) |

## Create story

```json
{
  "cloudId": "<cloudId>",
  "projectKey": "<PROJECT_KEY>",
  "issueTypeName": "Story",
  "summary": "User Story 3: Members export a single invoice as PDF",
  "description": { "type": "doc", "version": 1, "content": [ "...ADF..." ] },
  "contentFormat": "adf",
  "assignee_account_id": "<accountId or omit>",
  "additional_fields": {
    "parent": { "key": "<EPIC-KEY>" },
    "labels": ["billing", "sprint-12"],
    "customfield_10016": 5
  }
}
```

`description` is the parsed object from `md-to-adf.mjs --out`, not a
string. The response carries `key`; record it.

## Create subtask

Same as above with `issueTypeName: "Subtask"` (or `"Sub-task"`) and
top-level `"parent": "<STORY-KEY>"`. No `additional_fields.parent`.
Story points on subtasks only when the project's subtask screen has the
field; a `400` naming the field means it does not, so retry without it
and report.

## Edit (update bucket)

Stale check first (contract 10.6): `getJiraIssue` the key with
`fields: ["updated","description","labels"]`, save the ADF to
`SCRATCH/<KEY>.before.json`, and compare `updated` with the value in
`jira_state.json`. If Jira is newer, do not edit; report the card.

```json
{
  "cloudId": "<cloudId>",
  "issueIdOrKey": "<KEY>",
  "contentFormat": "adf",
  "fields": {
    "summary": "<H1>",
    "description": { "type": "doc", "version": 1, "content": [ "..." ] },
    "labels": ["billing", "sprint-12"],
    "customfield_10016": 5
  }
}
```

Never include `parent` on edit. Never clear fields you did not set.

## No follow-up edits

Labels and story points always go in the same create or edit as the
body. There is no planned "typo pass" and no deferred-field edit. If a
legacy schedule contains an `<id>#edit` entry, skip it and report
`EDIT <id>: skipped (deferral disabled)`.

## Comment (update bucket)

At most one comment per card in the `update` bucket, and only when the
change touched acceptance criteria or scope. Body text is the line the
parent took from `human-cadence.mjs vary comment-opener` for that
card; never write your own. The call follows the card's read-back and
counts as a write for cadence (call `wait` first).

```json
{
  "cloudId": "<cloudId>",
  "issueIdOrKey": "<KEY>",
  "contentFormat": "adf",
  "commentBody": "{\"type\":\"doc\",\"version\":1,\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Updated the AC after standup.\"}]}]}"
}
```

The v1 schema types `commentBody` as a string, so the ADF document is
serialised (`JSON.stringify`), not passed as an object like
`description`. Build it from the `vary` line:

```bash
node -e 'const t=process.argv[1];console.log(JSON.stringify({type:"doc",
version:1,content:[{type:"paragraph",content:[{type:"text",text:t}]}]}))' \
  "$(node "$SPRINT/human-cadence.mjs" vary comment-opener)"
```

Other free text goes the same way: `vary moved-to-backlog` for a card
leaving the sprint, `vary verifier-remark` when the parent asks for a
verification note. Anything not produced by `vary` must pass
`node "$SPRINT/human-cadence.mjs" check "<text>"` before it is sent.

## Read back (parity)

```json
{
  "cloudId": "<cloudId>",
  "issueIdOrKey": "<KEY>",
  "responseContentFormat": "adf",
  "fields": ["summary", "description", "status", "labels",
             "customfield_10016", "parent", "subtasks"]
}
```

Then assert the response: `key` equals the requested key, the key's
project equals `projectKey`, `parent.key` is the expected parent, and
`labels` / story points equal what was sent. Any mismatch is a hard
stop (wrong issue or wrong site). Record `updated` in `jira_state.json`.

Count nodes (`taskItem`, `heading`, and `codeBlock`; also scan text for
literal `[ ]` / `[x]` / `\[`):

```bash
node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
let t=0,h=0,c=0,esc=0;(function w(n){if(!n)return;if(n.type==="taskItem")t++;
if(n.type==="heading")h++;if(n.type==="codeBlock")c++;
if(n.type==="text"&&/\\?\[[ xX]\]/.test(n.text||""))esc++;(n.content||[]).forEach(w)})(d);
console.log("taskItems",t,"headings",h,"codeBlocks",c,"escapedBoxes",esc)' description.adf.json
```

Source counts: `- [ ]`/`- [x]` lines and heading lines in the card
body from `payload.json` (fenced code excluded).

## Blocks link

`**Blocked by:** US2` on story 3 becomes:

```json
{
  "cloudId": "<cloudId>",
  "type": "Blocks",
  "inwardIssue": "<KEY of US2>",
  "outwardIssue": "<KEY of US3>"
}
```

Inward is the blocker. Do not pass a `comment`; links need none.

## Search (state repair and duplicates)

```json
{ "cloudId": "<cloudId>", "jql": "parent = <STORY-KEY> ORDER BY rank ASC",
  "fields": ["summary", "status"], "maxResults": 100 }
```

Follow `nextPageToken` until absent. Before re-issuing a create after
an ambiguous failure: `project = <KEY> AND summary ~ "\"<H1>\""`.

## Uploader worker prompt

```text
You are st-jira-uploader. Upload story {id} only, on the schedule below.

SPRINT={SPRINT}   SCRATCH={scratch}/{id}   PAYLOAD={scratch}/payload.json
cloudId={cloudId} projectKey={projectKey} epicKey={epicKey}
storyIssueType={storyIssueType} subtaskIssueType={subtaskIssueType}
storyPointsFieldId={spField} labels={labels incl. routing label} assigneeAccountId={routed assignee}
T0={iso timestamp of the run's first write}
Window: hours={08:00-19:30} weekends={no} tz={zone} ignoreHours={no}

Schedule slice (execute in this order; before each write run
  node "$SPRINT/human-cadence.mjs" wait --start "$T0" --offset <ms>):
  {id}        create  offset=612340
  {id}.1      create  offset=627113
  {id}.2      update  offset=649870  key={KEY}  updated={recorded Jira updated}
  ...

Buckets from --diff:
  story {id}: {create|update KEY|unchanged KEY}
  subtask {id}.1: {create|update KEY|unchanged KEY}
  ...
Key map for Blocked by resolution: {json of storyId -> KEY}
Comment lines for update cards (use each once, verbatim):
  {id}: "{vary comment-opener output}"

Rules: contentFormat "adf" always; description is the ADF object;
parent.key for the epic; top-level parent for subtasks; never write
before an entry's offset, never two writes in one second, at least 3 s
between your writes even when behind; one write at a time; labels and
story points ride on the create or edit; stale check (compare updated)
before every edit; honour Retry-After; read back after every write and
check key, site, parent, labels and parity (contract 10.3, 10.6); never create a card that has a key above; no free text of
your own in Jira. Return only your return block.
```

## Verifier worker prompt

```text
You are st-jira-verifier. Read-only.
cloudId={cloudId} storyPointsFieldId={spField}
Keys and source markdown:
{KEY}: <<<
{card body from payload}
>>>
...
Banned phrasing list: {contract section 5 text}
Run checks P1-P5, C1-C6, F1-F5. Return only your return block.
```
