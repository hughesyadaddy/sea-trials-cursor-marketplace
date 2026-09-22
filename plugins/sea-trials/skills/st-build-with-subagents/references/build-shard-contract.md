# Build shard contract

One plan → one `shards.json` → many workers on **one branch**. The
parent plans and integrates; workers only execute. This file is the
contract all three scripts and both agent files implement.

## Manifest (`shards.json`)

```json
{
  "shards": [
    {
      "id": "core",
      "paths": ["flutter/packages/foo/lib/src/core/"],
      "dependsOn": [],
      "tier": "code",
      "sharedFiles": ["flutter/packages/foo/lib/foo.dart"],
      "summary": "Repository + models for X"
    },
    {
      "id": "l10n",
      "paths": ["flutter/packages/l10n/"],
      "tier": "mechanical"
    }
  ],
  "sharedFiles": ["flutter/packages/foo/pubspec.yaml"],
  "maxParallel": 6
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `shards[].id` | yes | Unique, stable; used by `--done` / results |
| `shards[].paths` | yes | Prefixes the worker may edit; no `..` |
| `shards[].dependsOn` | no | DAG; a shard is ready when all deps are done |
| `shards[].tier` | no | `mechanical` \| `code` \| `reasoning`; default `code`, inferred `mechanical` for l10n/generated-only paths |
| `shards[].model` / `claudeModel` | no | Explicit per-shard model (Cursor slug / Claude alias); beats tier |
| `shards[].sharedFiles` | no | Integrator-owned files this shard will need edits in |
| `shards[].summary` | no | One line echoed into the worker prompt |
| `sharedFiles` | no | Manifest-wide integrator-owned files |
| `maxParallel` | no | Rolling-window size; default **6**, cap **12** |

Generate from a plan, then validate:

```bash
node "$ST_PLUGIN_ROOT/skills/st-build-with-subagents/scripts/suggest-shards-from-plan.mjs" docs/plan/<plan>.md > shards.json
node "$ST_PLUGIN_ROOT/skills/st-build-with-subagents/scripts/validate-shard-manifest.mjs" shards.json
```

`suggest-shards-from-plan.mjs` prefers an explicit ```` ```shards ````
JSON block or a `## Parallel execution map` table
(`| id | paths | dependsOn | tier | sharedFiles |`) in the plan and
falls back to package-root heuristics. Heuristic output has no
`dependsOn` — add them by hand.

## Validator rules

- `id` unique; `paths[]` non-empty; `dependsOn` forms a DAG
- `paths` must not overlap across shards (prefix-safe)
- `maxParallel` integer in `[1, 12]`
- `tier`, when set, is one of the three tiers
- A shard may not list a declared shared file in its `paths`
- **Intra-package split:** two shards under one package root (before
  `lib/`, `test/`, `src/`, `integration_test/`) must declare at least
  one `sharedFiles` entry under that root — the barrel
  (`<root>/lib/<name>.dart`), `pubspec.yaml`, `.arb`, or `index.*` —
  because both will want to edit it. Shared-looking files owned by a
  shard inside a split package are rejected; move them to
  `sharedFiles`.

## Same-branch rules

- Workers commit to the **same branch** (`shard(<id>): …`). No PRs,
  no push, no worktrees, no branch switches, no rebase/stash.
- Workers edit only their `paths`. **Workers never edit
  `sharedFiles`.** They report the exact edit needed in
  `needsIntegration`; the integrator (parent or `st-shard-integrator`)
  applies it.
- Workers never run gate scripts (`prepush`, `pr-local-ci`,
  `pr-review-push`, `agent-prepush`). One harden happens at the end.
- The parent pushes **once**, via `pr-review-push` after
  `/st-pre-push-harden` — never bare `git push`.

## Worker result contract

Every worker ends with exactly one JSON line:

```json
{"shard":"core","status":"done","filesChanged":["flutter/packages/foo/lib/src/core/repo.dart"],"needsIntegration":["flutter/packages/foo/lib/foo.dart: export 'src/core/repo.dart';"],"notes":"agent-validate exit 0"}
```

| Field | Values |
| --- | --- |
| `shard` | the shard id |
| `status` | `done` (committed, validate green) or `blocked` |
| `filesChanged` | repo-relative paths created or edited |
| `needsIntegration` | exact shared-file edits for the integrator; `[]` if none |
| `notes` | validate exit code, blockers, one line |

The parent records it:

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/st-build-shard-tasks.mjs" \
  --manifest shards.json --root "$ACTIVE_ROOT" --state-file .st/shards.json \
  --result '<that json line>'
```

`status: "done"` completes the shard and unlocks dependents;
`status: "blocked"` parks the shard and everything depending on it
until the parent resolves the blocker and re-runs with `--reemit`.
`--done <id,id>` is the shorthand when the worker returned green but
you do not have its JSON line.

## Emitter state

`--state-file` tracks **emitted**, **done**, **blocked** and the
recorded results separately. Emitting a shard never marks it done:
a re-run after a crash only re-issues in-flight shards with
`--reemit`. `--status` prints the full view:

```json
{ "ready": [], "inFlight": ["core"], "pending": ["ui"],
  "blockedBy": { "ui": ["core"] }, "done": ["l10n"], "blocked": [],
  "needsIntegration": [{ "shard": "l10n", "items": ["…"] }],
  "slots": 5, "complete": false }
```

## Emitted task line

```json
{"source":"build-shard","taskId":"core","shard":"core",
 "subagent_type":"st-shard-worker","fallbackSubagentType":"generalPurpose",
 "claudeAgent":"sea-trials:st-shard-worker",
 "tier":"code","model":"composer-2.5","claudeModel":"sonnet",
 "run_in_background":true,"description":"Build shard core",
 "prompt":"…self-contained…","paths":["…"],"sharedFiles":["…"],
 "dependsOn":[]}
```

## Model tiering

Planner, integrator and reviewers stay on the parent's model
(`inherit`). Shard workers are execution and default to the cheap
tier. Override per shard (`tier`, `model`, `claudeModel`) or per tier
via environment:

| Tier | Cursor `model` | Claude `claudeModel` | Env override |
| --- | --- | --- | --- |
| `mechanical` | `composer-2.5-fast` | `haiku` | `ST_SHARD_MODEL_MECHANICAL` / `…_CLAUDE` |
| `code` | `composer-2.5` | `sonnet` | `ST_SHARD_MODEL_CODE` / `…_CLAUDE` |
| `reasoning` | `inherit` | `inherit` | `ST_SHARD_MODEL_REASONING` / `…_CLAUDE` |

Cursor slugs known to work with the Task tool in this org:
`composer-2.5`, `composer-2.5-fast`, `gpt-5.6-sol-medium`,
`grok-4.7-high-fast`, `inherit`. Claude aliases: `haiku`, `sonnet`,
`opus`, `inherit`.
