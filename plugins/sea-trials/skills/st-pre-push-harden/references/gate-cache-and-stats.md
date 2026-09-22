# Gate cache and worker telemetry

Two speed/observability layers sit under every gate command
(`pr-review-push`, `prepush`, `agent-validate`, `run-gate-task`).
Neither changes what a green verdict means; both are opt-out.

## What is cached

`scripts/hooks/lib/gate-cache.mjs` remembers **successful**
`dart format --check`, `sea-trials-lint check` and
`dart analyze --fatal-infos` tasks by a content hash of everything the
task reads. Failures are never remembered.

| Task kind | Hashed inputs |
| --- | --- |
| `format`, `lint` | every listed `.dart` file, plus each file's nearest `pubspec.yaml` and `analysis_options.yaml` |
| `analyze` | the owning package's `pubspec.yaml`, `pubspec.lock`, `analysis_options.yaml`, all `.dart` under `lib/` and `test/`, the workspace root (`flutter/`) `pubspec.yaml`, `pubspec.lock`, `analysis_options.yaml`, and for every **transitive workspace / `path:` dependency** its `pubspec.yaml` plus all `.dart` under its `lib/` (not `test/`) |
| all | task kind, tool version (`dart --version` / `sea-trials-lint --version`), the command line with repo paths made repo-relative |

Keys are checkout-independent, so a task proven green in one worktree
or branch is skipped in another with identical inputs. Dependencies are
resolved by pubspec key against the pub workspace (`resolution:
workspace` members under `flutter/`) and by `path:` value; hosted deps
are already pinned by `pubspec.lock`. An analyze whose own files plus
dependency `lib/` files exceed 3000 Dart files in total is not cached
(hashing would cost more than it saves). CI lane wrappers
(`run-lane.mjs`), test tasks, web and functions tasks are never cached.

Store: `~/.cache/sea-trials/gate-cache/<sha256>.json` (root overridable
with `ST_STATE_DIR`). One file per key, written temp + rename, so
parallel workers never read a torn entry. Entries older than 14 days
or beyond 5000 are pruned at the end of each `pr-review-push` run.

A hit logs `⏭ cache hit: <label>`; each run ends with
`⏭ gate cache: N task(s), M cache hit(s)`.

The tree-level `gate-pass-token.mjs` still exists and is unchanged; it
skips the pre-push hook right after `pr-review-push` on the same tree.
The content cache is the finer-grained layer below it.

## How to bust it

| Need | Do |
| --- | --- |
| One run without the cache | `ST_GATE_CACHE=0 node "$ST_REVIEW_PUSH" -- --pr <n>` or `run-gate-task.mjs --no-cache '<json>'` |
| See which key each task hashed to | `ST_GATE_CACHE_DEBUG=1` |
| Forget everything | `rm -rf ~/.cache/sea-trials/gate-cache` (or `$ST_STATE_DIR/gate-cache`) |
| Force a fresh verdict after a tool upgrade | nothing — the tool version is part of the key |

Editing any hashed input changes the key, so normal work never needs a
manual bust. Bust only when you suspect a task passed for a reason its
inputs do not capture (for example a dependency declared in a way the
pubspec reader does not see, such as a `git:` dependency on a local
checkout).

## Reading the stats

Every gate task, build shard result and review-loop iteration appends
one JSON line to `~/.cache/sea-trials/telemetry/gate-runs.jsonl`
(`scripts/hooks/lib/gate-telemetry.mjs`; `ST_GATE_TELEMETRY=0`
disables). Fields: `ts, kind (gate|shard|review-loop), task, phase,
taskKind, model, host (cursor|claude|unknown), ms, ok, cacheHit,
killed, repo, pr, exitCode, files, weight`.

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs"                 # all time
node "$ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs" --since 7d      # or 24h, 2026-09-01
node "$ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs" --kind shard    # gate | shard | review-loop
node "$ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs" --json
```

Consuming repos may alias this as `pnpm st-gate-stats -- <flags>`
through `.husky/st-plugin-run.sh`.

Tables:

- **by task kind** — count, fail rate, cache-hit rate, p50 / p95 / max
  wall time per `gate/format`, `gate/analyze`, `shard/<tier>`, etc.
  A rising `gate/analyze` p95 with a flat cache rate means the
  analyzer, not the plan, is the bottleneck.
- **by model** — success rate and median time per worker model. This
  is the "does `composer-2.5-fast` actually fix lints" view: compare
  its success rate against `composer-2.5` on the same task kinds.
- **slowest 10** — task labels to split or scope down.
- **total gate minutes** — wall time spent in `gate` runs in the window.

Cache hits count toward the cache-hit rate but are excluded from the
slowest list.
