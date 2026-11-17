import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, runTestShard } from './dart-test-run-shard.mjs';
import { parseTestPathsMap } from './pr-scoped-test-plan.mjs';

test('parseArgs accepts test_paths_map', () => {
  assert.deepEqual(
    parseArgs([
      '--base',
      'origin/main',
      '--packages',
      'packages/a,packages/b',
      '--test-paths-map',
      '{"packages/a":"test/a_test.dart","packages/b":"test/b_test.dart"}',
    ]),
    {
      base: 'origin/main',
      packages: 'packages/a,packages/b',
      testPaths: undefined,
      testPathsMap:
        '{"packages/a":"test/a_test.dart","packages/b":"test/b_test.dart"}',
    },
  );
});

test('parseTestPathsMap rejects invalid JSON', () => {
  assert.throws(() => parseTestPathsMap('{'));
});

test('runTestShard refuses multi-package without scoped map', () => {
  assert.throws(
    () =>
      runTestShard({
        base: 'origin/main',
        packages: 'packages/a,packages/b',
        repoRoot: '/tmp',
      }),
    /refusing whole-package run/,
  );
});

test('runTestShard refuses map missing a listed package', () => {
  assert.throws(
    () =>
      runTestShard({
        base: 'origin/main',
        packages: 'packages/a,packages/b',
        testPathsMap: JSON.stringify({ 'packages/a': 'test/a_test.dart' }),
        repoRoot: '/tmp',
      }),
    /missing package packages\/b/,
  );
});