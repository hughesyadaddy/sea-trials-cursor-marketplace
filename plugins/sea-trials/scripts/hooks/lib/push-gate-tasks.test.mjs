import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { getRepoRoot } from './pr-review-lib.mjs';
import { coalesceGroups } from './push-gate-run.mjs';
import {
  buildPushGatePlan,
  serializePushGateTask,
  workerModelHints,
  PHASE_DIRTY,
  PHASE_PREPUSH,
} from './push-gate-tasks.mjs';

/**
 * The CI phase needs the consuming repo's `scripts/ci/*` lane registry
 * and an `origin/dev` ref. Outside that repo (plugin CI, a fresh clone
 * of the marketplace) the integration test is skipped, not failed: the
 * plugin must test green standalone.
 */
function appRepoAvailable() {
  let root;
  try {
    root = getRepoRoot();
  } catch {
    return false;
  }
  if (!fs.existsSync(path.join(root, 'scripts/ci/pr-lane-registry.mjs'))) {
    return false;
  }
  const dev = spawnSync('git', ['rev-parse', '--verify', 'origin/dev'], {
    cwd: root,
    encoding: 'utf8',
  });
  return dev.status === 0;
}

test('serializePushGateTask emits subagent-runnable JSON', () => {
  const line = serializePushGateTask({
    phase: PHASE_DIRTY,
    group: 1,
    parallel: true,
    task: {
      label: 'dart format --check',
      cmd: 'dart',
      args: ['format', '--check', 'foo.dart'],
      options: { cwd: '/repo/flutter' },
      weight: 1,
    },
    repoRoot: '/repo',
    index: 1,
    env: {},
    caps: null,
  });
  assert.equal(line.source, 'push-gate');
  assert.equal(line.phase, PHASE_DIRTY);
  assert.equal(line.cmd, 'dart');
  assert.deepEqual(line.args, ['format', '--check', 'foo.dart']);
  assert.equal(line.cwd, '/repo/flutter');
  // Fan-out workers are mechanical: cheap tier on both hosts. With no
  // probe file the static default is used and flagged unverified.
  assert.equal(line.subagent_type, 'generalPurpose');
  assert.equal(line.model, 'composer-2.5-fast');
  assert.equal(line.claudeModel, 'haiku');
  assert.equal(line.modelVerified, false);
  assert.equal(line.modelSource, 'static-fallback');
});

test('serializePushGateTask uses the probe list when present', () => {
  const caps = {
    host: 'cursor',
    cursor: {
      models: ['inherit', 'grok-4.7-high-fast', 'composer-2.5'],
      source: 'agent --list-models',
      verified: true,
    },
    claude: {
      models: ['inherit', 'haiku', 'sonnet', 'opus'],
      source: 'claude cli aliases',
      verified: true,
    },
  };
  const line = serializePushGateTask({
    phase: PHASE_DIRTY,
    group: 1,
    parallel: true,
    task: { label: 'x', cmd: 'true', args: [] },
    repoRoot: '/repo',
    index: 1,
    env: {},
    caps,
  });
  assert.equal(line.model, 'grok-4.7-high-fast', 'closest *-fast slug');
  assert.equal(line.claudeModel, 'haiku');
  assert.equal(line.modelVerified, true);
  assert.equal(line.modelSource, 'probe');
});

test('workerModelHints honours env overrides and reads the probe file', () => {
  assert.deepEqual(
    workerModelHints(
      {
        ST_WORKER_MODEL: 'gpt-5.6-luna-fast',
        ST_WORKER_MODEL_CLAUDE: 'sonnet',
      },
      null,
    ),
    {
      model: 'gpt-5.6-luna-fast',
      claudeModel: 'sonnet',
      modelVerified: false,
      modelSource: 'env',
    },
  );
  assert.deepEqual(workerModelHints({}, null), {
    model: 'composer-2.5-fast',
    claudeModel: 'haiku',
    modelVerified: false,
    modelSource: 'static-fallback',
  });

  // `caps` omitted → read hostCapabilitiesPath() (ST_STATE_DIR here).
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'st-'));
  const file = path.join(root, 'host', 'capabilities.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      host: 'cursor',
      cursor: {
        models: ['inherit', 'composer-2.5-fast'],
        source: 'agent --list-models',
        verified: true,
      },
    }),
  );
  const fromDisk = workerModelHints({ ST_STATE_DIR: root });
  assert.equal(fromDisk.model, 'composer-2.5-fast');
  assert.equal(fromDisk.modelVerified, true);
  assert.equal(fromDisk.modelSource, 'probe');
  fs.rmSync(root, { recursive: true, force: true });
});

test('coalesceGroups pools consecutive parallel groups and dedupes', () => {
  const analyze = {
    label: 'dart analyze (chunk)',
    cmd: 'dart',
    args: ['analyze', 'packages/a'],
    options: { cwd: '/repo/flutter' },
    weight: 3,
  };
  const groups = [
    {
      id: 'g1',
      phase: PHASE_DIRTY,
      parallel: true,
      tasks: [
        analyze,
        {
          label: 'flutter test',
          cmd: 'flutter',
          args: ['test', 'x_test.dart'],
          options: { cwd: '/repo/flutter/packages/a' },
        },
      ],
    },
    {
      id: 'g2',
      phase: PHASE_PREPUSH,
      parallel: true,
      tasks: [
        analyze,
        {
          label: 'dart format',
          cmd: 'dart',
          args: ['format', 'a.dart'],
          options: { cwd: '/repo/flutter' },
        },
      ],
    },
    {
      id: 'g3',
      phase: 'ci',
      parallel: false,
      tasks: [{ label: 'melos bootstrap', cmd: 'melos', args: ['bs'] }],
    },
    {
      id: 'g4',
      phase: 'ci',
      parallel: true,
      tasks: [{ label: 'lane', cmd: 'node', args: ['run-lane.mjs'] }],
    },
  ];

  const pools = coalesceGroups(groups, '/repo');
  assert.equal(pools.length, 3, 'dirty+prepush pooled; bootstrap barrier');
  assert.deepEqual(pools[0].phases, [PHASE_DIRTY, PHASE_PREPUSH]);
  assert.equal(pools[0].parallel, true);
  // The analyze chunk planned by both phases runs once.
  assert.equal(pools[0].tasks.length, 3);
  assert.equal(pools.dedupedCount, 1);
  assert.equal(pools[1].parallel, false);
  assert.equal(pools[1].tasks[0].label, 'melos bootstrap');
  assert.equal(pools[2].tasks[0].phase, 'ci');
});

test(
  'buildPushGatePlan returns groups for ci-only phase',
  { skip: !appRepoAvailable() && 'requires the Sea Trials checkout' },
  async () => {
    const plan = await buildPushGatePlan({
      repoRoot: getRepoRoot(),
      prNumber: null,
      base: 'origin/dev',
      phases: new Set(['ci']),
    });
    assert.equal(plan.ok, true);
    assert.ok(Array.isArray(plan.groups));
  },
);

test('buildPushGatePlan ci phase degrades without a lane registry', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'st-'));
  const plan = await buildPushGatePlan({
    repoRoot: root,
    prNumber: null,
    base: 'HEAD',
    phases: new Set(['ci']),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.groups.length, 0);
  assert.match(plan.reminders.join('\n'), /PR CI lanes skipped/);
  fs.rmSync(root, { recursive: true, force: true });
});
