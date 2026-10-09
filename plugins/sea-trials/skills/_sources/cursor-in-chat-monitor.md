# Cursor in-chat PR monitor (mandatory)

When the user runs `/st-pr-review-loop-inplace`, `/st-pr-review-loop-worktree`,
or `/st-pr-review-monitor` in **Cursor Agent chat**, the watch **must** run in
**this chat's background terminal**. A detached `setsid` daemon or a shell
outside the agent session **does not** wake the chat when Codex posts reviews.

Claude Code may still use `pr-review-daemonctl.sh start --daemon` when no
Shell/Await tools exist.

## Hard rules (Cursor)

1. **Never** start `pr-review-daemonctl.sh start --pr … --daemon` as the only
   watcher in Agent chat.
2. If `status` shows a detached daemon for this PR, **stop it first** so the
   in-chat foreground process can hold the PID lock:

   ```bash
   bash "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemonctl.sh" stop --pr <n>" || true
   ```

3. Start the monitor with the **Shell** tool:
   - `block_until_ms: 0` (background terminal **in this chat**)
   - `notify_on_output`: `{ "pattern": ">>> ACTION:", "reason": "PR review wake" }`
   - `working_directory`: `$ACTIVE_ROOT`
   - Save the returned **terminal task id** — required for `Await`.

4. **Parent stays in this chat** — loop until merge-ready or user stop:

   ```text
   repeat forever:
     Await(task_id, pattern: ">>> ACTION:", block_until_ms: 600000)  # 10m chunks (Cursor cap ~119m)
     on match → fix (review-loop Steps 2–6 or CI path) → touch handoff.ack → repeat
     on no match → still running; repeat Await (do NOT end the turn)
   ```

5. Also `Await` on `>>> DONE:` if the daemon prints it (optional exit).

6. **Do not** tell the user to open an external terminal or "check back later".

## Daemon command (foreground, in-chat)

Webhook on by default (instant CI + review events via `gh webhook forward`).
Use `--no-webhook` only offline; then add `--interval 180` (3-minute polls).

```bash
ST_REPO_ROOT="$ACTIVE_ROOT" \
  node "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs" \
  --pr <n> \
  --duration 24h \
  --silence 60 \
  --bots codex,bugbot,coderabbit,copilot
```

| Flag | Purpose |
| --- | --- |
| `--silence 60` | Up to **60 minutes** waiting for bot activity after a push (Codex included) |
| `--webhook` (default) | Wake on GitHub review/check/comment events — install `gh extension install cli/gh-webhook` |
| `--no-webhook --interval 180` | Poll every **3 minutes** when webhook unavailable |
| `--duration 24h` | Upper bound; parent may stop earlier when DONE + 60m Codex-quiet |

## Codex / CI priority

| Sentinel | Parent action |
| --- | --- |
| `>>> ACTION: ci-fail` | Fix immediately — **do not** wait for Codex |
| `>>> ACTION: threads` | Full review loop (triage → fix → gate → push → reply) |
| `>>> WAIT:` | Keep `Await` — bots still working |
| `>>> GREEN:` | Round complete — **keep watching** (do not stop monitor) |

After every fix push: `touch …/pr-<n>-handoff.ack` — do **not** restart the daemon.

## Stop conditions

Keep the in-chat monitor running until **all** hold:

1. `node "$ST_REVIEW_STATUS" -- --pr <n>` → exit `0` (0 bot threads, CI green, settled `DONE`).
2. **60 minutes** with no new Codex review activity on the current HEAD since the
   last push (daemon `--silence 60` + settled machine; confirm with status JSON).
3. Or user says stop / PR merged.

## Session reconnect

If the chat session ends but the background terminal died:

1. Read `docs/code-review/<scope>/pr-<n>-acting.signal` — if `CI_FAIL` or
   `THREADS`, act immediately.
2. Re-run the foreground daemon in a new Shell (`block_until_ms: 0`) and
   resume the `Await` loop.

## References

- [Cursor Agent overview](https://cursor.com/docs/agent/overview) — terminal + follow-ups in chat
- [Cursor CLI changelog](https://cursor.com/docs/cli/changelog) — background tasks + completion notifications
- Shared monitor: `review-loop-monitor.md`
- Fix pipeline: `review-loop-body.md`
