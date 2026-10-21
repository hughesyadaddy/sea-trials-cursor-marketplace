---
name: st-code-via-subscriptions
description: >-
  Use when an agent needs coding work done (a change, refactor, fix, or code
  review) and can hand it to Claude Code or OpenAI Codex signed in to the
  user's own subscriptions, before launching a paid Cursor cloud agent.
---
# Coding work through Claude Code / Codex subscriptions

Use the official tools under the local user's own login. If command lookup
fails, try `export PATH="$HOME/.local/bin:$PATH"`. Never enable Fast/Ultrafast.

## 0. Preflight (every time)

```bash
node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" st-subscriptions-preflight -- --require any
# Direct form also works outside a git checkout:
node "$ST_PLUGIN_ROOT/scripts/hooks/st-subscriptions-preflight.mjs" --require any
# Raw checks, if needed (inspect locally; don't paste personal account fields):
claude auth status --text      # must show a claude.ai subscription login
codex login status             # must say "Logged in using ChatGPT"
# Only when the task authorizes push/PR:
gh auth status
```

Require the selected tool (`--require claude` or `--require codex`) before using
it; `any` only means at least one is ready. If a tool isn't signed in, stop that
lane and tell the parent the user needs to sign in. Never run `claude auth login`,
`claude setup-token` or `codex login` yourself, and never copy, print or move
credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`,
`CLAUDE_CODE_OAUTH_TOKEN`).

Agent shells may export `OPENAI_API_KEY`. Always run Codex with
`env -u OPENAI_API_KEY` so it can't fall back to API billing
(`~/.codex/config.toml` should also set `forced_login_method = "chatgpt"`;
the user manages this config). For Claude, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `apiKeyHelper` must be unset or it bills the API.
Run with `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN`. Never pass `--bare`.
Headless calls with no prompt on stdin need `< /dev/null`, or they wait for input.

## 1. Which tool (in order)

| Priority | Use |
| --- | --- |
| 1. Cursor host | This plugin's `claude-code` MCP server: its `Agent` tool for delegated coding, plus Read/Edit/Bash. Check `subscription_setup_status` if the setup stub is active. |
| 2. CLI fallback | `claude -p` for large refactors, ambiguous design and deep reading; `codex exec` / `codex exec review` for specified changes, tests and second opinions. |
| 3. Parallel independent work | `codex cloud exec` and/or Claude cloud sessions (`claude --cloud`), when authorized. |
| 4. Last resort | Cursor agent on `composer-2.5`, standard speed, Fast off, when subscriptions hit limits, a lock stays busy, sign-in is missing, or Cursor-specific tools are needed. |
| Secrets or production access only available locally | Local run only; never paste secrets into a cloud task prompt. |

Codex has no MCP server (removed upstream); Codex is CLI-only here.
`codex app-server` is experimental and is not MCP. Do not configure either as
an MCP server. Claude MCP is Cursor-only; Claude Code already provides its own tools.

If a run ends with a usage-limit message, don't retry in a loop; fall back
per the table. MCP calls and delegated Agents count toward the local Claude
limit too. Hold a Claude slot for the entire coding hand-off, including its
delegated work; do not launch more than two concurrent local headless streams.

### Using the `claude-code` MCP server

In Cursor, tools are named `mcp__...claude-code...`. Use `Agent` with a
self-contained brief: goal, files, acceptance criteria, tests, and "commit
locally, do not push". The server runs in the Cursor workspace directory,
so open a dedicated worktree for the task. Cursor's tool approvals apply.
Hold a Claude slot while the hand-off runs.

## 2. Concurrency (hard limits)

- **Codex local: 1 job stream at a time machine-wide.** One
  `~/.codex/auth.json` = one serialized stream. Don't copy auth.json to other
  CODEX_HOMEs or machines. For parallelism use `codex cloud exec`.
- **Claude local: at most 2 headless runs at a time.** For more, use Claude
  cloud sessions (`claude --cloud`), each its own session. Keep total cloud
  fan-out to about 4 live, since it all draws on the same 5-hour and weekly limits.

On a shared multi-agent machine, every agent uses the same lock dir so the
limits above hold machine-wide. On another machine: install claude and codex,
sign in with your own subscription, keep the same concurrency rules.

Choose the lock for your lane and keep the file descriptor open until it finishes:

```bash
LOCK_DIR=${ST_LOCK_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/sea-trials/locks}
mkdir -p "$LOCK_DIR"
# Codex: single slot
exec 8>"$LOCK_DIR/codex-local.lock"; flock -w 600 8 || { echo "codex busy"; exit 75; }
# Claude: two slots (run this instead of the Codex lock for Claude work)
CLAUDE_SLOT=
for s in 1 2; do
  exec 9>"$LOCK_DIR/claude-local-$s.lock"
  if flock -n 9; then CLAUDE_SLOT=$s; break; fi
done
[ -n "$CLAUDE_SLOT" ] || { echo "claude slots busy"; exit 75; }
```

These examples require `flock` and GNU `timeout`; install compatible tools on
machines without them. Never silently skip locks or timeout bounds.

## 3. Workspace: one worktree per task

```bash
REPO=owner/name
SUBS_ROOT=${ST_CODE_SUBS_ROOT:-$HOME/.cache/sea-trials/code-subs}
BASE_DIR="$SUBS_ROOT/$(basename "$REPO")"
TASK=$(date +%Y%m%d-%H%M)-short-slug
BR=agent/$TASK
WT="$SUBS_ROOT/wt/$TASK"
mkdir -p "$SUBS_ROOT/wt"
[ -d "$BASE_DIR/.git" ] || gh repo clone "$REPO" "$BASE_DIR"
git -C "$BASE_DIR" fetch origin --prune
DEFAULT=$(git -C "$BASE_DIR" remote show origin | sed -n 's/.*HEAD branch: //p')
BASE_REF=${BASE_REF:-origin/$DEFAULT}
git -C "$BASE_DIR" worktree add -b "$BR" "$WT" "$BASE_REF"
cd "$WT"
LOG="$SUBS_ROOT/logs/$TASK"; mkdir -p "$LOG"
```

Write the brief to `$WT/../$TASK.prompt.md` (outside the repo): goal,
files/areas, acceptance criteria, test/lint commands, and "do not push, do not
open PRs, do not touch secrets, commit locally with clear messages". The
calling agent handles any separately authorized push and PR.

## 4. Run Codex (local, headless)

```bash
env -u OPENAI_API_KEY timeout --kill-after=60 90m \
  codex exec --cd "$WT" --sandbox workspace-write \
    -c sandbox_workspace_write.network_access=true \
    --disable fast_mode --disable ultrafast_mode \
    --json -o "$LOG/codex-last.md" \
    - < "$WT/../$TASK.prompt.md" > "$LOG/codex-events.jsonl" 2> "$LOG/codex-stderr.log"
echo "exit=$?"     # 124 = timed out
```

- No `--max-turns` in Codex; bound it with `timeout` and a tight brief.
  No Fast tiers (`-c service_tier=fast`).
- Never `--dangerously-bypass-approvals-and-sandbox` on a shared machine.
- Resume: `codex exec resume --last "follow-up"` in the same worktree while holding the lock.

### Codex cloud (parallel)

Needs a Codex cloud environment for the repo, created once by the user in
ChatGPT's Codex settings. Only if pushing is authorized:

```bash
git push -u origin "$BR"
env -u OPENAI_API_KEY codex cloud exec --env "$CODEX_ENV_ID" --branch "$BR" "$(cat "$WT/../$TASK.prompt.md")"
codex cloud list; codex cloud status <TASK_ID>; codex cloud diff <TASK_ID>; codex cloud apply <TASK_ID>
```

Keep `--attempts 1`.

## 5. Run Claude Code (local, headless)

```bash
cd "$WT"
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN timeout --kill-after=60 90m \
  claude -p --output-format json --max-turns 60 \
    --permission-mode acceptEdits --permission-prompts none \
    --allowedTools "Read Edit Write Glob Grep Bash(git status:*) Bash(git diff:*) Bash(git add:*) Bash(git commit:*) Bash(git log:*)" \
    --disallowedTools "Bash(git push:*) Bash(gh *) Bash(curl *) Bash(rm -rf *)" \
    --settings '{"fastMode": false}' \
    < "$WT/../$TASK.prompt.md" > "$LOG/claude-result.json" 2> "$LOG/claude-stderr.log"
jq -r '.result, .is_error, .num_turns, .session_id' "$LOG/claude-result.json"
```

- Add the repo's real build/test commands to `--allowedTools` (e.g.
  `Bash(flutter test:*)`, `Bash(npm test:*)`). Anything else is auto-denied.
- No `--dangerously-skip-permissions` / `bypassPermissions` on a shared machine.
  Follow-ups: `claude -p --resume <session_id> "..."`.

### Claude cloud sessions (parallel)

Needs GitHub access for the repo on claude.ai/code. Only if pushing is
authorized, run under a TTY wrapper in agent shells:

```bash
git push -u origin "$BR"
cd "$WT" && script -qfc "claude --cloud \"$(cat ../$TASK.prompt.md)\"" /dev/null
claude -p --cloud <SESSION_ID> --output-format json "follow-up"
claude --teleport <SESSION_ID>
```

The first command prints a session URL/id. Verify this path on first use.

## 6. Verify and commit (calling agent)

```bash
cd "$WT"
git status --short; git log --oneline "$BASE_REF"..HEAD; git diff --stat "$BASE_REF"...HEAD
# run tests/lint yourself; don't trust the tool's claim
git add -A && git commit -m "..."
```

Only when the task explicitly authorizes a push and draft PR:

```bash
git push -u origin "$BR"
gh pr create --repo "$REPO" --draft --base "$DEFAULT" --head "$BR" --title "..." --body "Automated change via codex|claude (subscription). Task: ... Tests run: ..."
git -C "$BASE_DIR" worktree remove "$WT"
```

Remove the worktree only after the PR is open or the task is dropped.
Never push to the default branch, force-push shared branches, mark ready, or merge.

## 7. Do NOT

- Turn on Fast/Ultrafast (Codex `/fast`, `service_tier=fast`; Claude
  `/fast`, `fastMode: true`). They burn limits or bill paid credits.
- Run two local Codex jobs at once, or more than 2 local Claude runs;
  build unattended fan-out loops on the subscription.
- Use the subscription logins in third-party tools (OpenCode with Anthropic
  login, LiteLLM, proxies, custom SDK apps). Max OAuth is for official Claude
  Code only; ChatGPT auth for official Codex (and apps OpenAI lists as supported).
- Sign in, create accounts, add API keys, buy credits or enable extra usage.
  The user does that.
- Print, log, commit or paste credentials, or put secrets in cloud prompts.
- Fall back to `--bare` or an API key to get unblocked. Fall back to Cursor
  on `composer-2.5` at standard speed instead.
- Work in a checkout another agent uses, or outside
  `${ST_CODE_SUBS_ROOT:-$HOME/.cache/sea-trials/code-subs}/wt/<task>`.

## 8. Report back

Tool and lane (MCP/local/cloud), branch, PR URL if opened, exit code,
turns/time, tests you ran with results, log dir. If stopped on a lock, limit
or missing sign-in, say which.
