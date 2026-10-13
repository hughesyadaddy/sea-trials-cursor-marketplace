# Always-on, event-driven PR loops (Cursor)

Recommended: **GitHub Actions dispatcher → Cursor Automation (webhook
trigger) → cloud agent running one `st-pr-review-loop-worktree` round.**
Merging is done by the dispatcher itself via `st-pr-merge/merge-gate.mjs`
(deterministic, no LLM, never `--admin`).

```text
 GitHub events ─────────────┐   pull_request_review(submitted) · review_comment
 (Codex review, CI done,    │   workflow_run(PR Checks, completed) · check_suite
  push, label, 15-min cron) │   synchronize · labeled · schedule */15
                            ▼
              st-pr-dispatch.yml  (concurrency group st-pr-<n>, queue not cancel)
                            │  merge-gate.mjs --dry-run --json
          ┌─────────────────┼──────────────────────┐
     exit 0 + st:automerge  exit 2/3/4/5            exit 8 / 0 w/o label
          │                 │                        │
   merge-gate.mjs (merge,   POST Cursor Automation   no-op (next event
   --match-head-commit)     webhook {pr, head, why}  or sweep re-checks)
                            ▼
              Cursor Automation "st-pr-review-round"
              (cloud agent, repo = sea_trials_universal, plugin installed)
                            │  /st-pr-review-loop-worktree <pr>  — Event-round mode
                            ▼
              Steps 0–6 once → push via pr-review-push → reply/resolve → exit
                            │
                            └──► the push / new Codex review fires the next event
```

## Why this over the alternatives

| Option | Instant? | Serialised per PR? | Time limits | Cost when idle | Verdict |
| --- | --- | --- | --- | --- | --- |
| In-chat daemon + `Await` (today) | ~yes (webhook forward) | PID lock per checkout only | Chat/turn limits, Mac sleep, `Await` caps; transcripts show interruptions and "check back later" stalls | Holds an agent open for hours | Keep for interactive use only |
| Long-poll loop in a cloud agent | 3-min poll | no | Agent run limits; one dead VM = dead loop | Full agent time | Reject |
| Cursor Automations, native GitHub triggers only ("PR review submitted", "CI completed", "Review thread updated") | yes | **not documented** — "CI completed" fires per check, so one push can spawn dozens of agents racing on one branch | Fine (one round per run) | Agent per event, even no-op | Good, but needs a debounce in front |
| **Actions dispatcher → Automation webhook** (recommended) | yes (seconds) | yes (`concurrency`) | Each round is short; sweep retries failures | Actions minutes only; agent spawned only when the gate says there is work | **Recommend** |
| Actions → Cloud Agents API (`POST /v1/agents`, follow-ups via `/v1/agents/{id}/runs`) | yes | yes | same | same | Equivalent; use if you want per-PR conversation continuity (store agent id) — needs a user/service API key in Actions |
| Custom GitHub App | yes | you build it | you host it | hosting | Overkill; Actions already is a GitHub-hosted app runtime |

## Setup (when approved)

1. Merge the plugin PR and refresh the Team Marketplace.
2. Create Automation **st-pr-review-round** (cursor.com/automations):
   trigger = Webhook; repo = `hughesyadaddy/sea_trials_universal`;
   Run as = service account (team pool, not personal); tools = PR comment.
   Prompt:
   > A PR needs a review round. Payload: `{repo, pr, head, exit, reason}`.
   > Run `/st-pr-review-loop-worktree` for `pr` in **Event-round mode**:
   > Steps 0–6 once for the current head (exit 2 → threads, 3 → CI fix or
   > flake routing, 4 → migration renumber, 5 → merge base in). Push only
   > via pr-review-push. Never merge, never `--admin`, never force-push.
   > If `head` differs from the live PR head, re-read state first. Finish
   > with the state file written.
3. Add repo secrets `CURSOR_ST_ROUND_WEBHOOK_URL` and `CURSOR_ST_ROUND_WEBHOOK_KEY`
   (shown once when the Automation is saved). The marketplace repo is public,
   so no read token is needed.
4. Copy `st-pr-dispatch.yml` into `.github/workflows/`.
5. Opt a PR into auto-merge with the `st:automerge` label.

Retries: a failed/timed-out agent round leaves the gate red, so the next
event or the 15-minute sweep fires it again — "retried until it succeeds"
without a human. Add a cap (e.g. 6 rounds/head) in the Automation memory
to stop runaway loops and page Alex instead.
