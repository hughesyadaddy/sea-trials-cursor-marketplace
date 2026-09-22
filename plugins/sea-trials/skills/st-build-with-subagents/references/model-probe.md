# Host capability probe (`st-model-probe`)

Skills must not guess subagent model slugs. The probe records what this
machine can actually dispatch; the resolver picks from that record.

| Piece | Path |
| --- | --- |
| Probe CLI | `$ST_PLUGIN_ROOT/scripts/hooks/st-model-probe.mjs` |
| Resolver library | `$ST_PLUGIN_ROOT/scripts/hooks/lib/host-capabilities.mjs` |
| Output file | `~/.cache/sea-trials/host/capabilities.json` (root overridable with `ST_STATE_DIR`; path from `scripts/lib/st-state-dir.mjs#hostCapabilitiesPath`) |

## What is probed

Every external call is best-effort with a 3 s timeout and they run in
parallel, so a cold probe takes ~1-2 s and a cached one ~30 ms. The
script **always exits 0** and prints nothing under `--quiet`; it is safe
to call from a session-start hook.

| Key | Source | Notes |
| --- | --- | --- |
| `host` | env var names (`CURSOR_*` vs `CLAUDECODE` / `CLAUDE_CODE_*` / `CLAUDE_PLUGIN_ROOT`) | `cursor` \| `claude` \| `unknown`; Claude markers win because a Claude session opened from a Cursor terminal inherits `CURSOR_*`. `ST_HOST=cursor\|claude` forces it. |
| `hostEnv` | same | matched **names only**, never values |
| `cursor.models` | `agent --list-models` (Cursor CLI on PATH or `~/.local/bin/agent`) | `source: "agent --list-models"`, `verified: true`. When the CLI is missing or answers `No models available for this account.` the static list below is written with `source: "static-fallback"`, `verified: false` and a `note`. |
| `cursor.cliPath` / `cliVersion` | `agent --version` | omitted when not installed |
| `claude.models` | `claude --version` answering | aliases `haiku`, `sonnet`, `opus` + `inherit`; `source: "claude cli aliases"`, `verified: true` when the CLI answers, else static fallback |
| `claude.pluginsInstalled` | `claude plugin list` | plugin names (`name@marketplace` -> `name`) |
| `tools.askQuestion` / `tools.askUserQuestion` | **not probeable from a shell** | `"unknown"` until a skill sets them (below); preserved across re-probes |
| `mcp.servers` | keys of `mcpServers` in `~/.cursor/mcp.json`, the plugin `mcp.json`, `~/.claude.json` | names only; server configs are never copied |

Static fallback lists (the Task-tool schema seen in a Cursor session on
2026-09-22): `inherit`, `composer-2.5`, `composer-2.5-fast`,
`cursor-grok-4.6-high-fast`, `gpt-5.6-sol-medium`, `grok-4.7-high-fast`.
Claude: `inherit`, `haiku`, `sonnet`, `opus`.

## How skills use it

**Phase 0 of any fan-out skill** (build shards, gate lanes, sprint
recon), before emitting task lines:

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/st-model-probe.mjs" --quiet
```

The session-start hook already ran this; the call is a no-op on a fresh
cache (`--max-age` default `24h`). Use `--force` after installing or
signing in to a CLI.

**Record what you can see.** A shell cannot see the host's tool schema,
but the skill running inside the host can. When your tool list contains
`AskQuestion` (Cursor) or `AskUserQuestion` (Claude Code), or a `model`
allow-list on the Task tool, write it down so later scripts and
subagents (which may lack the tool) know:

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/st-model-probe.mjs" --quiet \
  --set tools.askQuestion=true \
  --set 'cursor.models=["inherit","composer-2.5","composer-2.5-fast"]' \
  --set cursor.source="task-tool-schema" --set cursor.verified=true
```

`--set k.path=value` accepts `true` / `false` / `null` / numbers / JSON
arrays / strings, applies to the cached file **without** re-probing,
stamps `updatedAt`, and rejects keys that are not dotted identifiers.
Setting `cursor.models` from the Task-tool schema is the most valuable
observation on Cursor, where the CLI often has no model list.

**Inspect:**

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/st-model-probe.mjs" --json
```

## How `resolveModel` picks

```js
import { resolveModel } from '$ST_PLUGIN_ROOT/scripts/hooks/lib/host-capabilities.mjs';
const r = resolveModel({ tier: 'mechanical' });
// { tier, host, model, claudeModel, verified, source,
//   cursor: { model, verified, source }, claude: { model, verified, source } }
```

Per host, in order:

1. **Env override** — `ST_SHARD_MODEL_<TIER>` / `ST_SHARD_MODEL_<TIER>_CLAUDE`,
   then (mechanical tier only) `ST_WORKER_MODEL` / `ST_WORKER_MODEL_CLAUDE`.
   `source: "env"`; `verified` is true only if the probe list contains
   the slug (or it is `inherit`).
2. **Probe list** (`verified: true`, non-empty) — the tier default if it
   is in the list, else the closest available:
   - `mechanical`: `composer-2.5-fast` -> any `*-fast` slug (sorted) ->
     `composer-2.5` -> `inherit`
   - `code`: `composer-2.5` -> `inherit` (a fast slug is not a substitute)
   - `reasoning`: `inherit`
   - Claude ladder: mechanical `haiku` -> `sonnet` -> `opus`;
     code `sonnet` -> `opus` -> `haiku`; reasoning `inherit`.
   `source: "probe"`, `verified: true`.
3. **Static default** — tier table below, `source: "static-fallback"`,
   `verified: false`.

| Tier | Cursor default | Claude default |
| --- | --- | --- |
| `mechanical` | `composer-2.5-fast` | `haiku` |
| `code` | `composer-2.5` | `sonnet` |
| `reasoning` | `inherit` | `inherit` |

`verified` in the top-level result follows the detected host (`host`
arg -> `caps.host` -> env). For `unknown` it is true only when both
hosts are verified. Task lines emitted by `push-gate-tasks.mjs` carry
`model`, `claudeModel`, `modelVerified`, `modelSource`; treat
`modelVerified: false` as "may be rejected by the Task tool — fall back
to `inherit` if the host complains".

Pass `caps: null` to skip the disk read, or `caps: <object>` to resolve
against a specific snapshot (tests, dry runs).

## Overrides

| Want | Do |
| --- | --- |
| Different cheap model for gate workers | `ST_WORKER_MODEL=<slug>` / `ST_WORKER_MODEL_CLAUDE=<alias>` |
| Different model for one tier everywhere | `ST_SHARD_MODEL_MECHANICAL=…`, `ST_SHARD_MODEL_CODE=…`, `ST_SHARD_MODEL_REASONING=…` (+ `_CLAUDE`) |
| One shard only | `model` / `claudeModel` on the shard in `shards.json` (see build-shard-contract.md) |
| Force host detection | `ST_HOST=cursor` or `ST_HOST=claude` |
| Relocate the cache | `ST_STATE_DIR=/path` (whole Sea Trials state root) |
| Re-probe now | `--force`; or `--max-age 0` |

## Limitations (verified 2026-09-22)

- `agent --list-models` (Cursor CLI 2026.06.04) printed
  `No models available for this account.` on the reference machine, so
  the Cursor list came from the static fallback. Text-format parsing of
  a populated list is implemented for one-slug-per-line output (bullets
  and trailing descriptions tolerated) and for JSON, but has not been
  exercised against real populated output.
- The Claude CLI has no model-list command; aliases are asserted from
  the CLI contract, not enumerated.
- Host tools are never detected automatically; without a `--set` they
  stay `"unknown"`.
