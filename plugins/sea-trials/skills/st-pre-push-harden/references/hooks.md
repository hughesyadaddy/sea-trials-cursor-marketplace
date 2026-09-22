# Push-gate hooks (tool-level enforcement)

The rules in `.cursor/rules/*.mdc` say "never bare `git push`". These
hooks make the tool refuse. One Node implementation,
`hooks/scripts/guard-git-push.mjs`, serves both hosts; it reads the
hook JSON on stdin, inspects every `git push` in the command, and
answers in the host's own protocol. No `jq`, no bash on the hot path,
so it behaves the same on Windows.

## Hooks per host

| Host | Event | Command (cwd = plugin root) | Purpose |
| --- | --- | --- | --- |
| Cursor | `beforeShellExecution` (matcher `git[\s\S]*push`, `failClosed: true`, 10 s) | `node ./hooks/scripts/guard-git-push.mjs` | Deny bypass flags and bare pushes in gated repos |
| Cursor | `sessionStart` (10 s) | `node ./hooks/scripts/session-start.mjs` | Warm `scripts/hooks/st-model-probe.mjs --quiet` (detached, silent) |
| Claude | `PreToolUse` matcher `Bash` (10 s) | `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/guard-git-push.mjs"` | Same guard |
| Claude | `SessionStart` (10 s) | `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-start.mjs"` | Same probe warm-up |

Files: `hooks/cursor/hooks.json`, `hooks/claude/hooks.json`.
`hooks/scripts/deny-no-verify-push.sh` is a compatibility shim that
`exec`s the Node guard; new configs should reference the `.mjs` directly.

The guard only shells out to git when a bare push reaches a repo; flag
checks are pure string work. `pnpm pr-review-push` is never matched
(no `git` token), and the `git push` it runs from a Node child process
is invisible to agent-shell hooks, which is why it is the only path.

## What is blocked

The command is split on `&&`, `||`, `;`, `|`, newline; every segment is
checked after stripping `FOO=1` assignments and `command` / `exec` /
`env` / `nohup` / `time` wrappers. `git -C <dir>`, `/usr/bin/git`,
`git.exe`, `sh -c "..."` and `eval "..."` are all seen. Only flags after
the `push` token (and before `--`) count, so ref names are never
misread.

| Command shape | Decision | Exact message |
| --- | --- | --- |
| `git push --no-verify`, `git push -n`, `git push --dry-run`, bundled `-nf` | DENY, no override | `Sea Trials: never git push with --no-verify, -n, or --dry-run. Run: pnpm pr-review-push -- --pr <n>` |
| `git push --force`, `-f`, `--force-with-lease[=…]` | DENY unless `ST_ALLOW_FORCE_PUSH=1` | `Sea Trials: force push is blocked (--force, -f, --force-with-lease). Run: pnpm pr-review-push -- --pr <n>. ST_ALLOW_FORCE_PUSH=1 only for an explicitly approved rewrite.` |
| Bare `git push …` in a **gated** repo, no fresh gate-pass token | DENY unless `ST_ALLOW_BARE_PUSH=1` | `Sea Trials: bare git push is blocked here. Run: pnpm pr-review-push -- --pr <n> (<reason>)` where reason is `no gate token`, `gate token is for a different HEAD`, `working tree changed since the gate ran`, `gate token is stale`, or `gate token lacks phase prepush` |
| Bare `git push …` in a gated repo **with** a fresh token | ALLOW (stderr note `gate already passed for this HEAD`) | — |
| `git push …` in a repo **without** the gate (e.g. this marketplace) | ALLOW | — |
| `git push …` outside any git repo | ALLOW (the push fails on its own) | — |
| Anything that is not `git push` | ALLOW | — |

When several pushes are chained, the strictest decision wins:
no-verify beats force beats bare-push.

**Gated repo** = root contains `.husky/st-plugin-run.sh` **or** its
`package.json` has a `pr-review-push` script. The repo root comes from
`git -C <cwd> rev-parse --show-toplevel`, where `<cwd>` is the hook
input's `cwd` plus any `git -C` segments in the command.

**Fresh token** = `.git/st-push-gate-pass.json` written by
`pr-review-push` (also with `--check-only`) whose `headOid` matches
`HEAD`, whose tree fingerprint matches the working tree, whose `phases`
include `prepush`, and which is younger than 20 minutes
(`scripts/hooks/lib/gate-pass-token.mjs`). The guard deliberately skips
the `ST_REVIEW_PUSH` env check that the husky pre-push hook applies:
that variable only exists inside the `pr-review-push` child process.
The husky hook still re-runs the full gate for such a push.

## Host protocols (as implemented)

| | Cursor `beforeShellExecution` | Claude `PreToolUse` |
| --- | --- | --- |
| Input | `{"command": "...", "cwd": "...", ...}` | `{"tool_name":"Bash","tool_input":{"command":"..."},"cwd":"...", ...}` |
| Host detection | `command` at top level, no `tool_input` | `tool_input` / `tool_name` present, or `hook_event_name: "PreToolUse"`, or `CLAUDE_PLUGIN_ROOT` set |
| Allow | stdout `{"permission":"allow"}`, exit 0 | no output, exit 0 (never auto-approves) |
| Deny | stdout `{"permission":"deny","user_message":"…","agent_message":"…"}`, exit 0 | stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`, reason on stderr, exit 2 |

Claude does **not** honour Cursor's `{"permission":"deny"}`; it blocks
on exit 2 (stderr fed back to the model) or on `hookSpecificOutput`.
The guard emits both. Cursor blocks on the `permission` field; exit 2
would also block but is not needed.

## Failure behaviour

- Parser or git errors: fail **open** (allow) with a
  `Sea Trials push guard …` note on stderr, except that a raw-text scan
  still denies `--no-verify` / `-n` / `--dry-run` / `--force` / `-f`.
- Token check errors in a gated repo: treated as "no token" (deny).
- Cursor `failClosed: true`: if `node` is missing or the guard times
  out, the matched command is blocked rather than let through.

## Escape hatches

| Variable | Effect | Legitimate when |
| --- | --- | --- |
| `ST_ALLOW_BARE_PUSH=1` | Allows bare `git push` in gated repos; stderr warning | Repo bootstrap before `pr-review-push` exists; a branch with **no** open PR where you accept running the husky pre-push gate alone. **Never** in the consuming repo with an open PR. |
| `ST_ALLOW_FORCE_PUSH=1` | Skips the force-flag deny (the bare-push gate still applies) | An explicitly approved history rewrite on your own feature branch, after the user asked for it. Never on `dev`/`main`, never to bypass a red gate. |

Nothing disables the `--no-verify` / `-n` / `--dry-run` deny.

The hook process is spawned by the IDE, so an `export` in the agent's
shell never reaches it. The guard therefore also honours the variable
as a prefix on the push segment itself
(`ST_ALLOW_FORCE_PUSH=1 git push --force-with-lease`, or via `env`).
The prefix must sit on every `git push` in the command; one on another
segment (`ST_ALLOW_BARE_PUSH=1 true && git push`) does not count. This
keeps the override visible in the exact command the user approves. The
deny messages deliberately do not mention `ST_ALLOW_BARE_PUSH`.

## Testing a hook locally

From the plugin root:

```bash
# Cursor shape — allow
echo '{"command":"git status"}' | node hooks/scripts/guard-git-push.mjs

# Cursor shape — deny (no-verify)
echo '{"command":"git push --no-verify"}' | node hooks/scripts/guard-git-push.mjs

# Cursor shape — bare push in the consuming repo (deny unless token is fresh)
echo '{"command":"git push","cwd":"/path/to/sea_trials_universal"}' \
  | node hooks/scripts/guard-git-push.mjs

# Claude shape — deny exits 2 and prints hookSpecificOutput
echo '{"tool_name":"Bash","tool_input":{"command":"git push -f"}}' \
  | node hooks/scripts/guard-git-push.mjs; echo "exit=$?"

# Unit + end-to-end tests (tmp git repos with/without the gate marker)
node --test hooks/scripts/guard-git-push.test.mjs
```

In Cursor, confirm the hook fired in **Settings → Hooks** or the
**Hooks** output channel; in Claude Code, `claude plugin validate .`
checks the manifest and the deny reason appears in the transcript.
