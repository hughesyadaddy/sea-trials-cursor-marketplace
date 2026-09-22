# Scheduled test review

Run the QA pass every night without a person at the keyboard. Two
pieces: the **sweep** picks the cards, the **host** runs the skill on
each one.

```bash
SPRINT="$(_st_plugin_root)/scripts/sprint"        # contract section 11
node "$SPRINT/jira-test-review-sweep.mjs" --project <KEY> --tasks
bash "$SPRINT/nightly-test-review.sh"             # sweep + workers
```

## Rules that apply on every host

| Rule | Value | Why |
| --- | --- | --- |
| Already reviewed on this head | skip when any comment (tester's, when `--tester` is set) contains a 7-40 hex prefix of the PR head SHA | one verdict per commit; a re-push gets a fresh review |
| Cap per run | `--max 10` (`ST_SWEEP_MAX`) | a board never receives more than ten QA comments a night |
| Window | `--since 24h` (`ST_SWEEP_SINCE`) | only cards that moved since the last run |
| Human cadence | launches 3-9 minutes apart (`ST_SWEEP_STAGGER_MIN/MAX`, seconds) | ten verdicts in one minute read as a bot |
| Concurrency | 2 workers (`ST_SWEEP_CONCURRENCY`); the skill itself caps test workers at 3 | one simulator, one device |
| Statuses | `--status "In Review,Ready for QA"` (`JIRA_REVIEW_STATUS`) | status names are per site; never hardcode |
| Voice | every comment follows `qa-comment-voice.md` and names the short SHA once | that SHA is the idempotence marker |
| Headless | workers never ask questions; `NEEDS DISCUSSION` comments without transitioning | nobody is there to answer |

Jira REST is only used by the sweep (read-only search, remote links,
comments). Writes still go through the skill's normal path (Atlassian
MCP inside the worker).

## Env file `~/.config/sea-trials/jira.env`

```bash
JIRA_SITE=https://<site>.atlassian.net
JIRA_EMAIL=<you>@<domain>
JIRA_API_TOKEN=<token>            # id.atlassian.com → API tokens
JIRA_PROJECT_KEY=<KEY>
JIRA_REVIEW_STATUS="In Review,Ready for QA"
JIRA_TESTER_ACCOUNT_ID=<accountId>  # your own; only your comments count
ST_SWEEP_REPO=<owner>/<repo>      # for gh pr list/view
ST_SWEEP_REPO_ROOT=/path/to/checkout
ST_SWEEP_HOST=claude              # claude | cursor-cli | cursor
```

`chmod 600` the file. `nightly-test-review.sh` sources it when present
(`ST_JIRA_ENV_FILE` overrides the path). `gh auth status` must already
pass for the user running the job.

## Claude Code (launchd / cron)

Claude Code has no scheduler; the OS runs the wrapper, the wrapper runs
one `claude -p` per card:

```bash
claude -p "<task prompt>" --permission-mode acceptEdits [--model <alias>]
```

Flags verified against `claude --help` (2026-09): `-p, --print`,
`--permission-mode` accepts `acceptEdits | auto | bypassPermissions |
manual | dontAsk | plan`. `acceptEdits` lets the worker create the
worktree and write `/tmp/qa/<KEY>/*`; MCP writes to Jira still follow
the user's saved MCP permissions, so allow the Atlassian MCP once in an
interactive session first.

Crontab (weeknights 02:10, logs in the sweeps dir):

```cron
10 2 * * 1-5 /bin/bash "$HOME/.cursor/plugins/<...>/sea-trials/scripts/sprint/nightly-test-review.sh" >> "$HOME/.cache/sea-trials/sweeps/cron.log" 2>&1
```

Resolve `<...>` once with `node <plugin>/scripts/resolve-plugin-root.mjs`
or set `ST_PLUGIN_ROOT` in the env file and call
`"$ST_PLUGIN_ROOT/scripts/sprint/nightly-test-review.sh"`.

launchd (`~/Library/LaunchAgents/com.sea-trials.nightly-test-review.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sea-trials.nightly-test-review</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/ABS/PATH/sea-trials/scripts/sprint/nightly-test-review.sh</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>10</integer>
  </dict>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/YOU/.local/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/YOU/.cache/sea-trials/sweeps/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/.cache/sea-trials/sweeps/launchd.log</string>
</dict></plist>
```

`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sea-trials.nightly-test-review.plist`
to load, `launchctl kickstart -k gui/$(id -u)/com.sea-trials.nightly-test-review`
to run now. launchd uses `/bin/bash` 3.2 and a bare `PATH`; the wrapper
is written for that shell and the plist sets the PATH so `node`,
`claude`, and `gh` resolve.

Dry run before scheduling:

```bash
ST_SWEEP_DRY_RUN=1 ST_SWEEP_STAGGER_MIN=1 ST_SWEEP_STAGGER_MAX=1 \
  bash "$SPRINT/nightly-test-review.sh"
```

## Cursor

### Local Cursor CLI

`ST_SWEEP_HOST=cursor-cli` makes the wrapper run
`agent -p "<prompt>" --force --approve-mcps --workspace <repo root>`
per card (flags from `agent --help`, 2026-09). Same cron/launchd recipe.

### Cursor Automation (cloud, scheduled)

Open the Agents Window, run the `automate` skill, and hand it this
draft. The automation is the scheduler and the worker in one; it uses
the Atlassian MCP directly, so no REST credentials leave your machine.
`mcp.server.name` must be the `serverName` from the matching
`~/.cursor/mcps/<folder>/SERVER_METADATA.json` (the Atlassian server
shipped by the sea-trials plugin), and the MCP must be authenticated
before the editor opens.

```yaml
name: "Nightly Jira test review"
description: "Weeknights: test each card waiting for review on its PR head and leave one QA comment per card."
workflow:
  triggers:
    - cron: { cron: "10 2 * * 1-5" }
  actions:
    - mcp: { server: { name: "<Atlassian serverName>" } }
  prompts:
    - |
      Run the Sea Trials skill /st-jira-test-review as a nightly sweep.
      Project key <KEY>; review statuses "In Review" and "Ready for QA";
      tester account id <accountId>.
      1. searchJiraIssuesUsingJql: project = <KEY> AND status in
         ("In Review", "Ready for QA") AND updated >= -24h ORDER BY
         updated ASC, fields summary,status,assignee,updated,description,
         comment. Page with nextPageToken.
      2. For each card resolve the PR with gh (links on the card first,
         then gh pr list --search "<KEY-n> in:title,head") and read the
         head SHA. Skip the card when a comment by the tester already
         contains a 7+ character prefix of that SHA.
      3. Keep at most 10 cards. Run the skill on each one (max 3 test
         workers at a time, isolated worktrees, never the checkout).
      4. Post comments per the skill's voice reference, naming the short
         SHA once. Wait a random 3-9 minutes between comments.
      5. Never ask questions; NEEDS DISCUSSION comments without a
         transition. End with the skill's summary table.
  model: ""
  gitConfig:
    repo: "<owner>/<repo>"
    branch: "dev"
  agentOptions:
    skipInstall: false
  memoryEnabled: true
```

The `automate` skill shows this as a plain-language draft table and
opens the Automations editor; it never pastes the YAML. Unverified as
of writing: the exact `prompts` list shape in the editor prefill and
whether the cloud runner has a device or simulator for UI-step AC
(expect command and code-read AC only; document that in the run's
summary when it happens).

### Hand-off file (`ST_SWEEP_HOST=cursor`)

The wrapper only writes `~/.cache/sea-trials/sweeps/<date>.jsonl`. In
a Cursor chat: "launch one `Task` per line of that file, fields per
`st-build-with-subagents/references/dual-host-dispatch.md`, 3-9 minutes
apart". Same lines feed Claude Code `Agent` calls (`claudeAgent`,
`claudeModel`).

## Logs

```text
~/.cache/sea-trials/sweeps/<date>.jsonl        task lines
~/.cache/sea-trials/sweeps/<date>.sweep.log    JQL + candidate summary
~/.cache/sea-trials/sweeps/<date>.<KEY>.log    one per worker
```

Each worker ends with one JSON line
`{"key","verdict","commented","transitionedTo"}`; grep the logs for
`"commented":false` in the morning.
