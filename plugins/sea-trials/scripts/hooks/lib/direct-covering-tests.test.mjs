import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAgentValidatePlan } from './agent-validate-plan.mjs';
import {
  candidateDirectTestRels,
  enforceDirectTestContract,
  scheduleDirectCoveringTests,
  testDirectlyCoversLib,
} from './direct-covering-tests.mjs';

test('lib-only change schedules and plans direct conventional test execution', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-direct-sched-'));
  const flutterRoot = path.join(tmp, 'flutter');
  const pkgCwd = path.join(flutterRoot, 'packages', 'pkg');
  fs.mkdirSync(path.join(pkgCwd, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(pkgCwd, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pkgCwd, 'lib', 'a.dart'), 'const x = 1;\n');
  fs.writeFileSync(path.join(pkgCwd, 'test', 'a_test.dart'), 'void main() {}\n');

  const groups = new Map([
    [
      'k',
      {
        pkgRel: 'packages/pkg',
        lib: ['lib/a.dart'],
        test: [],
        resolved: { repoRoot: tmp, flutterRoot },
      },
    ],
  ]);
  scheduleDirectCoveringTests(groups, new Map());
  const group = groups.get('k');
  assert.deepEqual(group.test, ['test/a_test.dart']);

  const plan = buildAgentValidatePlan({
    groups: [
      {
        flutterRoot,
        repoRoot: tmp,
        pkgRel: 'packages/pkg',
        pkgCwd,
        lib: ['packages/pkg/lib/a.dart'],
        test: group.test,
        pubspecChanged: false,
      },
    ],
  });
  const testPhase = plan.phases.find((p) => p.name === 'flutter test');
  assert.equal(testPhase.tasks.length, 1);
  assert.ok(testPhase.tasks[0].args.includes('test/a_test.dart'));
});

test('explicit map covers non-conventional test name', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-direct-explicit-'));
  const flutterRoot = path.join(tmp, 'flutter');
  const pkgCwd = path.join(flutterRoot, 'packages', 'pkg');
  fs.mkdirSync(path.join(pkgCwd, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(pkgCwd, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pkgCwd, 'lib', 'widget.dart'), '// w\n');
  fs.writeFileSync(
    path.join(pkgCwd, 'test', 'widget_behavior_test.dart'),
    'void main() {}\n',
  );

  const libRepo = 'flutter/packages/pkg/lib/widget.dart';
  const testRepo = 'flutter/packages/pkg/test/widget_behavior_test.dart';
  const explicit = new Map([[libRepo, [testRepo]]]);
  assert.equal(
    testDirectlyCoversLib('lib/widget.dart', 'test/widget_behavior_test.dart', {
      repoRelPrefix: 'flutter/packages/pkg/',
      explicitCoveringByLibRepoRel: explicit,
    }),
    true,
  );

  const groups = new Map([
    [
      'k',
      {
        pkgRel: 'packages/pkg',
        lib: ['lib/widget.dart'],
        test: [],
        resolved: { repoRoot: tmp, flutterRoot },
      },
    ],
  ]);
  scheduleDirectCoveringTests(groups, explicit);
  assert.deepEqual(groups.get('k').test, ['test/widget_behavior_test.dart']);
  const check = enforceDirectTestContract({
    groups,
    explicitRepoRelPaths: new Set([libRepo]),
    explicitCoveringByLibRepoRel: explicit,
  });
  assert.equal(check.ok, true);
});

test('enforce blocks lib with no covering test on disk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-direct-block-'));
  const flutterRoot = path.join(tmp, 'flutter', 'packages', 'pkg');
  fs.mkdirSync(path.join(flutterRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(flutterRoot, 'lib', 'solo.dart'), '//\n');
  const groups = new Map([
    [
      'k',
      {
        pkgRel: 'packages/pkg',
        lib: ['lib/solo.dart'],
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
    explicitRepoRelPaths: new Set(['flutter/packages/pkg/lib/solo.dart']),
  });
  assert.equal(check.ok, false);
});

test('candidateDirectTestRels mirrors lib path', () => {
  assert.deepEqual(candidateDirectTestRels('lib/foo.dart'), ['test/foo_test.dart']);
});
