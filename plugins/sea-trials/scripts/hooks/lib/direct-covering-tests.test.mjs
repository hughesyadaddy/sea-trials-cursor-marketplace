import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  candidateDirectTestRels,
  enforceDirectTestContract,
  existingDirectTestsForLib,
  testDirectlyCoversLib,
} from './direct-covering-tests.mjs';

test('candidateDirectTestRels mirrors lib path', () => {
  assert.deepEqual(candidateDirectTestRels('lib/foo.dart'), ['test/foo_test.dart']);
  assert.deepEqual(candidateDirectTestRels('lib/src/bar.dart'), [
    'test/src/bar_test.dart',
    'test/bar_test.dart',
  ]);
});

test('testDirectlyCoversLib accepts convention pairs', () => {
  assert.equal(testDirectlyCoversLib('lib/a.dart', 'test/a_test.dart'), true);
  assert.equal(testDirectlyCoversLib('lib/a.dart', 'test/b_test.dart'), false);
});

test('enforceDirectTestContract blocks lib without on-disk covering test', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-direct-test-'));
  const flutterRoot = path.join(tmp, 'flutter', 'packages', 'pkg');
  fs.mkdirSync(path.join(flutterRoot, 'lib'), { recursive: true });
  const libPath = path.join(flutterRoot, 'lib', 'widget.dart');
  fs.writeFileSync(libPath, '// widget\n');

  const groups = new Map([
    [
      'key',
      {
        pkgRel: 'packages/pkg',
        lib: ['lib/widget.dart'],
        test: [],
        resolved: { repoRoot: tmp, flutterRoot: path.join(tmp, 'flutter') },
      },
    ],
  ]);
  const check = enforceDirectTestContract({
    groups,
    explicitRepoRelPaths: new Set(['flutter/packages/pkg/lib/widget.dart']),
  });
  assert.equal(check.ok, false);
  assert.match(check.message, /No direct covering test/);
});

test('lib-only explicit set runs no tests in plan inputs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-direct-test-'));
  const pkgCwd = path.join(tmp, 'flutter', 'packages', 'pkg');
  fs.mkdirSync(path.join(pkgCwd, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(pkgCwd, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pkgCwd, 'lib', 'a.dart'), '// a\n');
  fs.writeFileSync(path.join(pkgCwd, 'test', 'a_test.dart'), 'void main() {}\n');

  const groups = new Map([
    [
      'key',
      {
        pkgRel: 'packages/pkg',
        lib: ['lib/a.dart'],
        test: [],
        resolved: {
          repoRoot: tmp,
          flutterRoot: path.join(tmp, 'flutter'),
        },
      },
    ],
  ]);
  const check = enforceDirectTestContract({
    groups,
    explicitRepoRelPaths: new Set(['flutter/packages/pkg/lib/a.dart']),
  });
  assert.equal(check.ok, true);
  assert.deepEqual(
    existingDirectTestsForLib(pkgCwd, 'lib/a.dart'),
    ['test/a_test.dart'],
  );
});
