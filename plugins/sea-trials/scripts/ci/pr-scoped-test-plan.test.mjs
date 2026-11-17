import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CI_FULL_TESTS_LABEL,
  packageDirFromTestRepoRel,
  planPrScopedTestMatrix,
  PR_TEST_SHARD_CAP,
  wantsFullDartTestPlan,
} from './pr-scoped-test-plan.mjs';

test('wantsFullDartTestPlan escape hatches', () => {
  assert.equal(wantsFullDartTestPlan({ GITHUB_EVENT_NAME: 'pull_request' }), false);
  assert.equal(wantsFullDartTestPlan({ CI_FULL_TESTS: '1' }), true);
  assert.equal(wantsFullDartTestPlan({ GITHUB_EVENT_NAME: 'schedule' }), true);
  assert.equal(
    wantsFullDartTestPlan({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
    }),
    true,
  );
  assert.equal(
    wantsFullDartTestPlan({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_PR_LABELS: `other,${CI_FULL_TESTS_LABEL}`,
    }),
    true,
  );
});

test('packageDirFromTestRepoRel parses flutter test paths', () => {
  assert.deepEqual(
    packageDirFromTestRepoRel('flutter/packages/foo/test/bar_test.dart'),
    { packageDir: 'packages/foo', inPkgTest: 'test/bar_test.dart' },
  );
  assert.equal(packageDirFromTestRepoRel('docs/x.md'), null);
});

test('planPrScopedTestMatrix caps shards and sets test_paths for solo bins', () => {
  /** @type {Map<string, string[]>} */
  const testsByPackage = new Map();
  for (let i = 0; i < 8; i += 1) {
    testsByPackage.set(`packages/p${i}`, [`test/p${i}_test.dart`]);
  }
  const nameByDir = new Map(
  [...testsByPackage.keys()].map((d) => [d, d.split('/').pop()]),
  );
  const planned = planPrScopedTestMatrix({ testsByPackage, nameByDir });
  assert.equal(planned.hasWork, true);
  assert.ok(planned.matrix.include.length <= PR_TEST_SHARD_CAP);
  assert.ok(planned.matrix.include.length >= 1);
  for (const row of planned.matrix.include) {
    const pkgs = row.packages.split(',').map((s) => s.trim());
    if (pkgs.length === 1) {
      assert.ok(row.test_paths);
    }
  }
});

test('empty scoped plan → nothing_to_test', () => {
  const planned = planPrScopedTestMatrix({ testsByPackage: new Map() });
  assert.equal(planned.hasWork, false);
  assert.equal(planned.skipLog, 'nothing_to_test');
  assert.deepEqual(planned.matrix.include, []);
});

test('resolvePrScopedTestsByPackage maps lib and test changes', async () => {
  const { resolvePrScopedTestsByPackage } = await import('./pr-scoped-test-plan.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scoped-plan-'));
  const pkg = path.join(root, 'flutter', 'packages', 'demo_pkg');
  fs.mkdirSync(path.join(pkg, 'lib', 'src'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'pubspec.yaml'), 'name: demo_pkg\n');
  fs.writeFileSync(path.join(pkg, 'lib', 'src', 'widget.dart'), '');
  fs.writeFileSync(path.join(pkg, 'test', 'widget_test.dart'), '');
  fs.writeFileSync(path.join(pkg, 'test', 'extra_test.dart'), '');

  const byPkg = resolvePrScopedTestsByPackage({
    repoRoot: root,
    changedFiles: [
      'flutter/packages/demo_pkg/lib/src/widget.dart',
      'flutter/packages/demo_pkg/test/extra_test.dart',
    ],
  });
  assert.deepEqual(byPkg.get('packages/demo_pkg')?.sort(), [
    'test/extra_test.dart',
    'test/widget_test.dart',
  ]);
});

test('before vs after job count for representative diff', () => {
  /** @type {Map<string, string[]>} */
  const testsByPackage = new Map([
    ['packages/a', ['test/a_test.dart']],
    ['packages/b', ['test/b_test.dart']],
    ['packages/c', ['test/c_test.dart']],
  ]);
  const legacyJobCount = testsByPackage.size;
  const scoped = planPrScopedTestMatrix({ testsByPackage });
  assert.equal(legacyJobCount, 3);
  assert.ok(scoped.matrix.include.length < legacyJobCount);
  assert.ok(scoped.matrix.include.length <= PR_TEST_SHARD_CAP);
});