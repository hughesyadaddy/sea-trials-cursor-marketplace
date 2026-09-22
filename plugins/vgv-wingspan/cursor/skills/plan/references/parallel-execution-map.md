# Parallel execution map

The single source for the `## Parallel execution map` plan section. `/plan`
writes it, `/plan-technical-review` and `/refine-approach` validate and
preserve it, and `/build` reads it to fan the work out to many subagents on
one branch.

The map is host-neutral. It describes *what* can run in parallel; the build
skill decides *how* to dispatch on Cursor or Claude Code.

## Placement in the plan

Write the section after `## Implementation Phases` (or after the task list
when the plan has no phases) and before `## Success Criteria`. Standard and
Extensive plans must include it. Minimal plans may omit it; `/build` then
runs sequentially.

## Section shape

The section has two parts that must agree with each other: a human-readable
table and a machine-readable JSON block.

### 1. Table

```markdown
## Parallel execution map

| id | paths | dependsOn | tier | summary |
| --- | --- | --- | --- | --- |
| data-model | `lib/src/models/**` | — | code | Add Order model + tests |
| repository | `lib/src/repository/**` | data-model | code | OrderRepository |
| ui-list | `lib/src/orders/list/**` | repository | code | Orders list screen |
| ui-detail | `lib/src/orders/detail/**` | repository | code | Order detail screen |
| l10n-keys | `l10n/**` | — | mechanical | Add new ARB strings |
```

Columns:

| Column | Meaning |
| --- | --- |
| `id` | Stable kebab-case identifier, unique within the plan |
| `paths` | Disjoint glob prefixes this shard alone may create or edit |
| `dependsOn` | Ids that must finish first (`—` when none) |
| `tier` | `mechanical`, `code`, or `reasoning` (see Tiers) |
| `summary` | One line: what the shard delivers |

### 2. `shards` block

Immediately after the table, add a fenced block with the language tag
`shards` containing JSON:

````markdown
```shards
{
  "maxParallel": 6,
  "shards": [
    {
      "id": "data-model",
      "paths": ["lib/src/models/"],
      "dependsOn": [],
      "tier": "code",
      "sharedFiles": []
    },
    {
      "id": "repository",
      "paths": ["lib/src/repository/"],
      "dependsOn": ["data-model"],
      "tier": "code",
      "sharedFiles": ["lib/src/orders.dart"]
    }
  ]
}
```
````

Fields:

| Field | Type | Rules |
| --- | --- | --- |
| `maxParallel` | integer | Default `6`; keep between `1` and `12` |
| `shards[].id` | string | Matches the table `id` exactly |
| `shards[].paths` | string[] | Path prefixes; no two shards share a prefix |
| `shards[].dependsOn` | string[] | Existing ids; the graph must be acyclic |
| `shards[].tier` | string | `mechanical`, `code`, or `reasoning` |
| `shards[].sharedFiles` | string[] | Files this shard needs changed but must not edit |

The JSON block is what `/build` parses. The table is for humans and review
agents. When they disagree, fix the plan; do not guess.

## Rules

1. **Disjoint ownership.** No path prefix appears in more than one shard,
   and no shard's prefix is a parent or child of another shard's prefix.
   One shard, one owner, per file.
2. **Shared files belong to the integrator.** Any file more than one shard
   would touch (barrel/export files, `pubspec.yaml`, `package.json`,
   lockfiles, l10n/ARB files, DI registration, route tables) is listed in
   `sharedFiles` of every shard that needs it. Workers never edit these;
   they report the required change in `needsIntegration` and the
   integrator applies it once.
3. **Independently compilable and testable.** Each shard, given its
   `dependsOn` shards, must leave the project compiling with its own tests
   passing. If a shard cannot compile without another shard's output, add
   the dependency; if two shards cannot be separated, merge them.
4. **Size.** Aim for 4 to 12 shards. Fewer than 4 means the plan is small
   enough to run sequentially; more than 12 rarely pays for the
   integration cost. Each shard should fit one subagent context window.
5. **Dependencies are minimal.** Prefer wide graphs (many roots) over deep
   chains. A chain of dependent shards is sequential work in disguise.
6. **Tests live with their shard.** A shard's `paths` include its test
   directories so the same worker writes code and tests together.
7. **`maxParallel` is a ceiling, not a target.** `/build` launches every
   ready shard up to this number; the user may lower it for a slower
   machine or raise it up to `12`.

## Tiers

| Tier | Use for | Typical execution model |
| --- | --- | --- |
| `mechanical` | Renames, moves, codegen, string tables, boilerplate tests | Cheapest fast model |
| `code` | Ordinary implementation with tests inside one layer or feature | Fast coding model |
| `reasoning` | Cross-cutting design, tricky migrations, concurrency, security | Parent's model or a high-reasoning model |

Most shards are `code`. Use `reasoning` sparingly; if most of a plan is
`reasoning`, it probably needs another design pass before building.

## Model tiering

| Role | Tier | Cursor (`model:`) | Claude Code (`model:`) |
| --- | --- | --- | --- |
| Planning, technical review, integration | high-reasoning | parent chat model (inherit) | `inherit` or `opus` |
| `reasoning` shard worker | high-reasoning | inherit | `inherit` or `opus` |
| `code` shard worker | fast coding | `composer-2.5` | `sonnet` |
| `mechanical` shard worker | cheapest | `composer-2.5` (or another fast slug) | `haiku` |
| Review agents | pinned | as pinned in each agent file | as pinned in each agent file |

Model slugs change. On Cursor, confirm slugs with `agent --list-models` or
the chat model picker before pinning anything other than `composer-2.5`.
The user may override any row; record the override in the plan under the
map as `> Model override: <role> = <model>`.

## Relationship to phases and PR splitting

- **Parallel shards on one branch are the default.** The
  `plan-splitting-agent` still runs during plan review; its proposed
  boundaries become shards in this map, not separate PRs.
- **PR splitting is opt-in.** Only when the user asks for separate PRs does
  the review write `-part-N` plan files. Each part then carries its own
  map.
- **Implementation Phases still work.** A phased plan may also carry a map;
  each phase's shards list that phase's ids in `dependsOn` order, and
  `/build` runs one phase's ready shards at a time.

## Validation checklist

Reviewers (`/plan-technical-review`, the embedded plan review in `/plan`,
and `/refine-approach`) check every item and fix the plan inline:

- [ ] Table and `shards` JSON list the same ids with the same `dependsOn`
      and `tier`
- [ ] No two shards share a path prefix, and no prefix nests inside
      another shard's prefix
- [ ] Every `dependsOn` id exists; the graph has no cycles
- [ ] No `sharedFiles` entry falls under any shard's `paths`
- [ ] Each shard compiles and tests on its own given its dependencies
- [ ] 4 to 12 shards; `maxParallel` between 1 and 12
- [ ] Tiers are sane: no `mechanical` shard that needs design judgment, no
      `reasoning` shard that is plain boilerplate
- [ ] Every file the plan's tasks touch is owned by exactly one shard or
      listed in `sharedFiles`

## Worker result contract

`/build` workers finish by printing exactly one JSON line so the integrator
can parse it without reading the whole transcript:

```json
{"shard":"repository","status":"done","filesChanged":["lib/src/repository/order_repository.dart","test/src/repository/order_repository_test.dart"],"needsIntegration":["export 'src/repository/order_repository.dart'; in lib/src/orders.dart"],"notes":""}
```

| Field | Meaning |
| --- | --- |
| `shard` | The shard id |
| `status` | `done` or `blocked` |
| `filesChanged` | Every file the worker created, edited, or deleted |
| `needsIntegration` | Exact edits the integrator must make to `sharedFiles` |
| `notes` | Why `blocked`, or anything the integrator must know; empty otherwise |
