# Jira connection

Two ways to reach Jira. Neither needs a config file.

1. **Atlassian MCP (default).** The plugin declares the official Atlassian remote MCP server as `atlassian` at `https://mcp.atlassian.com/v2/mcp` (Streamable HTTP) in both the Claude Code and the Cursor manifest. The first call opens a browser sign-in (OAuth 2.1). The agent reads and writes through its tools.
2. **User key (override).** An Atlassian API token for the signed-in person. When it is present, the CLI talks to the Jira REST API directly and has every feature. It is never printed, logged or written into the sprint folder.

## Find the site, project, board and sprint (run time)

Ask only for what cannot be found. Save every answer with `node <CLI> connect <sprint-folder> --site ... --cloud-id ... --project-key ... --board ... --sprint-id ... --sprint-name ...`.

| Value | With MCP | With the user key |
| --- | --- | --- |
| Site and cloud id | `getAccessibleAtlassianResources`. One site: use it. More than one: ask which. | `JIRA_SITE`, the creds file, or `--site`. |
| Project key | `getVisibleJiraProjects` on that cloud id, then ask the user to pick. | `node <CLI> discover` |
| Board | Not listed by MCP. Ask for the board URL (`.../boards/<id>`), or skip: only rank and sprint moves use it. | `node <CLI> discover --project-key KEY` |
| Sprint id and name | `searchJiraIssuesUsingJql` with `project = KEY AND sprint in openSprints()` and the Sprint field: each issue's sprint value holds the id and name. For a future sprint, ask for its name and id from the board. | `node <CLI> discover --project-key KEY --board N` |

## The user key

Looked up in this order. The first one found wins.

1. `JIRA_EMAIL` and `JIRA_API_TOKEN` (or `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN`) in the environment, with `JIRA_SITE`.
2. The OS keychain, service `sprint-cards-jira`. Save with `node <CLI> auth login --email you@example.com`; the keychain asks for the token, so it never passes through the agent or the shell history. macOS uses `security`, Linux uses `secret-tool`. `auth logout` removes it.
3. A creds file: `$JIRA_CREDS_FILE` or `~/.jira-creds`, as `KEY=VALUE` lines (`JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_SITE`) or the same keys as JSON. Keep it `chmod 600`.

`node <CLI> auth status` prints which source is used, the masked email and the site, never the token. The site also comes from `--site` or the `jira.site` value in `compare/index.json`.

Create a token at https://id.atlassian.com/manage-profile/security/api-tokens. The agent never asks the user to paste a token into the chat.

## What each path can do

| Action | User key (`push --apply`) | MCP (`push --mcp-plan`, the agent runs the steps) |
| --- | --- | --- |
| Create epic, story, subtask with parent | yes, parents first, search before create | yes, `createJiraIssue`, one parent level per run, search before create |
| Update summary, description, labels, points | yes, live read first, Done skipped, backup | yes, `editJiraIssue`, after `getJiraIssue` shows it is not Done and not changed since the pull |
| Story points field | found by name | only when `field_ids` is known (pull once with the key, or `connect`), else set by hand |
| Status | yes, transition by target name | yes, `getTransitionsForJiraIssue` then `transitionJiraIssue` |
| Attach images | yes, sha256 dedupe, name and size check | no: attach in the Jira UI, then resync |
| Rank (order under a parent) | yes, Agile API | no: drag on the board |
| Sprint move | yes, Agile API, 50 at a time | only by setting the Sprint field when its id is known; else drag on the board |
| Resync from Jira | `pull` (GET only), images downloaded | `getJiraIssue` per key (or `searchJiraIssuesUsingJql`), save the JSON list, then `import-jira`; no images |
| Discover projects, boards, sprints | `discover` | projects yes; boards and sprints as in the table above |

Why the CLI does not run its own OAuth sign-in: Atlassian's 3LO flow needs an app registered in the developer console with a client secret, which a plugin cannot ship. The MCP server already holds the user's OAuth grant, so the no-key path uses the MCP tools and the key path uses REST.

## Running an MCP plan safely

`node <CLI> push <sprint-folder> --mcp-plan /tmp/plan.json` writes ordered steps. For each step:

1. `create`: run its `precheck` search first. When an issue with exactly the same summary exists, do not create; record that key. Else call the tool with `arguments`, then run `node <CLI> record <sprint-folder> <local_id> --key <KEY> --id <ID>` at once, before the next step.
2. `update`: run the `before` check (`getJiraIssue`): skip when its status category is Done, stop when its `updated` time is newer than the plan says.
3. Steps with `needs: user-key` are not run. Tell the user what to do by hand (`instead`).
4. When the plan says `deferred_creates`, run `push --mcp-plan` again after recording: the children of the new parents come next.
5. Finish with a resync (`import-jira`) and `node <CLI> push <sprint-folder>` (dry run). It shows 0 operations when Jira matches the plan.

Known limits of the MCP path: each create is a separate call, so a session that stops mid-plan leaves some cards created; the `record` step after each create and the precheck search on the next run keep this from making duplicates. The MCP server checks the user's own Jira permissions on each call.

## The viewer's own scripts

The `sprint-plan-viewer/` submodule may ship its own push and resync commands. When it does, its README is the guide for them, and the same rules hold: dry run first, the user approves, Done cards are skipped, search before create, no secrets printed. This plugin's CLI stays the way to make MCP plans (`push --mcp-plan`, `record`, `import-jira`) and the fallback for folders without the viewer.

## Several Jira sites

One `atlassian` server and one OAuth grant are used for every project. When the person works on more than one Atlassian site, `getAccessibleAtlassianResources` lists every site the grant covers; pick by the `site` in `compare/index.json`. When a site is missing from the list, sign in again and approve that site, or use the user key for that site.

## Safety

- Never write to Jira from `pull`, `import-jira`, `discover` or a dry run. `JIRA_READ_ONLY=1` makes every REST write fail before it leaves the machine.
- `push` is a dry run unless `--apply` is given. Show the dry run to the user and get a yes before `--apply` or before running MCP write steps.
- Never delete issues. Never edit a card that is Done in Jira.
