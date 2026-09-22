#!/usr/bin/env node
/**
 * Emit JSON task lines for parallel build shards (/st-build-with-subagents).
 *
 *   node st-build-shard-tasks.mjs --manifest shards.json --root <repo> \
 *     --state-file .st/shards-state.json
 *   node st-build-shard-tasks.mjs ... --done a,b        # mark workers done
 *   node st-build-shard-tasks.mjs ... --result '<json>' # record worker JSON
 *   node st-build-shard-tasks.mjs ... --status          # pending/emitted/...
 *
 * Rolling window: every run emits the shards whose `dependsOn` are all
 * done, up to `maxParallel - inFlight` lines. Emitting a shard marks it
 * `emitted`, NOT `done` — only `--done <id>` or a `--result` JSON with
 * `status: "done"` completes it. Re-run the emitter whenever any worker
 * returns and launch every line it prints.
 *
 * stdout: JSON task lines only (or one status object with `--status`).
 * stderr: human summary (`ready=… emitted=… in-flight=…`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { recordRun } from './lib/gate-telemetry.mjs';
import { resolveModel, TIER_DEFAULTS } from './lib/host-capabilities.mjs';

/** Default `maxParallel` when the manifest omits it. */
export const DEFAULT_MAX_PARALLEL = 6;
/** Hard cap; more than this overwhelms the Cursor extension host. */
export const MAX_PARALLEL_CAP = 12;

/** Shard tiers. Workers execute; the parent plans, so it stays `inherit`. */
export const TIERS = ['mechanical', 'code', 'reasoning'];
export const DEFAULT_TIER = 'code';

/**
 * Model tiering defaults (single source: host-capabilities.mjs). At run
 * time `resolveModels` prefers `ST_SHARD_MODEL_<TIER>[_CLAUDE]` env
 * overrides, then the list probed by `st-model-probe`, then these.
 */
export const TIER_MODELS = TIER_DEFAULTS;

/** Cursor subagent type used when the plugin agent file is installed. */
export const WORKER_AGENT = 'st-shard-worker';
/** Claude Code namespaces plugin agents as `<plugin>:<agent>`. */
export const WORKER_AGENT_CLAUDE = `sea-trials:${WORKER_AGENT}`;
/** Fallback when no agent file is available to the host. */
export const FALLBACK_SUBAGENT_TYPE = 'generalPurpose';

const MECHANICAL_PATH = new RegExp(
  '(^|/)(l10n|arb|generated|gen|codegen)(/|$)' +
    '|\\.arb$|\\.g\\.dart$|\\.freezed\\.dart$',
  'i',
);

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const workerAgentFile = path.join(
  hooksDir,
  '..',
  '..',
  'agents',
  `${WORKER_AGENT}.md`,
);

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv
 * @returns {{
 *   manifest: string, root: string, stateFile: string|null,
 *   done: string[], results: object[], resultFiles: string[],
 *   status: boolean, reset: boolean, reemit: boolean, wave: number|null,
 *   maxParallel: number|null, subagentType: string|null,
 *   plan: string|null, help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    manifest: 'shards.json',
    root: process.cwd(),
    stateFile: null,
    done: [],
    results: [],
    resultFiles: [],
    status: false,
    reset: false,
    reemit: false,
    wave: null,
    maxParallel: null,
    subagentType: null,
    plan: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--wave') out.wave = Number(argv[++i]);
    else if (arg === '--state-file') out.stateFile = argv[++i];
    else if (arg === '--max-parallel') out.maxParallel = Number(argv[++i]);
    else if (arg === '--subagent-type') out.subagentType = argv[++i];
    else if (arg === '--plan') out.plan = argv[++i];
    else if (arg === '--status') out.status = true;
    else if (arg === '--reset') out.reset = true;
    else if (arg === '--reemit') out.reemit = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--done') out.done.push(...splitIds(argv[++i]));
    else if (arg === '--result') out.results.push(parseResult(argv[++i]));
    else if (arg === '--result-file') out.resultFiles.push(argv[++i]);
  }
  return out;
}

function splitIds(value) {
  return String(value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Parse and validate one worker result JSON line.
 *
 * @param {string} text
 * @returns {{shard: string, status: 'done'|'blocked', filesChanged: string[],
 *   needsIntegration: string[], notes: string}}
 */
export function parseResult(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`--result is not valid JSON: ${text}`);
  }
  if (!parsed || typeof parsed.shard !== 'string' || !parsed.shard) {
    throw new Error('--result needs a string "shard" id');
  }
  if (parsed.status !== 'done' && parsed.status !== 'blocked') {
    throw new Error(
      `--result ${parsed.shard}: status must be "done" or "blocked"`,
    );
  }
  const ms = Number(parsed.ms ?? parsed.durationMs);
  return {
    shard: parsed.shard,
    status: parsed.status,
    filesChanged: asStringArray(parsed.filesChanged),
    needsIntegration: asStringArray(parsed.needsIntegration),
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    // Optional worker-reported wall time, forwarded to telemetry only.
    ...(Number.isFinite(ms) && ms >= 0 ? { ms } : {}),
  };
}

/**
 * Telemetry for one worker result (kind `shard`). Model comes from the
 * shard's resolved tier so `st-gate-stats` can compare tiers. Never
 * throws.
 *
 * @param {ReturnType<typeof parseResult>} result
 * @param {{ shards: object[], root: string, env?: NodeJS.ProcessEnv }} ctx
 */
export function recordShardResult(result, ctx) {
  const shard = (ctx.shards ?? []).find((s) => s.id === result.shard);
  const env = ctx.env ?? process.env;
  const models = shard ? resolveModels(shard, env) : null;
  return recordRun(
    {
      kind: 'shard',
      task: result.shard,
      phase: result.status,
      taskKind: models?.tier,
      model: models?.model,
      ok: result.status === 'done',
      ms: result.ms,
      files: result.filesChanged.length,
      repoRoot: ctx.root,
    },
    { env },
  );
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.filter((v) => typeof v === 'string')
    : [];
}

/**
 * Read a results file: a JSON object, a JSON array, or JSONL.
 *
 * @param {string} file
 * @returns {object[]}
 */
export function readResultFile(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    return JSON.parse(text).map((r) => parseResult(JSON.stringify(r)));
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map(parseResult);
}

/**
 * @typedef {{
 *   emitted: Set<string>, done: Set<string>, blocked: Set<string>,
 *   results: Record<string, object>,
 * }} ShardState
 */

/** @returns {ShardState} */
export function emptyState() {
  return {
    emitted: new Set(),
    done: new Set(),
    blocked: new Set(),
    results: {},
  };
}

/**
 * Load state from disk. Legacy files (`{done: []}` only) still load;
 * their `done` ids are treated as done since the old emitter conflated
 * emitted with done and we cannot recover the difference.
 *
 * @param {string|null} stateFile
 * @returns {ShardState}
 */
export function loadState(stateFile) {
  const state = emptyState();
  if (!stateFile || !fs.existsSync(stateFile)) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const id of parsed.emitted ?? []) state.emitted.add(id);
    for (const id of parsed.done ?? []) state.done.add(id);
    for (const id of parsed.blocked ?? []) state.blocked.add(id);
    state.results = parsed.results ?? {};
  } catch {
    return emptyState();
  }
  return state;
}

/**
 * @param {string|null} stateFile
 * @param {ShardState} state
 */
export function saveState(stateFile, state) {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(serializeState(state), null, 2)}\n`,
  );
}

/** @param {ShardState} state */
export function serializeState(state) {
  return {
    emitted: [...state.emitted].sort(),
    done: [...state.done].sort(),
    blocked: [...state.blocked].sort(),
    results: state.results,
  };
}

/**
 * Mark ids done (from `--done`). A done shard is no longer blocked.
 *
 * @param {ShardState} state
 * @param {string[]} ids
 */
export function markDone(state, ids) {
  for (const id of ids) {
    state.done.add(id);
    state.blocked.delete(id);
  }
}

/**
 * Record a worker result: `done` completes the shard, `blocked` parks
 * it (and every dependent) until the parent clears it.
 *
 * @param {ShardState} state
 * @param {ReturnType<typeof parseResult>} result
 */
export function applyResult(state, result) {
  state.results[result.shard] = result;
  if (result.status === 'done') {
    state.done.add(result.shard);
    state.blocked.delete(result.shard);
  } else {
    state.blocked.add(result.shard);
    state.done.delete(result.shard);
  }
}

/**
 * Shards whose deps are all done and which are not done, blocked, or
 * (unless `reemit`) already emitted.
 *
 * @param {object[]} shards
 * @param {ShardState} state
 * @param {{reemit?: boolean}} [opts]
 */
export function readyShards(shards, state, opts = {}) {
  return shards.filter((shard) => {
    if (state.done.has(shard.id) || state.blocked.has(shard.id)) return false;
    if (state.emitted.has(shard.id) && !opts.reemit) return false;
    return (shard.dependsOn ?? []).every((d) => state.done.has(d));
  });
}

/**
 * Number of workers currently running: emitted but not finished.
 *
 * @param {ShardState} state
 */
export function inFlightCount(state) {
  let n = 0;
  for (const id of state.emitted) {
    if (!state.done.has(id) && !state.blocked.has(id)) n += 1;
  }
  return n;
}

/**
 * Clamp a requested parallelism into [1, MAX_PARALLEL_CAP].
 *
 * @param {unknown} value
 */
export function resolveMaxParallel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_MAX_PARALLEL;
  return Math.min(n, MAX_PARALLEL_CAP);
}

/**
 * Infer a tier when the manifest omits one: shards that only touch
 * l10n / generated artefacts are mechanical, everything else is code.
 *
 * @param {{tier?: string, paths?: string[]}} shard
 */
export function inferTier(shard) {
  if (TIERS.includes(shard.tier)) return shard.tier;
  const paths = shard.paths ?? [];
  if (paths.length > 0 && paths.every((p) => MECHANICAL_PATH.test(p))) {
    return 'mechanical';
  }
  return DEFAULT_TIER;
}

/**
 * Resolve Cursor + Claude models for a shard: explicit `model` /
 * `claudeModel` on the shard win; otherwise `resolveModel` from
 * host-capabilities applies env overrides, then the probed model list
 * (`st-model-probe`), then the static tier defaults.
 *
 * @param {object} shard
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, any>|null} [caps] probe output; `undefined`
 *   reads it from disk, `null` skips the read
 * @returns {{
 *   tier: string, model: string, claudeModel: string,
 *   modelVerified: boolean, modelSource: string,
 * }}
 */
export function resolveModels(shard, env = process.env, caps) {
  const tier = inferTier(shard);
  const resolved = resolveModel({ tier, env, caps });
  const explicitCursor = Boolean(shard.model);
  const explicitClaude = Boolean(shard.claudeModel);
  return {
    tier,
    model: shard.model || resolved.model,
    claudeModel: shard.claudeModel || resolved.claudeModel,
    modelVerified:
      explicitCursor || explicitClaude ? false : resolved.verified,
    modelSource:
      explicitCursor || explicitClaude ? 'shard' : resolved.source,
  };
}

/**
 * Pick the Cursor `subagent_type`: the plugin worker agent when its
 * file is installed, otherwise `generalPurpose`.
 *
 * @param {{override?: string|null, agentFileExists?: boolean}} [opts]
 */
export function resolveSubagentType(opts = {}) {
  if (opts.override) return opts.override;
  const exists = opts.agentFileExists ?? fs.existsSync(workerAgentFile);
  return exists ? WORKER_AGENT : FALLBACK_SUBAGENT_TYPE;
}

/**
 * Build the self-contained worker prompt. Works on both hosts: no tool
 * names, just the contract.
 *
 * @param {object} shard
 * @param {{root: string, plan?: string|null, sharedFiles: string[]}} ctx
 */
export function buildPrompt(shard, ctx) {
  const paths = (shard.paths ?? []).join(', ');
  const shared = ctx.sharedFiles.length
    ? ctx.sharedFiles.join(', ')
    : '(none)';
  const lines = [
    `You are build shard "${shard.id}" for Sea Trials.`,
    `Repo root (ONLY edit here): ${ctx.root}`,
    `Allowed paths: ${paths}`,
    `Shared files (integrator-owned, DO NOT edit): ${shared}`,
  ];
  if (ctx.plan) {
    lines.push(`Plan: ${ctx.plan} — read the section(s) for this shard.`);
  }
  if (shard.summary) lines.push(`Shard summary: ${shard.summary}`);
  lines.push(
    'Rules: same branch; commit your shard with a scoped message; ' +
      'no git push, no worktrees, no PRs, no gate scripts ' +
      '(prepush, pr-local-ci, pr-review-push), no edits outside ' +
      'allowed paths, no edits to shared files.',
    'If an export/registration/dependency in a shared file is needed, ' +
      'list it under needsIntegration instead of editing the file.',
    'Mirror test/ for lib/ changes. Before returning run: ' +
      'pnpm agent-validate -- <changed files> (or node ' +
      '$ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs).',
    'Finish by printing exactly one JSON line: ' +
      `{"shard":"${shard.id}","status":"done|blocked",` +
      '"filesChanged":[...],"needsIntegration":[...],"notes":"..."}',
  );
  return lines.join('\n');
}

/**
 * Build one task line for a shard.
 *
 * @param {object} shard
 * @param {{
 *   root: string, plan?: string|null, subagentType: string,
 *   manifestSharedFiles?: string[], env?: NodeJS.ProcessEnv,
 * }} ctx
 */
export function buildTask(shard, ctx) {
  const sharedFiles = [
    ...new Set([
      ...(ctx.manifestSharedFiles ?? []),
      ...(shard.sharedFiles ?? []),
    ]),
  ].sort();
  const { tier, model, claudeModel, modelVerified, modelSource } =
    resolveModels(shard, ctx.env, ctx.caps);
  return {
    source: 'build-shard',
    taskId: shard.id,
    shard: shard.id,
    subagent_type: ctx.subagentType,
    fallbackSubagentType: FALLBACK_SUBAGENT_TYPE,
    claudeAgent: WORKER_AGENT_CLAUDE,
    tier,
    model,
    claudeModel,
    modelVerified,
    modelSource,
    run_in_background: true,
    description: `Build shard ${shard.id}`,
    prompt: buildPrompt(shard, {
      root: ctx.root,
      plan: ctx.plan,
      sharedFiles,
    }),
    paths: shard.paths ?? [],
    sharedFiles,
    dependsOn: shard.dependsOn ?? [],
  };
}

/**
 * Compute the status view: which shards are pending (deps unmet),
 * ready (emit now), in flight, done, or blocked.
 *
 * @param {object[]} shards
 * @param {ShardState} state
 * @param {number} maxParallel
 */
export function computeStatus(shards, state, maxParallel) {
  const ready = readyShards(shards, state).map((s) => s.id);
  const inFlight = [];
  const pending = [];
  const blockedBy = {};
  for (const shard of shards) {
    const { id } = shard;
    if (state.done.has(id) || state.blocked.has(id)) continue;
    if (state.emitted.has(id)) {
      inFlight.push(id);
      continue;
    }
    if (ready.includes(id)) continue;
    pending.push(id);
    const unmet = (shard.dependsOn ?? []).filter((d) => !state.done.has(d));
    blockedBy[id] = unmet;
  }
  const needsIntegration = Object.values(state.results)
    .filter((r) => r.needsIntegration?.length)
    .map((r) => ({ shard: r.shard, items: r.needsIntegration }));
  const slots = Math.max(0, maxParallel - inFlight.length);
  return {
    total: shards.length,
    maxParallel,
    slots,
    ready,
    inFlight,
    pending,
    blockedBy,
    done: [...state.done].sort(),
    blocked: [...state.blocked].sort(),
    needsIntegration,
    complete: state.done.size >= shards.length,
  };
}

/**
 * Select the shards to emit this run: ready shards, capped by free slots
 * (rolling window). `reemit` re-issues in-flight shards too.
 *
 * @param {object[]} shards
 * @param {ShardState} state
 * @param {number} maxParallel
 * @param {{reemit?: boolean}} [opts]
 */
export function selectForEmit(shards, state, maxParallel, opts = {}) {
  const ready = readyShards(shards, state, opts);
  const slots = opts.reemit
    ? maxParallel
    : Math.max(0, maxParallel - inFlightCount(state));
  return { ready, chosen: ready.slice(0, slots), slots };
}

/**
 * Preview wave N assuming every earlier wave finished (batch view).
 * Kept for compatibility; the rolling window above is preferred.
 *
 * @param {object[]} shards
 * @param {ShardState} state
 * @param {number} maxParallel
 * @param {number} wave
 */
export function previewWave(shards, state, maxParallel, wave) {
  const sim = {
    emitted: new Set(state.emitted),
    done: new Set(state.done),
    blocked: new Set(state.blocked),
    results: {},
  };
  for (let i = 0; i < wave; i += 1) {
    const ready = readyShards(shards, sim, { reemit: true });
    if (ready.length === 0) return [];
    for (const shard of ready.slice(0, maxParallel)) sim.done.add(shard.id);
  }
  return readyShards(shards, sim, { reemit: true }).slice(0, maxParallel);
}

function summaryLine(status, emittedNow) {
  return (
    `[st-build-shard-tasks] ready=${status.ready.length} ` +
    `emitted-now=${emittedNow} in-flight=${status.inFlight.length} ` +
    `slots=${status.slots} done=${status.done.length}/${status.total} ` +
    `blocked=${status.blocked.length} pending=${status.pending.length}` +
    (status.complete ? ' COMPLETE' : '')
  );
}

function printHelp() {
  process.stdout.write(`\
Rolling-window shard emitter for /st-build-with-subagents.

  --manifest <shards.json>    default shards.json
  --root <dir>                repo root workers may edit
  --state-file <file>         persist emitted/done/blocked between runs
  --done <id,id>              mark shards done (worker returned OK)
  --result '<json>'           record a worker result line (repeatable)
  --result-file <file>        JSON / JSONL of worker result lines
  --status                    print status JSON instead of task lines
  --reemit                    re-issue in-flight shards (crashed worker)
  --reset                     delete the state file first
  --max-parallel <n>          override manifest (cap ${MAX_PARALLEL_CAP})
  --subagent-type <name>      override Cursor subagent_type
  --plan <plan.md>            referenced in every worker prompt
  --wave <n>                  preview wave n (batch view, legacy)

Loop: launch every line; when ANY worker returns, re-run with
--done <id> (or --result) and launch every new line. Repeat until
the summary says COMPLETE.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.reset && args.stateFile && fs.existsSync(args.stateFile)) {
    fs.rmSync(args.stateFile);
  }
  const raw = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const shards = raw.shards ?? [];
  const maxParallel = resolveMaxParallel(
    args.maxParallel ?? raw.maxParallel ?? DEFAULT_MAX_PARALLEL,
  );
  const state = loadState(args.stateFile);
  markDone(state, args.done);
  const results = [...args.results];
  for (const file of args.resultFiles) results.push(...readResultFile(file));
  for (const result of results) {
    applyResult(state, result);
    recordShardResult(result, { shards, root: args.root });
  }

  if (args.status) {
    const status = computeStatus(shards, state, maxParallel);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.stderr.write(`${summaryLine(status, 0)}\n`);
    saveState(args.stateFile, state);
    return;
  }

  let chosen;
  if (args.wave !== null && !Number.isNaN(args.wave)) {
    chosen = previewWave(shards, state, maxParallel, args.wave);
  } else {
    chosen = selectForEmit(shards, state, maxParallel, {
      reemit: args.reemit,
    }).chosen;
  }

  const subagentType = resolveSubagentType({ override: args.subagentType });
  for (const shard of chosen) {
    const task = buildTask(shard, {
      root: args.root,
      plan: args.plan,
      subagentType,
      manifestSharedFiles: raw.sharedFiles ?? [],
    });
    process.stdout.write(`${JSON.stringify(task)}\n`);
    state.emitted.add(shard.id);
  }
  saveState(args.stateFile, state);
  const status = computeStatus(shards, state, maxParallel);
  process.stderr.write(`${summaryLine(status, chosen.length)}\n`);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`st-build-shard-tasks: ${err.message}\n`);
    process.exit(1);
  }
}
