# REST and browser fallbacks

Order of preference for anything the Atlassian MCP v1 cannot do:

1. MCP v2 tools, if present in the schema (`uploadAttachmentToJiraIssue`,
   `manageJiraSprint`, `deleteJiraIssue`). Check with a schema search
   before assuming.
2. `scripts/sprint/jira-rest.mjs` with `JIRA_SITE`, `JIRA_EMAIL`,
   `JIRA_API_TOKEN` in the environment.
3. `st-jira-browser-operator` through the Chrome DevTools MCP.
4. Report the step as manual with the exact click path.

## REST (`jira-rest.mjs`)

```bash
export JIRA_SITE="https://<site>.atlassian.net"   # or --site <url>
# JIRA_EMAIL and JIRA_API_TOKEN must already be in the environment.

node "$SPRINT/jira-rest.mjs" fields --name "Story point"
node "$SPRINT/jira-rest.mjs" sprints <boardId> --state active,future
node "$SPRINT/jira-rest.mjs" move-to-sprint <sprintId> <KEY...>
node "$SPRINT/jira-rest.mjs" move-to-backlog <KEY...>
node "$SPRINT/jira-rest.mjs" rank <KEY...> --after <KEY> | --before <KEY>
node "$SPRINT/jira-rest.mjs" attach <KEY> <file...>
node "$SPRINT/jira-rest.mjs" set-description <KEY> <adf.json>
node "$SPRINT/jira-rest.mjs" delete-issue <KEY> [--with-subtasks] --yes
node "$SPRINT/jira-rest.mjs" delete-attachment <attachmentId> --yes
node "$SPRINT/jira-rest.mjs" delete-comment <KEY> <commentId> --yes
```

Destructive subcommands dry-run and exit 2 without `--yes`. Before
passing `--yes`, ask the user once with the structured question tool,
listing the exact keys. `429` honours `Retry-After`; `5xx` retries
three times. The token is never printed; never echo it into chat.

`set-description` is the REST twin of `editJiraIssue` for a card whose
ADF the MCP rejected; the body is the `md-to-adf.mjs --out` file.

## Missing credentials

If `JIRA_EMAIL` or `JIRA_API_TOKEN` is unset, do not ask the user to
paste a token into chat. Say which env vars are needed, where to
create a token (Atlassian account settings, API tokens), and continue
with the browser fallback or the manual report.

## Browser (`st-jira-browser-operator`)

Preconditions: the shared Chrome profile is running and signed in to
the Jira site. The parent confirms REST is unavailable and passes:

```text
You are st-jira-browser-operator.
site={site}
Actions:
  move-to-sprint "<sprint name>" <KEY> <KEY>
  attach <KEY> /abs/path/screenshot.png
  screenshot <KEY> /tmp/sprint/<KEY>.png
Deletes confirmed by user: none | <KEY> <KEY>
Return only your return block.
```

Flows are label-driven (paperclip quick-add for attach, "..." then
Delete then confirm for delete, Sprint field in the details panel for
sprint moves). The operator never types credentials; on a login page
it returns `LOGIN REQUIRED` and the parent asks the person to sign in
once, then relaunches the operator.

Rank in the UI is unreliable; accept `RANK UNSUPPORTED IN UI` and
leave rank for a later REST run.

## Manual report format

When every fallback is exhausted:

```text
MANUAL: move <KEY>, <KEY> into sprint "<name>"
  Board backlog → select the cards → drag into the sprint, or
  open each card → Sprint field → pick "<name>".
```
