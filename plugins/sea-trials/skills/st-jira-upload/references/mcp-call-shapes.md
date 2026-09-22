# Atlassian MCP call shapes (v1 tool names)

Server: the MCP whose name contains `atlassian`. Read the tool schema
before the first call of a session; parameter names below were taken
from the v1 schema and can drift.

## Discovery

| Need | Call |
| --- | --- |
| Cloud id | `getAccessibleAtlassianResources` → pick `id` whose `url` equals `sprint.json.site` |
| Issue types | `getJiraProjectIssueTypesMetadata` `{cloudId, projectIdOrKey}` → names for Story / Subtask |
| Account id | `lookupJiraAccountId` `{cloudId, searchString: "<display name or email>"}` |
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

Count nodes:

```bash
node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
let t=0,h=0;(function w(n){if(!n)return;if(n.type==="taskItem")t++;
if(n.type==="heading")h++;(n.content||[]).forEach(w)})(d);
console.log("taskItems",t,"headings",h)' description.adf.json
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
You are st-jira-uploader. Upload story {id} only.

SPRINT={SPRINT}   SCRATCH={scratch}/{id}   PAYLOAD={scratch}/payload.json
cloudId={cloudId} projectKey={projectKey} epicKey={epicKey}
storyIssueType={storyIssueType} subtaskIssueType={subtaskIssueType}
storyPointsFieldId={spField} labels={labels} assigneeAccountId={assignee}

Buckets from --diff:
  story {id}: {create|update KEY|unchanged KEY}
  subtask {id}.1: {create|update KEY|unchanged KEY}
  ...
Key map for Blocked by resolution: {json of storyId -> KEY}

Rules: contentFormat "adf" always; description is the ADF object;
parent.key for the epic; top-level parent for subtasks; 2-8 s jitter
between writes; honour Retry-After; read back and check parity; never
create a card that has a key above. Return only your return block.
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
Run checks P1-P3, C1-C6, F1-F5. Return only your return block.
```
