# Adversarial: in-chat PR review monitor (Codex wake)

**Problem:** `/st-pr-review-loop-inplace` and `worktree` often started
`pr-review-daemonctl --daemon` or external shells. Cursor Agent chat never
saw `>>> ACTION:` when Codex posted reviews.

**Research (Cursor):**

| Mechanism | Wakes this chat? | Notes |
| --- | --- | --- |
| Detached `setsid` daemon | **No** | Survives session; stdout not tied to agent |
| Shell `block_until_ms: 0` in Agent | **Yes** | Background terminal owned by chat |
| Shell `notify_on_output` + `>>> ACTION:` | **Yes** | Host notifies agent on sentinel |
| `Await(task_id, pattern)` loop | **Yes** | Polls same background terminal (≤~119m/chunk) |
| `gh webhook forward` → daemon | **Immediate** | Default in `pr-review-daemon.mjs` |
| Poll `--interval 180` | **≤3 min** | Fallback when `--no-webhook` |

Refs: [Agent overview](https://cursor.com/docs/agent/overview),
[CLI changelog — background tasks](https://cursor.com/docs/cli/changelog),
[Cloud Agents API / Stream](https://cursor.com/docs/background-agent/api/overview)
(API is for cloud agents, not local Codex — local path is Shell+Await).

**Shipped fix (plugin docs + skills):**

1. New `_sources/cursor-in-chat-monitor.md` — mandatory Cursor protocol.
2. `review-loop-monitor.md` — Option B required; Option A demoted.
3. `st-pr-review-monitor`, `st-pr-review-loop-*` — read order + inline Phase.
4. `review-loop-body.md` Step 1 — forbid detached-only on Cursor.
5. Daemon flags in skills: `--silence 60`, default webhook, `--interval 180` offline.

**Remaining gaps:**

| Gap | Severity | Mitigation |
| --- | --- | --- |
| Agent ignores skill and runs daemonctl anyway | High | User re-run; future: hook rejects detached when `CURSOR_AGENT=1` if env exists |
| `Await` 119m cap | Medium | Document 10m chunked loop (done) |
| No native GitHub → Cursor push besides webhook | Low | Document `gh webhook` install |
| 60m "Codex quiet" vs settled 3m window | Low | `--silence 60` + status exit 0; clarify in monitor stop section |

**Verification checklist (human):**

1. `/st-pr-review-loop-inplace` on a PR with open Codex thread.
2. Confirm **Background** terminal appears in chat (not only tmux elsewhere).
3. Push a fix → see `>>> WAIT:` / `>>> ACTION:` in that terminal.
4. Agent receives notification and triages without user ping.
