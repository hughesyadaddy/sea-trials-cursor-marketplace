/**
 * Worker telemetry — append-only JSONL of every gate / shard / review
 * loop run, so `st-gate-stats.mjs` can answer "which lane is slow",
 * "how often does analyze fail" and "does the cheap model actually
 * fix lints".
 *
 * One object per run at `telemetryPath()` (see scripts/lib/st-state-dir):
 *
 *   { ts, kind: 'gate'|'shard'|'review-loop', task, phase?, taskKind?,
 *     model?, host: 'cursor'|'claude'|'unknown', ms?, ok, cacheHit?,
 *     killed?, repo, pr?, exitCode?, files?, weight? }
 *
 * `recordRun` never throws and never blocks on anything but a small
 * synchronous append. `ST_GATE_TELEMETRY=0` disables it; test runners
 * (`NODE_TEST_CONTEXT`) are silent unless `ST_GATE_TELEMETRY=1`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { telemetryPath } from '../../lib/st-state-dir.mjs';

export const TELEMETRY_KINDS = Object.freeze(['gate', 'shard', 'review-loop']);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'cursor'|'claude'|'unknown'}
 */
export function detectHost(env = process.env) {
  const keys = Object.keys(env);
  if (env.CURSOR_TRACE_ID || keys.some((k) => k.startsWith('CURSOR_'))) {
    return 'cursor';
  }
  if (
    env.CLAUDE_PLUGIN_ROOT ||
    keys.some((k) => k.startsWith('CLAUDE_CODE'))
  ) {
    return 'claude';
  }
  return 'unknown';
}

/** @param {NodeJS.ProcessEnv} [env] */
export function telemetryEnabled(env = process.env) {
  const raw = (env.ST_GATE_TELEMETRY ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true') return true;
  // Unit tests spawn the real CLIs; keep their runs out of the ledger.
  if (env.NODE_TEST_CONTEXT) return false;
  return true;
}

/**
 * Model hint for a task line: explicit `model`, the push-gate
 * `workerModelHints`, then the `ST_WORKER_MODEL` override.
 *
 * @param {Record<string, unknown> | null | undefined} task
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveModel(task, env = process.env) {
  const hints = task?.workerModelHints;
  const candidate =
    (typeof task?.model === 'string' && task.model) ||
    (hints && typeof hints === 'object' && typeof hints.model === 'string'
      ? hints.model
      : '') ||
    (env.ST_WORKER_MODEL ?? '').trim();
  return candidate || undefined;
}

/** @param {string | null | undefined} repoRoot */
export function repoBasename(repoRoot) {
  if (!repoRoot) return undefined;
  return path.basename(path.resolve(repoRoot)) || undefined;
}

/**
 * Normalise caller fields into one JSONL record. Unknown / undefined
 * fields are dropped so the file stays compact.
 *
 * @param {Record<string, unknown>} fields
 * @param {{ env?: NodeJS.ProcessEnv, now?: Date }} [opts]
 */
export function buildRunRecord(fields, opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const record = {
    ts: now.toISOString(),
    kind: TELEMETRY_KINDS.includes(fields.kind) ? fields.kind : 'gate',
    task: String(fields.task ?? fields.label ?? fields.id ?? 'task'),
    phase: fields.phase,
    taskKind: fields.taskKind,
    model: fields.model ?? resolveModel(fields.taskJson, env),
    host: fields.host ?? detectHost(env),
    ms: Number.isFinite(fields.ms) ? Math.round(fields.ms) : undefined,
    ok: Boolean(fields.ok),
    cacheHit: fields.cacheHit === true ? true : undefined,
    killed: fields.killed === true ? true : undefined,
    repo: fields.repo ?? repoBasename(fields.repoRoot),
    pr: Number.isFinite(fields.pr) ? fields.pr : undefined,
    exitCode: Number.isFinite(fields.exitCode) ? fields.exitCode : undefined,
    files: Number.isFinite(fields.files) ? fields.files : undefined,
    weight: Number.isFinite(fields.weight) ? fields.weight : undefined,
  };
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

/**
 * Append one run. Returns true when a line was written. Never throws.
 *
 * @param {Record<string, unknown>} fields
 * @param {{ env?: NodeJS.ProcessEnv, file?: string, now?: Date }} [opts]
 */
export function recordRun(fields, opts = {}) {
  try {
    const env = opts.env ?? process.env;
    if (!telemetryEnabled(env)) return false;
    const record = buildRunRecord(fields, { env, now: opts.now });
    const file = opts.file ?? telemetryPath({ env });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every parseable record. Missing file → []. Corrupt lines (a
 * torn concurrent append) are skipped, not fatal.
 *
 * @param {string} [file]
 * @returns {Array<Record<string, unknown>>}
 */
export function readRuns(file = telemetryPath()) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const runs = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') runs.push(parsed);
    } catch {
      // torn line
    }
  }
  return runs;
}
