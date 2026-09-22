# Posting comments and the Confluence page

Server: the Atlassian MCP (name contains `atlassian`). Read the live
schema of each tool before the first call in a session; the shapes
below were taken from the v1 schema on 2026-09 and field names drift.
Every write happens as the signed-in person.

## Discovery

| Need | Call |
| --- | --- |
| Cloud id | `getAccessibleAtlassianResources`, pick the `id` whose `url` equals `sprint.json.site`; the tools also accept the site URL as `cloudId` |
| Space id | `getConfluenceSpaces`, or pass the space key (`ENG`) as `spaceId`; the tool resolves it |
| Existing retro page | `searchConfluenceUsingCql` with `cql: title = "Sprint 12 retro" AND space = "ENG" AND type = page` |
| Parent page | `sprint.json.confluenceParentId`; ask once when absent and write it back |

## Story comment

```bash
node "$SPRINT/retro-metrics.mjs" --check-voice /tmp/retro/<KEY>.comment.md
node "$SPRINT/md-to-adf.mjs" /tmp/retro/<KEY>.comment.md \
  --out /tmp/retro/<KEY>.comment.adf.json
```

`addCommentToJiraIssue`:

```json
{
  "cloudId": "<cloudId>",
  "issueIdOrKey": "<KEY>",
  "contentFormat": "adf",
  "commentBody": "<contents of /tmp/retro/<KEY>.comment.adf.json>"
}
```

The schema types `commentBody` as a string; pass the ADF document
serialised as JSON text (`cat` the file into the field), not a nested
object, unless the live schema says object. `contentFormat: "markdown"`
is acceptable for a comment with no checkboxes, mentions, or links that
must survive; the retro comment carries a PR URL, so use ADF and let
`md-to-adf.mjs` turn the bare URL into a link mark. Never pass
`commentVisibility` unless the user asked for a restricted comment.

The response carries the comment `id`; record it with the timestamp in
`retro.md` under `## Posted`. To fix a typo later, call the same tool
with `commentId` set; never post a second comment for a correction.

Pace: 2-8 s random sleep between comments, at most 4 in flight per
site (contract 10.5).

## Confluence page

```bash
node "$SPRINT/retro-metrics.mjs" --check-voice /tmp/retro/page.md
```

Create when the title search returned nothing. `createConfluencePage`:

```json
{
  "cloudId": "<cloudId>",
  "spaceId": "<space id or key>",
  "title": "Sprint <n> retro",
  "parentId": "<confluenceParentId>",
  "contentFormat": "markdown",
  "body": "<contents of /tmp/retro/page.md>",
  "status": "current"
}
```

Update when it exists (`pageId` from the search hit). `updateConfluencePage`:

```json
{
  "cloudId": "<cloudId>",
  "pageId": "<pageId>",
  "title": "Sprint <n> retro",
  "contentFormat": "markdown",
  "body": "<contents of /tmp/retro/page.md>",
  "versionMessage": "Retro numbers refreshed <date>"
}
```

Notes from the schema:

- `contentFormat: "markdown"` skips the HTML guide; use it. The body
  is `##` headings, pipe tables, and links only, which the markdown
  path renders. Do not send `contentFormat: "html"` without first
  calling `getContentFormatGuide`, and do not hand-write storage XHTML.
- `updateConfluencePage` replaces the whole body; always send the full
  page, never a fragment.
- Omit `spaceId` on update unless the page is moving.
- `parentId` accepts a page or folder id. The parent must exist; the
  tool does not create it.

Read back with `getConfluencePage` (`pageId`) and confirm the five
metric H2s and the three debrief H2s are present and no table lost its
header row. Record the page id, version, and URL in `retro.md`.

## Failure handling

| Symptom | Action |
| --- | --- |
| 409 / version conflict on update | fetch the page again, re-send with the same body |
| 403 on create | wrong space or missing parent permission; ask the user for a parent id, do not fall back to a personal space |
| Markdown tables render as text | the space has markdown import disabled; re-send as ADF via `md-to-adf.mjs` with `contentFormat: "adf"` |
| Comment shows a raw URL | `contentFormat: "markdown"` was used; re-send the ADF body with `commentId` set, never a second comment |
