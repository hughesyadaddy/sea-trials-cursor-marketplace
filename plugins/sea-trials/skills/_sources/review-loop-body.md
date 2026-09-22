# Review-loop body (shared)

The one loop both `st-pr-review-loop-inplace` and
`st-pr-review-loop-worktree` execute. The skill's **Mode** section
decides *where* you work (`$ACTIVE_ROOT` = `$REPO_ROOT` or
`$WORKTREE_DIR`) and how you stage commits; everything below is
identical for both. Read `shared/review-loop-contract.md` first — it
defines `$ST_REVIEW*` paths, fan-out rules, the bot reply format, and
the hard stop conditions this body relies on.

Both hosts read this file. "Dispatch one worker per line" always means
**Cursor: `Task` with `subagent_type`; Claude Code: `Agent` subagent by
name.** Never paste host-specific code for the other host.

## Loop overview

```text
DETECT ──► TRIAGE ──► FIX (fan-out) ──► GATE (fan-out) ──► PUSH
   ▲                                                         │
   └──────────── REPLY + RESOLVE (cite pushed SHA) ◄─────────┘
```

Exit the loop only when DETECT reports `DONE`: zero unresolved bot
threads, CI green on HEAD, and the settled machine finished a full
quiet window after the **last** push.

## Step 1 — Detect (settled machine)

Run the watcher from `$ACTIVE_ROOT`, in a background terminal, after
every push (and once at loop start):

```bash
node "$ST_REVIEW_LOOP" -- --pr <n>            # adaptive default
node "$ST_REVIEW_LOOP" -- --pr <n> --webhook  # opt-in fast path
node "$ST_REVIEW_LOOP" -- --pr <n> --json     # machine snapshot/poll
```

It drives the **bot review settled machine**
(`scripts/hooks/lib/bot-review-settled.mjs`), anchored to the current
HEAD sha and push time; signals from an older head never count:

| State | What the loop is waiting for | Poll |
| --- | --- | --- |
| `PUSHED` | 20 s grace after the push | — |
| `AWAITING_ACK` | Codex 👀 · Bugbot/CodeRabbit check queued · Copilot in `requested_reviewers` (≤3 min; re-post `@codex review` once on timeout) | 15 s |
| `REVIEWING` | New bot comments; ETag REST, GraphQL only on a 200; 60 s while CI pending; cap 25 min | 30 s |
| `SETTLED_CHECK` | Two consecutive quiet polls, then a 3-min quiet window | 60 s |
| `SETTLED` → `ACTING` / `DONE` | Unresolved bot threads > 0 → act; else done | — |

`--silence <min>` stays an absolute cap (default 30) — nothing waits
longer than before. `--interval <s>` overrides the `REVIEWING` poll.
`--bots codex,bugbot,coderabbit,copilot` limits which acks are awaited.
`--webhook` spawns `gh webhook forward` to a local receiver so any
review/comment/check event polls immediately; polling remains the
fallback and the flag degrades silently when the extension is missing.

Read exit codes as work tickets — never ask the user whether to
proceed:

| Exit | Meaning | Next step |
| --- | --- | --- |
| `0` | `DONE` — settled, threads clear, CI green | Final verification |
| `2` | `ACTING` — unresolved threads; queue written | Step 2 |
| `3` | CI failed on HEAD | Fix or re-run flake → Step 4 |
| `8` | CI still pending at the silence cap | Keep watching |

Spot-check any time with `node "$ST_REVIEW_STATUS" -- --pr <n>` (prints
`settled.state`, unresolved bot count, CI per check). Queue and state
live under `docs/vgv-code-review/<scope>/` in the active root.

## Step 2 — Triage every unresolved bot thread

List threads with the canonical helper (paginated, full comment
chains; never hand-roll `gh api`):

```bash
node "$ST_REVIEW" list --pr <n> [--json]
```

`--repo` is optional — the helper resolves `owner/name` from `origin`
(override with `GH_REPO`). Triage **every** unresolved thread, not only
those newer than the last push; bots reply on existing threads.
Classify each: (a) valid fix · (b) already fixed / stale · (c)
intentional · (d) incorrect. Run the adversarial vet from the contract
(3 workers per thread, one wave) before any reply.

## Step 3 — Fan out fix workers

For every thread in class (a), emit one path-scoped task per file:

```bash
node "$ST_FIX" -- --pr <n>
```

Dispatch one worker per JSON line in a single parent turn (batch by
16). Workers edit only their `path` inside `$ACTIVE_ROOT`; they never
push, commit, or reply. Parent integrates conflicts and re-reads the
diff. Minimal fixes only; no drive-bys; architecture rules preserved.

## Step 4 — Parallel local gate, then commit

```bash
node "$ST_REVIEW_PUSH" -- --pr <n> --list-tasks
```

Each JSON line is one gate lane (dirty tree, committed diff, PR CI
parity). Dispatch one worker per line in one parent turn; each worker
runs exactly:

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/run-gate-task.mjs" '<json-line>'
```

Every line carries worker hints — honour them:

| Hint | Cursor (`Task`) | Claude Code (`Agent`) |
| --- | --- | --- |
| `subagent_type` | pass through | pick the matching subagent |
| `model` / `claudeModel` | `model: composer-2.5` | `model: haiku` |

Workers return pass/fail plus a log excerpt only. Any red lane → fix
the root cause → re-run **that lane** (or the whole emitter) until all
lanes are green.

**Commit only after the gate is green.** Stage per the skill's Mode
section, write one review-round commit, then continue. The gate is
never skipped after a push: when a push produced new work, the next
round runs Step 4 again in full. The gate-pass token
(`scripts/hooks/lib/gate-pass-token.mjs`) lets the husky pre-push skip
redundant work when the tree is unchanged — it is not a reason to skip
this step.

## Step 5 — Push (the only path)

```bash
node "$ST_REVIEW_PUSH" -- --pr <n>
```

This is the **only** push path: it re-checks the gate plan and runs
`git push` with hooks. Never bare `git push`, never `--force`, never
`--no-verify`. Exit `8` after the push means CI pending — continue.
Non-fast-forward → Sync recovery from the contract, then push again
(≤5 retries). Record the pushed SHA:

```bash
PUSHED_SHA=$(git rev-parse --short HEAD)
```

## Step 6 — Reply + resolve every addressed thread

Build each reply with `format` and close with `close` — never a silent
resolve, never raw `gh api`:

```bash
BODY=$(node "$ST_REVIEW" format --verdict valid \
  --sha "$PUSHED_SHA" --summary "<what changed and why>")
node "$ST_REVIEW" close --pr <n> --thread <PRRT_…> \
  --body "$BODY" --sha "$PUSHED_SHA"
```

`close` refuses a body that does not cite the fix SHA (`--sha` appends
it when the text omits it) and verifies the thread is resolved with a
single-node query. Use `--verdict reject|stale` for classes (b)–(d)
with concrete evidence (still cite `$PUSHED_SHA` so bots anchor the
verdict to a head). Top-level review bodies without an inline thread
cannot be resolved — post via
`node "$ST_REVIEW" comment --pr <n> --sha "$PUSHED_SHA" --body …
[--minimize <review-node-id>]`.

Then **re-enter Step 1** with a fresh watcher for the new head.

## Hard stop conditions

Stop and report (do not keep looping) when any of these hold:

1. `$ST_REVIEW_LOOP` exits `0` after the post-push quiet window — done.
2. The **30-minute max-silence cap** (`--silence`, default 30) elapses
   with CI still pending on HEAD — exit `8`; report CI as the blocker.
3. Push rejected 5 times in a row after Sync recovery.
4. A gate lane stays red after a root-cause fix attempt and the
   remaining failure needs a product/API decision — ask once via the
   host structured-question tool.
5. Mode-specific preflight failed (wrong branch in-place; worktree
   creation failed).

Never stop because: one or two polls were clean; "bots usually answer
by now"; CI is green but threads remain; threads are clear but CI is
red or pending; the user could "check back later".

## Round rules

- One push per bot round; batch all fixes for the round.
- Every new push resets the machine (new head, new `t0`).
- Subagents never push, commit, or reply — parent only.
- Prefer zero questions; the host structured-question tool is for
  irreversible or unknowable blockers only.
