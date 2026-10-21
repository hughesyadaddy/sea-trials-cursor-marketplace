import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentValidatePlan,
  DEFAULT_ANALYZE_TIMEOUT_MS,
  DEFAULT_BUDGET,
  DEFAULT_TEST_TIMEOUT_MS,
  parseBudget,
  parseAnalyzeTimeoutMs,
  parseTestTimeoutMs,
} from './agent-validate-plan.mjs';

function group(over = {}) {
  return {
    flutterRoot: '/repo/flutter',
    repoRoot: '/repo',
    pkgRel: 'packages/foo',
    pkgCwd: '/repo/flutter/packages/foo',
    lib: ['packages/foo/lib/a.dart'],
    test: [],
    pubspecChanged: false,
    ...over,
  };
}

const phaseTasks = (plan, name) =>
  plan.phases.find((p) => p.name === name).tasks;

test('env parsing: budget / timeouts with defaults and overrides', () => {
  assert.equal(parseBudget({}), DEFAULT_BUDGET);
  assert.equal(parseBudget({ ST_AGENT_VALIDATE_BUDGET: '8' }), 8);
  assert.equal(parseBudget({ ST_AGENT_VALIDATE_BUDGET: '0' }), DEFAULT_BUDGET);
  assert.equal(parseBudget({ ST_AGENT_VALIDATE_BUDGET: '-2' }), DEFAULT_BUDGET);
  assert.equal(parseBudget({ ST_AGENT_VALIDATE_BUDGET: 'x' }), DEFAULT_BUDGET);

  assert.equal(parseAnalyzeTimeoutMs({}), DEFAULT_ANALYZE_TIMEOUT_MS);
  assert.equal(
    parseAnalyzeTimeoutMs({ ST_AGENT_VALIDATE_ANALYZE_TIMEOUT_MS: '1000' }),
    1000,
  );
  assert.equal(parseTestTimeoutMs({}), DEFAULT_TEST_TIMEOUT_MS);
  assert.equal(
    parseTestTimeoutMs({ ST_AGENT_VALIDATE_TEST_TIMEOUT_MS: '2000' }),
    2000,
  );
});

test('one merged analyze chunk per flutter root, whole-budget weight', () => {
  const plan = buildAgentValidatePlan({
    groups: [
      group({ pkgRel: 'packages/foo', lib: ['packages/foo/lib/a.dart'] }),
      group({ pkgRel: 'packages/bar', lib: ['packages/bar/lib/b.dart'] }),
    ],
    env: {},
  });
  const analyze = phaseTasks(plan, 'dart analyze');
  assert.equal(analyze.length, 1, 'packages under one root merge into one process');
  const t = analyze[0];
  assert.equal(t.kind, 'analyze');
  assert.equal(t.cmd, 'dart');
  assert.deepEqual(t.args, [
    'analyze',
    '--fatal-infos',
    'packages/foo/lib/a.dart',
    'packages/bar/lib/b.dart',
  ]);
  assert.equal(t.options.cwd, '/repo/flutter');
  assert.equal(t.weight, DEFAULT_BUDGET);
  assert.equal(t.options.slotWeight, DEFAULT_BUDGET);
  assert.equal(t.options.slotRepoRoot, '/repo');
  assert.equal(t.timeoutMs, DEFAULT_ANALYZE_TIMEOUT_MS);
});

test('separate flutter roots each get their own analyze process', () => {
  const plan = buildAgentValidatePlan({
    groups: [
      group({ flutterRoot: '/a/flutter', repoRoot: '/a', lib: ['packages/foo/lib/a.dart'] }),
      group({ flutterRoot: '/b/flutter', repoRoot: '/b', lib: ['packages/foo/lib/b.dart'] }),
    ],
    env: {},
  });
  assert.equal(phaseTasks(plan, 'dart analyze').length, 2);
});

test('analyze splits into multiple chunks past the chunk size', () => {
  const lib = Array.from({ length: 95 }, (_, i) => `packages/foo/lib/f${i}.dart`);
  const plan = buildAgentValidatePlan({
    groups: [group({ lib })],
    env: {},
    chunkSize: 40,
  });
  const analyze = phaseTasks(plan, 'dart analyze');
  assert.equal(analyze.length, 3, '95 files / 40 => 3 chunks');
  for (const t of analyze) assert.equal(t.weight, DEFAULT_BUDGET);
});

test('flutter test: --concurrency=2, compact reporter, weight 2, no kind', () => {
  const plan = buildAgentValidatePlan({
    groups: [group({ test: ['test/a_test.dart', 'test/b_test.dart'], lib: [] })],
    env: {},
  });
  const tests = phaseTasks(plan, 'flutter test');
  assert.equal(tests.length, 1);
  const t = tests[0];
  assert.equal(t.kind, undefined, 'tests are not cacheable');
  assert.deepEqual(t.args, [
    'test',
    '--concurrency=2',
    '--reporter',
    'compact',
    'test/a_test.dart',
    'test/b_test.dart',
  ]);
  assert.equal(t.weight, 2);
  assert.equal(t.options.slotWeight, 2);
  assert.equal(t.timeoutMs, DEFAULT_TEST_TIMEOUT_MS);
  assert.equal(t.options.cwd, '/repo/flutter/packages/foo');
});

test('pub get runs only when the pubspec changed', () => {
  const plan = buildAgentValidatePlan({
    groups: [
      group({ pubspecChanged: true }),
      group({ pkgRel: 'packages/bar', pubspecChanged: false }),
    ],
    env: {},
  });
  const pubGet = phaseTasks(plan, 'flutter pub get');
  assert.equal(pubGet.length, 1);
  assert.deepEqual(pubGet[0].args, ['pub', 'get']);
  assert.equal(pubGet[0].weight, 1);
});

test('--analyze-only drops tests; --tests-only drops analyze', () => {
  const groups = [group({ lib: ['packages/foo/lib/a.dart'], test: ['test/a_test.dart'] })];

  const analyzeOnly = buildAgentValidatePlan({
    groups,
    flags: { analyzeOnly: true },
    env: {},
  });
  assert.equal(phaseTasks(analyzeOnly, 'dart analyze').length, 1);
  assert.equal(phaseTasks(analyzeOnly, 'flutter test').length, 0);

  const testsOnly = buildAgentValidatePlan({
    groups,
    flags: { testsOnly: true },
    env: {},
  });
  assert.equal(phaseTasks(testsOnly, 'dart analyze').length, 0);
  assert.equal(phaseTasks(testsOnly, 'flutter test').length, 1);
});

test('phases come back in run order: pub get, analyze, test', () => {
  const plan = buildAgentValidatePlan({ groups: [group()], env: {} });
  assert.deepEqual(
    plan.phases.map((p) => p.name),
    ['flutter pub get', 'dart analyze', 'flutter test'],
  );
  assert.equal(plan.budget, DEFAULT_BUDGET);
});
