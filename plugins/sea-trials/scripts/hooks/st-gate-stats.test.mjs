import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeStats,
  filterRuns,
  formatStats,
  main,
  parseSince,
  parseStatsArgs,
  percentile,
  renderTable,
} from './st-gate-stats.mjs';

const script = fileURLToPath(new URL('./st-gate-stats.mjs', import.meta.url));
const NOW = Date.parse('2026-09-22T12:00:00.000Z');

function row(overrides) {
  return {
    ts: '2026-09-22T11:00:00.000Z',
    kind: 'gate',
    task: 'dart format --check (3 files)',
    taskKind: 'format',
    host: 'cursor',
    ms: 100,
    ok: true,
    repo: 'sea_trials_universal',
    ...overrides,
  };
}

const SAMPLE = [
  row({ ms: 100 }),
  row({ ms: 300 }),
  row({ ms: 0, cacheHit: true }),
  row({ task: 'dart analyze (chunk 1/1)', taskKind: 'analyze', ms: 60_000, model: 'composer-2.5' }),
  row({ task: 'dart analyze (chunk 2/2)', taskKind: 'analyze', ms: 120_000, ok: false, exitCode: 1, model: 'composer-2.5' }),
  row({ kind: 'shard', task: 'ui', taskKind: 'mechanical', ms: 5_000, model: 'composer-2.5-fast' }),
  row({ kind: 'shard', task: 'core', taskKind: 'code', ms: undefined, ok: false, model: 'composer-2.5-fast' }),
  row({
    kind: 'review-loop',
    task: 'iteration',
    taskKind: undefined,
    ms: 30_000,
    ts: '2026-09-10T00:00:00.000Z',
  }),
];

function tmpLedger(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-stats-'));
  const file = path.join(dir, 'gate-runs.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, file };
}

test('parseStatsArgs: flags, --key=value, kind validation', () => {
  const args = parseStatsArgs(['--since', '7d', '--kind=shard', '--json', '--file', 'x.jsonl']);
  assert.deepEqual(args, { since: '7d', kind: 'shard', json: true, file: 'x.jsonl', help: false });
  assert.throws(() => parseStatsArgs(['--kind', 'nope']), /--kind must be one of/);
  assert.equal(parseStatsArgs(['-h']).help, true);
});

test('parseSince: relative windows, ISO dates, garbage', () => {
  assert.equal(parseSince('7d', NOW), NOW - 7 * 86_400_000);
  assert.equal(parseSince('24h', NOW), NOW - 86_400_000);
  assert.equal(parseSince('30m', NOW), NOW - 30 * 60_000);
  assert.equal(parseSince('2w', NOW), NOW - 14 * 86_400_000);
  assert.equal(parseSince('2026-09-01', NOW), Date.parse('2026-09-01'));
  assert.equal(parseSince(null, NOW), null);
  assert.throws(() => parseSince('yesterday', NOW), /cannot parse/);
});

test('filterRuns: by kind and by since', () => {
  assert.equal(filterRuns(SAMPLE, { kind: 'shard' }).length, 2);
  const recent = filterRuns(SAMPLE, { since: parseSince('7d', NOW) });
  assert.equal(recent.length, SAMPLE.length - 1, 'the 12-day-old review-loop row drops');
  assert.equal(filterRuns(SAMPLE, {}).length, SAMPLE.length);
});

test('percentile is nearest-rank', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('computeStats: per kind, per model, slowest, total minutes', () => {
  const stats = computeStats(SAMPLE);
  assert.equal(stats.total, SAMPLE.length);

  const byGroup = Object.fromEntries(stats.byTaskKind.map((r) => [r.group, r]));
  assert.deepEqual(Object.keys(byGroup).sort(), [
    'gate/analyze',
    'gate/format',
    'review-loop/iteration',
    'shard/code',
    'shard/mechanical',
  ]);
  assert.equal(byGroup['gate/format'].count, 3);
  assert.equal(byGroup['gate/format'].cacheHits, 1);
  assert.equal(byGroup['gate/format'].cacheHitRate, 1 / 3);
  assert.equal(byGroup['gate/format'].failRate, 0);
  assert.equal(byGroup['gate/format'].p50, 100);
  assert.equal(byGroup['gate/format'].max, 300);
  assert.equal(byGroup['gate/analyze'].fail, 1);
  assert.equal(byGroup['gate/analyze'].failRate, 0.5);
  assert.equal(byGroup['gate/analyze'].p95, 120_000);
  assert.equal(byGroup['shard/code'].timed, 0, 'rows without ms still count');
  assert.equal(byGroup['shard/code'].p50, null);

  const byModel = Object.fromEntries(stats.byModel.map((r) => [r.model, r]));
  assert.equal(byModel['composer-2.5'].count, 2);
  assert.equal(byModel['composer-2.5'].successRate, 0.5);
  assert.equal(byModel['composer-2.5'].medianMs, 60_000);
  assert.equal(byModel['composer-2.5-fast'].successRate, 0.5);
  assert.equal(byModel['composer-2.5-fast'].medianMs, 5_000);

  assert.equal(stats.slowest[0].task, 'dart analyze (chunk 2/2)');
  assert.equal(stats.slowest[0].ok, false);
  assert.ok(stats.slowest.every((r) => r.ms > 0), 'cache hits are not "slow"');
  // 100 + 300 + 0 + 60000 + 120000 ms of gate time.
  assert.equal(stats.totalGateMinutes, 3);
});

test('computeStats on nothing is all zeros', () => {
  const stats = computeStats([]);
  assert.deepEqual(stats, {
    total: 0,
    byTaskKind: [],
    byModel: [],
    slowest: [],
    totalGateMinutes: 0,
  });
});

test('renderTable aligns: first column left, the rest right', () => {
  const out = renderTable(['kind', 'count'], [['gate/format', 3], ['x', 120]]);
  assert.equal(out, 'kind         count\ngate/format      3\nx              120');
});

test('formatStats: empty ledger message and populated tables', () => {
  const empty = formatStats(computeStats([]), { since: '7d' });
  assert.match(empty, /0 run\(s\) \(since 7d\)/);
  assert.match(empty, /no runs recorded yet/);

  const text = formatStats(computeStats(SAMPLE), { kind: null });
  assert.match(text, /by task kind/);
  assert.match(text, /gate\/analyze\s+2\s+50%\s+0%\s+1\.0m\s+2\.0m\s+2\.0m/);
  assert.match(text, /by model/);
  assert.match(text, /composer-2\.5-fast\s+2\s+50%\s+5\.0s/);
  assert.match(text, /slowest \d+/);
  assert.match(text, /total gate minutes: 3/);
});

test('main: --file + --json emits the stats object; missing file is graceful', () => {
  const { file, dir } = tmpLedger(SAMPLE);
  let out = '';
  const code = main(['--file', file, '--json', '--kind', 'gate'], {
    now: NOW,
    write: (s) => (out += s),
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 5);
  assert.equal(parsed.kind, 'gate');
  assert.equal(parsed.file, file);

  out = '';
  main(['--file', path.join(dir, 'missing.jsonl')], { now: NOW, write: (s) => (out += s) });
  assert.match(out, /0 run\(s\)/);
});

test('CLI: runs end to end, rejects a bad --kind', () => {
  const { file } = tmpLedger(SAMPLE);
  const ok = spawnSync(process.execPath, [script, '--file', file, '--since', '30d'], {
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /gate telemetry: \d+ run\(s\) \(since 30d\)/);
  assert.match(ok.stdout, /by task kind/);

  const bad = spawnSync(process.execPath, [script, '--kind', 'bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--kind must be one of/);
});
