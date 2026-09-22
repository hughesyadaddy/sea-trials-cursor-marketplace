import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRunRecord,
  detectHost,
  readRuns,
  recordRun,
  resolveModel,
  telemetryEnabled,
} from './gate-telemetry.mjs';
import { telemetryPath } from '../../lib/st-state-dir.mjs';

function tmpStateEnv(prefix = 'st-telemetry-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, env: { ST_STATE_DIR: dir, ST_GATE_TELEMETRY: '1' } };
}

test('detectHost: cursor, claude, unknown', () => {
  assert.equal(detectHost({ CURSOR_TRACE_ID: 'abc' }), 'cursor');
  assert.equal(detectHost({ CURSOR_AGENT: '1' }), 'cursor');
  assert.equal(detectHost({ CLAUDE_PLUGIN_ROOT: '/x' }), 'claude');
  assert.equal(detectHost({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'claude');
  assert.equal(detectHost({ PATH: '/bin' }), 'unknown');
});

test('telemetryEnabled: env switch and test-runner silence', () => {
  assert.equal(telemetryEnabled({}), true);
  assert.equal(telemetryEnabled({ ST_GATE_TELEMETRY: '0' }), false);
  assert.equal(telemetryEnabled({ ST_GATE_TELEMETRY: 'false' }), false);
  assert.equal(telemetryEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.equal(
    telemetryEnabled({ NODE_TEST_CONTEXT: 'child-v8', ST_GATE_TELEMETRY: '1' }),
    true,
  );
});

test('resolveModel: task model, workerModelHints, then env', () => {
  assert.equal(resolveModel({ model: 'composer-2.5-fast' }, {}), 'composer-2.5-fast');
  assert.equal(
    resolveModel({ workerModelHints: { model: 'haiku' } }, {}),
    'haiku',
  );
  assert.equal(resolveModel({}, { ST_WORKER_MODEL: 'grok' }), 'grok');
  assert.equal(resolveModel({}, {}), undefined);
  assert.equal(resolveModel(null, {}), undefined);
});

test('buildRunRecord normalises fields and drops undefined', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');
  const record = buildRunRecord(
    {
      kind: 'gate',
      task: 'dart analyze (chunk 1/1)',
      taskKind: 'analyze',
      ms: 1234.6,
      ok: 1,
      cacheHit: false,
      killed: false,
      repoRoot: '/tmp/some/sea_trials_universal',
      pr: 42,
      exitCode: 0,
      weight: 3,
      taskJson: { model: 'composer-2.5' },
    },
    { env: { CURSOR_TRACE_ID: 'x' }, now },
  );
  assert.deepEqual(record, {
    ts: '2026-09-22T12:00:00.000Z',
    kind: 'gate',
    task: 'dart analyze (chunk 1/1)',
    taskKind: 'analyze',
    model: 'composer-2.5',
    host: 'cursor',
    ms: 1235,
    ok: true,
    repo: 'sea_trials_universal',
    pr: 42,
    exitCode: 0,
    weight: 3,
  });
  assert.equal(buildRunRecord({ kind: 'nope', ok: false }, { env: {} }).kind, 'gate');
  assert.equal(buildRunRecord({ kind: 'shard', ok: true }, { env: {} }).kind, 'shard');
});

test('recordRun appends JSONL under ST_STATE_DIR and readRuns round-trips', () => {
  const { dir, env } = tmpStateEnv();
  assert.equal(
    recordRun({ kind: 'gate', task: 'a', ms: 10, ok: true }, { env }),
    true,
  );
  assert.equal(
    recordRun(
      { kind: 'review-loop', task: 'iteration', ms: 20, ok: false, pr: 7 },
      { env },
    ),
    true,
  );
  const file = telemetryPath({ env });
  assert.ok(file.startsWith(dir));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  // A torn concurrent append must not poison the reader.
  fs.appendFileSync(file, '{"ts":"2026-09-22T00:00:00Z","kind":"ga');
  const runs = readRuns(file);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].task, 'a');
  assert.equal(runs[1].pr, 7);
  assert.equal(runs[1].ok, false);
});

test('recordRun is silent when disabled and never throws on fs errors', () => {
  const { dir, env } = tmpStateEnv();
  assert.equal(
    recordRun({ kind: 'gate', task: 'x', ok: true }, { env: { ...env, ST_GATE_TELEMETRY: '0' } }),
    false,
  );
  assert.equal(fs.existsSync(telemetryPath({ env })), false);
  // Point the ledger at a directory: append fails, caller still fine.
  const asDir = path.join(dir, 'ledger-dir');
  fs.mkdirSync(asDir);
  assert.equal(
    recordRun({ kind: 'gate', task: 'x', ok: true }, { env, file: asDir }),
    false,
  );
});

test('readRuns on a missing file is an empty list', () => {
  const { dir } = tmpStateEnv();
  assert.deepEqual(readRuns(path.join(dir, 'nope.jsonl')), []);
});
