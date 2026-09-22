#!/usr/bin/env node
/**
 * Gate telemetry report — reads the JSONL written by lib/gate-telemetry
 * (`~/.cache/sea-trials/telemetry/gate-runs.jsonl`, or under
 * `ST_STATE_DIR`) and answers: which lanes are slow, how often each
 * fails, how much the content-hash cache saves, and whether the cheap
 * worker model actually fixes lints.
 *
 *   node $ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs
 *   node $ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs --since 7d
 *   node $ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs --since 24h --kind gate
 *   node $ST_PLUGIN_ROOT/scripts/hooks/st-gate-stats.mjs --since 2026-09-01 --json
 *
 * Consuming repos delegate `pnpm st-gate-stats -- [flags]` to this file
 * through `.husky/st-plugin-run.sh`; no orchestration lives here.
 *
 * Tables: per task kind (p50 / p95 / max ms, count, fail rate, cache-hit
 * rate), per model (success rate, median ms), top 10 slowest task
 * labels, total gate minutes. `--json` emits the same as one object.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readRuns, TELEMETRY_KINDS } from './lib/gate-telemetry.mjs';
import { telemetryPath } from '../lib/st-state-dir.mjs';

const SLOWEST_LIMIT = 10;

/**
 * @param {string[]} argv
 * @returns {{ since: string|null, kind: string|null, json: boolean,
 *   file: string|null, help: boolean }}
 */
export function parseStatsArgs(argv) {
  const out = { since: null, kind: null, json: false, file: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') out.since = argv[++i] ?? null;
    else if (arg.startsWith('--since=')) out.since = arg.slice('--since='.length);
    else if (arg === '--kind') out.kind = argv[++i] ?? null;
    else if (arg.startsWith('--kind=')) out.kind = arg.slice('--kind='.length);
    else if (arg === '--file') out.file = argv[++i] ?? null;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  if (out.kind && !TELEMETRY_KINDS.includes(out.kind)) {
    throw new Error(
      `--kind must be one of: ${TELEMETRY_KINDS.join(', ')} (got ${out.kind})`,
    );
  }
  return out;
}

/**
 * `7d`, `24h`, `30m`, or an ISO date / datetime → epoch ms cutoff.
 *
 * @param {string | null | undefined} raw
 * @param {number} [now]
 * @returns {number | null}
 */
export function parseSince(raw, now = Date.now()) {
  if (!raw) return null;
  const text = String(raw).trim();
  const rel = /^(\d+(?:\.\d+)?)([smhdw])$/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms =
      unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : unit === 'd'
              ? 86_400_000
              : 7 * 86_400_000;
    return now - n * ms;
  }
  const abs = Date.parse(text);
  if (Number.isFinite(abs)) return abs;
  throw new Error(`--since: cannot parse "${raw}" (use 7d, 24h, or a date)`);
}

/**
 * @param {Array<Record<string, unknown>>} runs
 * @param {{ since?: number | null, kind?: string | null }} [filter]
 */
export function filterRuns(runs, filter = {}) {
  return runs.filter((run) => {
    if (filter.kind && run.kind !== filter.kind) return false;
    if (filter.since != null) {
      const ts = Date.parse(String(run.ts ?? ''));
      if (!Number.isFinite(ts) || ts < filter.since) return false;
    }
    return true;
  });
}

/**
 * Nearest-rank percentile over a sorted ascending array.
 *
 * @param {number[]} sorted
 * @param {number} p 0–100
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

function msOf(run) {
  const ms = Number(run.ms);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function groupLabel(run) {
  const kind = String(run.kind ?? 'gate');
  const sub =
    typeof run.taskKind === 'string' && run.taskKind
      ? run.taskKind
      : kind === 'review-loop' && typeof run.task === 'string'
        ? run.task
        : null;
  return sub ? `${kind}/${sub}` : kind;
}

function ratio(part, whole) {
  return whole > 0 ? part / whole : 0;
}

/**
 * @param {Array<Record<string, unknown>>} runs already filtered
 */
export function computeStats(runs) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byGroup = new Map();
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byModel = new Map();
  let totalGateMs = 0;

  for (const run of runs) {
    const group = groupLabel(run);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(run);
    if (typeof run.model === 'string' && run.model) {
      if (!byModel.has(run.model)) byModel.set(run.model, []);
      byModel.get(run.model).push(run);
    }
    if (run.kind === 'gate') totalGateMs += msOf(run) ?? 0;
  }

  const byTaskKind = [...byGroup.entries()]
    .map(([group, rows]) => {
      const times = rows.map(msOf).filter((v) => v !== null).sort((a, b) => a - b);
      const fails = rows.filter((r) => r.ok === false).length;
      const cacheHits = rows.filter((r) => r.cacheHit === true).length;
      return {
        group,
        count: rows.length,
        fail: fails,
        failRate: ratio(fails, rows.length),
        cacheHits,
        cacheHitRate: ratio(cacheHits, rows.length),
        p50: percentile(times, 50),
        p95: percentile(times, 95),
        max: times.length ? times[times.length - 1] : null,
        timed: times.length,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));

  const byModelRows = [...byModel.entries()]
    .map(([model, rows]) => {
      const times = rows.map(msOf).filter((v) => v !== null).sort((a, b) => a - b);
      const ok = rows.filter((r) => r.ok === true).length;
      return {
        model,
        count: rows.length,
        ok,
        successRate: ratio(ok, rows.length),
        medianMs: percentile(times, 50),
      };
    })
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  const slowest = runs
    .filter((r) => msOf(r) !== null && r.cacheHit !== true)
    .sort((a, b) => msOf(b) - msOf(a))
    .slice(0, SLOWEST_LIMIT)
    .map((r) => ({
      task: String(r.task ?? ''),
      group: groupLabel(r),
      ms: msOf(r),
      ok: r.ok === true,
      ts: r.ts,
      model: r.model,
    }));

  return {
    total: runs.length,
    byTaskKind,
    byModel: byModelRows,
    slowest,
    totalGateMinutes: Math.round((totalGateMs / 60_000) * 10) / 10,
  };
}

// ---------------------------------------------------------------------
// text rendering
// ---------------------------------------------------------------------

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtPct(r) {
  return `${Math.round(r * 100)}%`;
}

/**
 * Plain-text table with left-aligned first column and right-aligned
 * numeric columns.
 *
 * @param {string[]} headers
 * @param {Array<Array<string | number>>} rows
 */
export function renderTable(headers, rows) {
  const cells = [headers, ...rows].map((row) => row.map((c) => String(c)));
  const widths = headers.map((_, i) =>
    Math.max(...cells.map((row) => row[i]?.length ?? 0)),
  );
  return cells
    .map((row) =>
      row
        .map((cell, i) =>
          i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]),
        )
        .join('  '),
    )
    .join('\n');
}

/**
 * @param {ReturnType<typeof computeStats>} stats
 * @param {{ file?: string, since?: string | null, kind?: string | null }} [ctx]
 */
export function formatStats(stats, ctx = {}) {
  const lines = [];
  const scope = [
    ctx.since ? `since ${ctx.since}` : 'all time',
    ctx.kind ? `kind=${ctx.kind}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  lines.push(`gate telemetry: ${stats.total} run(s) (${scope})`);
  if (ctx.file) lines.push(`source: ${ctx.file}`);
  if (stats.total === 0) {
    lines.push('no runs recorded yet — run a gate and come back.');
    return lines.join('\n');
  }

  lines.push('', 'by task kind');
  lines.push(
    renderTable(
      ['kind', 'count', 'fail', 'cache', 'p50', 'p95', 'max'],
      stats.byTaskKind.map((r) => [
        r.group,
        r.count,
        fmtPct(r.failRate),
        fmtPct(r.cacheHitRate),
        fmtMs(r.p50),
        fmtMs(r.p95),
        fmtMs(r.max),
      ]),
    ),
  );

  lines.push('', 'by model');
  if (stats.byModel.length === 0) {
    lines.push('(no runs carried a model hint)');
  } else {
    lines.push(
      renderTable(
        ['model', 'count', 'success', 'median'],
        stats.byModel.map((r) => [
          r.model,
          r.count,
          fmtPct(r.successRate),
          fmtMs(r.medianMs),
        ]),
      ),
    );
  }

  lines.push('', `slowest ${Math.min(SLOWEST_LIMIT, stats.slowest.length)}`);
  if (stats.slowest.length === 0) {
    lines.push('(no timed runs)');
  } else {
    lines.push(
      renderTable(
        ['task', 'kind', 'ms', 'ok'],
        stats.slowest.map((r) => [
          r.task.length > 60 ? `${r.task.slice(0, 57)}...` : r.task,
          r.group,
          fmtMs(r.ms),
          r.ok ? 'yes' : 'no',
        ]),
      ),
    );
  }

  lines.push('', `total gate minutes: ${stats.totalGateMinutes}`);
  return lines.join('\n');
}

function printHelp() {
  process.stdout.write(`\
Gate telemetry report.

  node st-gate-stats.mjs [--since 7d|24h|2026-09-01] [--kind gate|shard|review-loop] [--json]
  node st-gate-stats.mjs --file <gate-runs.jsonl>   # read another ledger

Source: ${telemetryPath()}
Disable collection with ST_GATE_TELEMETRY=0.
`);
}

/**
 * @param {string[]} argv
 * @param {{ now?: number, write?: (s: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const write = io.write ?? ((s) => process.stdout.write(s));
  const args = parseStatsArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const file = args.file ? path.resolve(args.file) : telemetryPath();
  const since = parseSince(args.since, io.now);
  const runs = filterRuns(readRuns(file), { since, kind: args.kind });
  const stats = computeStats(runs);
  if (args.json) {
    write(
      `${JSON.stringify(
        { file, since: args.since ?? null, kind: args.kind ?? null, ...stats },
        null,
        2,
      )}\n`,
    );
  } else {
    write(`${formatStats(stats, { file, since: args.since, kind: args.kind })}\n`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`st-gate-stats: ${err.message}\n`);
    process.exit(1);
  }
}
