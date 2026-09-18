import assert from 'node:assert/strict';
import test from 'node:test';

import { getRepoRoot } from './pr-review-lib.mjs';
import {
  buildPushGatePlan,
  serializePushGateTask,
  PHASE_DIRTY,
} from './push-gate-tasks.mjs';

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
  });
  assert.equal(line.source, 'push-gate');
  assert.equal(line.phase, PHASE_DIRTY);
  assert.equal(line.cmd, 'dart');
  assert.deepEqual(line.args, ['format', '--check', 'foo.dart']);
  assert.equal(line.cwd, '/repo/flutter');
});

test('buildPushGatePlan returns groups for ci-only phase', async () => {
  const plan = await buildPushGatePlan({
    repoRoot: getRepoRoot(),
    prNumber: null,
    base: 'origin/dev',
    phases: new Set(['ci']),
  });
  assert.equal(plan.ok, true);
  assert.ok(Array.isArray(plan.groups));
});
