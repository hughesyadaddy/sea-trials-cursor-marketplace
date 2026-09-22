# Human cadence for Jira writes

`scripts/sprint/human-cadence.mjs` plans **when** each Jira write
happens and supplies the small pieces of text a person types over and
over. The MCP calls are still made by the skill and its workers; the
script only produces the schedule, waits for it, and varies phrasing.

## Why

Jira keeps an activity stream per issue, per project, and per person.
A sprint uploaded by a loop looks like this in it:

- thirty creates in under a minute, one every 1-2 seconds
- subtasks landing before their story, or four stories interleaved
- every card created at 02:14 on a Sunday
- identical comment text on every touched card
- zero edits afterwards, because nothing was ever a typo

A person uploading the same sprint looks like this:

- one epic, then one story, then that story's subtasks, then the next
  story
- 5-20 seconds between cards, a few outliers either way
- a two-minute gap every handful of cards (reading the next file,
  getting coffee)
- once or twice, a card edited a minute after it was created
- everything between breakfast and dinner on a weekday
- comments that vary in wording and start differently

The script reproduces the second list without turning a 30-card sprint
into an hour of waiting. Target: **30 cards in 8-15 minutes** (seeds
1-20 on the test fixture: 10m 13s to 16m 14s, median 12m 19s).

## The schedule

`planSchedule(items, opts)` returns `{ id, kind, action, startOffsetMs,
batch, deferField }` entries, sorted by offset. Rules, in order:

| Rule | Value |
| --- | --- |
| Order | one epic at a time; epic card first; stories in folder order; each story's subtasks right after it |
| Inter-card gap | log-normal, median 12 s (`--median-gap`), sigma 0.55, clamped to 3-45 s |
| Think pause | 60-180 s added after every 6-10 cards; `batch` increments |
| Typo edit | for ~10% of creates that offer one (`item.edit`), one `editJiraIssue` on a single field 20-90 s after the create; the create leaves that field out (`deferField`) |
| Same second | never two writes in one second; a collision pushes the later write to the next second |
| Seed | `--seed N` makes the plan reproducible; the CLI prints the seed it used |
| Fast | `--fast` collapses every gap to 0 (dry runs, tests, sandbox projects) |

Log-normal because human inter-action times are right-skewed: most
gaps sit near the median, a few are long, none are negative or
uniform. The clamp stops the tail from producing a 4-minute gap that
is not a think pause, and stops the head from producing sub-3-second
bursts.

The typo edit needs a field the create can safely omit. `labels` is
the default suggestion: the create goes out without labels and the
edit adds them. Content never changes; only the moment a field is set.

```bash
node "$SPRINT/human-cadence.mjs" plan "$SCRATCH/payload.json" \
  --edit-field labels --json > "$SCRATCH/schedule.json"
node "$SPRINT/human-cadence.mjs" plan "$SCRATCH/payload.json"   # table
```

The table lists `id`, `kind`, `action` (with `(defer labels)` on a
create whose edit is planned), `offset` as `+m:ss`, and `batch`, then
one `total:` line with writes, duration, think pauses, and the seed.

## The activity window

Writes happen between **08:00 and 19:30 local time, Monday to Friday**
by default. `activityWindow(now, opts)` returns `{ allowed,
nextAllowed, waitMs }`; the uploader **waits** for the window rather
than skipping cards or writing anyway.

| Override | Effect |
| --- | --- |
| `--hours 09:00-17:00` | different daily window |
| `--weekends` | allow Saturday and Sunday |
| `--tz Europe/Lisbon` | evaluate the window in that zone (default: the machine's zone) |
| `--ignore-hours` | write now regardless; use when the person is at the keyboard outside hours and says so |

`node "$SPRINT/human-cadence.mjs" window` prints `open` (exit 0) or
`closed until <iso> (wait 11h 0m 0s)` (exit 3).

## Waiting between writes

Workers do not compute offsets by hand. Before each write:

```bash
node "$SPRINT/human-cadence.mjs" wait --start "$T0" --offset 687727
```

`T0` is the ISO timestamp of the first write of the run (the parent
records it). `wait` sleeps until `T0 + offset`, then until the window
is open, and prints what it waited. If the worker is already past the
offset it returns at once; the worker must still leave at least 3 s
after its previous write.

In JavaScript, `runWithCadence(items, executor, opts)` does the same
loop in-process with injectable `sleep` and `now`; it records actual
times and stops at the first executor error, returning the partial log
and the remaining entries.

## Phrasing

`vary(kind, ctx)` returns one of at least eight variants per kind,
never repeating any of the last three for that kind. Kinds:

| Kind | Used for |
| --- | --- |
| `comment-opener` | the one-line comment on a card in the `update` bucket ("Updated the AC after standup.") |
| `edit-reason` | a comment on an edit when the parent decides one is warranted; `{field}` is filled from `ctx.field` |
| `moved-to-backlog` | the note when a card leaves the sprint |
| `verifier-remark` | the remark a verifier posts when the parent asks it to |

All variants use contractions, some start lowercase, none contain an
exclamation mark, an emoji, or an em dash, and every one passes the
contract's banned-phrasing rules (section 5) plus the voice rules
(no `automation`, `script`, `bot`, `agent`, `AI`, `generated`,
`prompt`). `node "$SPRINT/human-cadence.mjs" check "<text>"` runs the
same filter on any free text before it goes to Jira; exit 1 means fix
the text.

```bash
node "$SPRINT/human-cadence.mjs" vary comment-opener --n 5
node "$SPRINT/human-cadence.mjs" vary edit-reason --field labels
```

## Concurrency

One uploader at a time per board. Parallel uploaders into one project
interleave stories and defeat the schedule. Parallelism is allowed only
across **different** Jira projects or sites, each with its own
schedule and `T0`. Verifiers read; reads carry no cadence and may run
in parallel. Any write a verifier makes follows the schedule.

## Spot-checking the activity stream afterwards

Open the project's activity feed (project sidebar, then Activity, or
`<site>/jira/software/projects/<KEY>/pages/activity`) or the person's
profile activity, filter to the upload day, and look for:

| Bot burst | This cadence |
| --- | --- |
| A wall of "created" rows with the same minute | rows spread over 10-15 minutes with visible gaps |
| Subtask rows above their story, stories interleaved | epic, story, its subtasks, next story |
| All rows outside 08:00-19:30 or on a weekend | all rows inside the window |
| No "updated" rows at all | one or two "updated labels" rows a minute after a create |
| The same comment text on every card | comments that start differently and use contractions |
| Two rows with the same timestamp to the second | none |

Also open two or three cards and read the History tab: the create and
any label edit should be separate events, seconds apart, both by the
signed-in person. If the feed shows a burst, the run used `--fast`
outside a dry run or a sandbox project, or a worker skipped `wait`;
fix the run, not the feed.
