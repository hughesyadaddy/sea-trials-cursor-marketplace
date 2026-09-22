import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_QUARANTINES_PER_PR,
  activeQuarantinesForPr,
  addDartFileSkip,
  addDartTestSkip,
  addNodeTestSkip,
  appendLedger,
  attributeFailure,
  buildIssueBody,
  classify,
  createIssue,
  extractFailingTestNames,
  extractFailureExcerpt,
  extractJobName,
  extractTestFiles,
  formatLedgerTable,
  issueTitle,
  main,
  packageRootOf,
  parseCliArgs,
  parseRunLink,
  protectedMatches,
  readLedger,
  removeDartFileSkip,
  removeDartTestSkip,
  removeNodeTestSkip,
  resolveTestFiles,
  retry,
  simpleDiff,
  skipText,
} from './flake-quarantine.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PR_JSON = JSON.stringify({
  number: 1553,
  url: 'https://github.com/o/r/pull/1553',
  headRefName: 'fix/thing',
  headRefOid: 'abc123',
  baseRefName: 'dev',
});

const RUN_LINK = 'https://github.com/o/r/actions/runs/777/job/888';

const CHECKS_JSON = JSON.stringify([
  { name: 'dart-test', bucket: 'fail', state: 'FAILURE', link: RUN_LINK, workflow: 'PR Checks' },
  { name: 'dart-static', bucket: 'pass', state: 'SUCCESS', link: 'x', workflow: 'PR Checks' },
  { name: 'main-audit', bucket: 'fail', state: 'FAILURE', link: 'y', workflow: 'Main Guardrails' },
]);

const DART_LOG = [
  'dart-test\tRun tests\t2026-09-22T12:00:00.0000000Z 00:03 +12 -1: test/sync/attach_test.dart: narrow attach recovers after wedge [E]',
  'dart-test\tRun tests\t2026-09-22T12:00:00.0000000Z   Expected: <true>',
  'dart-test\tRun tests\t2026-09-22T12:00:00.0000000Z     Actual: <false>',
  'dart-test\tRun tests\t2026-09-22T12:00:00.0000000Z   package:flutter_test/src/matchers.dart 1 expect',
  'dart-test\tRun tests\t2026-09-22T12:00:00.0000000Z   /home/runner/work/r/r/flutter/packages/sync_repo/test/sync/attach_test.dart 42:7 main.<fn>',
  'dart-test\tRun tests\t2026-09-22T12:00:00.0000000Z 00:04 +12 -1: Some tests failed.',
].join('\n');

const NODE_LOG = [
  'ci-script-tests\tnode --test\t2026-09-22T12:00:00.0000000Z ✖ settles after quiet window (12.5ms)',
  'ci-script-tests\tnode --test\t2026-09-22T12:00:00.0000000Z   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
  'ci-script-tests\tnode --test\t2026-09-22T12:00:00.0000000Z   at scripts/hooks/lib/bot-review-settled.test.mjs:88:3',
  'ci-script-tests\tnode --test\t2026-09-22T12:00:00.0000000Z ✖ failing tests:',
].join('\n');

/**
 * Fake runner: routes by command + first args. Records every call.
 * @param {Record<string, (args: string[]) => {status?: number, stdout?: string, stderr?: string}>} handlers
 */
function fakeRunner(handlers) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    for (const [key, fn] of Object.entries(handlers)) {
      const [hcmd, ...hargs] = key.split(' ');
      if (cmd !== hcmd) continue;
      if (hargs.every((a, i) => args[i] === a)) {
        const r = fn(args) ?? {};
        return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    }
    return { status: 1, stdout: '', stderr: `no fake for ${cmd} ${args.join(' ')}` };
  };
  run.calls = calls;
  return run;
}

function baseHandlers({ log = DART_LOG, changed = '', lsFiles = {} } = {}) {
  return {
    'gh pr view': () => ({ stdout: PR_JSON }),
    'gh pr checks': () => ({ stdout: CHECKS_JSON }),
    'gh run view 777 --log-failed': () => ({ stdout: log }),
    'git diff --name-only': () => ({ stdout: changed }),
    'git ls-files': (args) => {
      const pat = args[args.length - 1].replace(/^\*\//, '');
      return { stdout: lsFiles[pat] ?? '' };
    },
    'git remote get-url origin': () => ({ stdout: 'git@github.com:o/r.git\n' }),
  };
}

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-q-'));
  return { dir, env: { ST_STATE_DIR: dir } };
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

test('extractTestFiles finds Dart and Node test paths and strips runner prefix', () => {
  const files = extractTestFiles(DART_LOG);
  assert.deepEqual(files, [
    'test/sync/attach_test.dart',
    'flutter/packages/sync_repo/test/sync/attach_test.dart',
  ]);
  assert.deepEqual(extractTestFiles(NODE_LOG), [
    'scripts/hooks/lib/bot-review-settled.test.mjs',
  ]);
  assert.deepEqual(extractTestFiles(''), []);
});

test('extractFailingTestNames parses [E] and ✖ lines', () => {
  assert.deepEqual(extractFailingTestNames(DART_LOG), [
    'narrow attach recovers after wedge',
  ]);
  assert.deepEqual(extractFailingTestNames(NODE_LOG), [
    'settles after quiet window',
  ]);
});

test('extractJobName reads the gh log job column', () => {
  assert.equal(extractJobName(DART_LOG), 'dart-test');
  assert.equal(extractJobName('plain line'), null);
});

test('extractFailureExcerpt windows around the first marker and caps lines', () => {
  const ex = extractFailureExcerpt(DART_LOG, 3);
  assert.equal(ex.length, 3);
  assert.match(ex[0], /narrow attach recovers/);
  const many = Array.from({ length: 100 }, (_, i) => `line ${i} [E]`).join('\n');
  assert.equal(extractFailureExcerpt(many).length, 40);
});

test('parseRunLink extracts run and job ids', () => {
  assert.deepEqual(parseRunLink(RUN_LINK), { runId: '777', jobId: '888' });
  assert.deepEqual(parseRunLink('https://github.com/o/r/actions/runs/5'), {
    runId: '5',
    jobId: null,
  });
  assert.deepEqual(parseRunLink(null), { runId: null, jobId: null });
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('packageRootOf walks up to pubspec.yaml or falls back to the flutter heuristic', () => {
  const existsSync = (p) => p.endsWith(path.join('flutter', 'packages', 'sync_repo', 'pubspec.yaml'));
  assert.equal(
    packageRootOf('flutter/packages/sync_repo/test/a_test.dart', { repoRoot: '/repo', existsSync }),
    'flutter/packages/sync_repo',
  );
  assert.equal(
    packageRootOf('flutter/apps/client_app/test/a_test.dart'),
    'flutter/apps/client_app',
  );
  assert.equal(packageRootOf('scripts/hooks/lib/x.test.mjs'), 'scripts/hooks/lib');
});

test('attributeFailure: test file itself in diff → attributable', () => {
  const r = attributeFailure({
    testFiles: ['flutter/packages/sync_repo/test/a_test.dart'],
    changedFiles: ['flutter/packages/sync_repo/test/a_test.dart'],
  });
  assert.equal(r.attributable, true);
  assert.match(r.reason, /test file changed/);
});

test('attributeFailure: same package touched → attributable', () => {
  const r = attributeFailure({
    testFiles: ['flutter/packages/sync_repo/test/a_test.dart'],
    changedFiles: ['flutter/packages/sync_repo/lib/src/repo.dart'],
  });
  assert.equal(r.attributable, true);
  assert.match(r.reason, /package changed.*sync_repo/);
});

test('attributeFailure: unrelated package → not attributable', () => {
  const r = attributeFailure({
    testFiles: ['flutter/packages/sync_repo/test/a_test.dart'],
    changedFiles: ['flutter/apps/client_app/lib/main.dart', 'docs/plan/x.md'],
  });
  assert.equal(r.attributable, false);
  assert.match(r.reason, /none of 1 failing test file/);
});

test('attributeFailure: no or unresolved test files → conservative (attributable)', () => {
  assert.equal(attributeFailure({ testFiles: [], changedFiles: ['a'] }).attributable, true);
  const r = attributeFailure({
    testFiles: [],
    unresolvedFiles: ['test/x_test.dart'],
    changedFiles: ['a'],
  });
  assert.equal(r.attributable, true);
  assert.match(r.reason, /could not be resolved/);
});

test('resolveTestFiles maps package-relative log paths via git ls-files', () => {
  const run = fakeRunner({
    'git ls-files': (args) => ({
      stdout: args.at(-1) === '*/test/sync/attach_test.dart'
        ? 'flutter/packages/sync_repo/test/sync/attach_test.dart\n'
        : args.at(-1) === '*/test/dup_test.dart'
          ? 'a/test/dup_test.dart\nb/test/dup_test.dart\n'
          : '',
    }),
  });
  const r = resolveTestFiles(
    ['test/sync/attach_test.dart', 'test/dup_test.dart', 'flutter/x/test/ok_test.dart'],
    {
      repoRoot: '/repo',
      run,
      existsSync: (p) => p.endsWith('flutter/x/test/ok_test.dart'),
    },
  );
  assert.deepEqual(r.resolved, [
    'flutter/packages/sync_repo/test/sync/attach_test.dart',
    'flutter/x/test/ok_test.dart',
  ]);
  assert.deepEqual(r.unresolved, ['test/dup_test.dart']);
});

test('protectedMatches flags integration, scenario, golden, security, auth, payment, billing', () => {
  assert.ok(protectedMatches('flutter/apps/client_app/integration_test/x_test.dart').length);
  assert.ok(protectedMatches('scenario_stg01_test.dart').length);
  assert.ok(protectedMatches('lib/x_test.dart', 'renders golden').length);
  assert.ok(protectedMatches('test/security_rules_test.dart').length);
  assert.ok(protectedMatches('test/auth_bloc_test.dart').length);
  assert.ok(protectedMatches('test/payment_test.dart').length);
  assert.ok(protectedMatches('test/billing_test.dart').length);
  assert.deepEqual(protectedMatches('test/sync/attach_test.dart', 'recovers'), []);
  assert.equal(MAX_QUARANTINES_PER_PR, 2);
});

// ---------------------------------------------------------------------------
// classify (fake gh)
// ---------------------------------------------------------------------------

test('classify: not attributable when failing test package is outside the diff', () => {
  const run = fakeRunner(
    baseHandlers({
      changed: 'flutter/apps/client_app/lib/main.dart\n',
      lsFiles: {
        'test/sync/attach_test.dart': 'flutter/packages/sync_repo/test/sync/attach_test.dart\n',
      },
    }),
  );
  const r = classify({
    prNumber: 1553,
    repoRoot: '/repo',
    run,
    existsSync: (p) => p.endsWith('flutter/packages/sync_repo/test/sync/attach_test.dart'),
  });
  assert.equal(r.pr.baseRefName, 'dev');
  assert.equal(r.failures.length, 1, 'Main Guardrails failure is excluded');
  const f = r.failures[0];
  assert.equal(f.check, 'dart-test');
  assert.equal(f.runId, '777');
  assert.equal(f.jobId, '888');
  assert.equal(f.jobName, 'dart-test');
  assert.deepEqual(f.testFiles, ['flutter/packages/sync_repo/test/sync/attach_test.dart']);
  assert.deepEqual(f.testNames, ['narrow attach recovers after wedge']);
  assert.equal(f.attributable, false);
  assert.deepEqual(f.protected, []);
  const logCall = run.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'run');
  assert.deepEqual(logCall.args, ['run', 'view', '777', '--log-failed', '--job', '888']);
  const diffCall = run.calls.find((c) => c.cmd === 'git' && c.args[0] === 'diff');
  assert.deepEqual(diffCall.args, ['diff', '--name-only', 'origin/dev...HEAD']);
});

test('classify: attributable when the PR touched the failing package', () => {
  const run = fakeRunner(
    baseHandlers({ changed: 'flutter/packages/sync_repo/lib/repo.dart\n' }),
  );
  const r = classify({
    prNumber: 1553,
    repoRoot: '/repo',
    run,
    existsSync: (p) => p.endsWith('flutter/packages/sync_repo/test/sync/attach_test.dart'),
  });
  assert.equal(r.failures[0].attributable, true);
  assert.match(r.failures[0].reason, /package changed/);
});

test('classify: no failing checks → empty failures', () => {
  const run = fakeRunner({
    ...baseHandlers(),
    'gh pr checks': () => ({ stdout: JSON.stringify([{ name: 'a', bucket: 'pass', workflow: 'PR Checks' }]) }),
  });
  assert.deepEqual(classify({ prNumber: 1, repoRoot: '/repo', run }).failures, []);
});

// ---------------------------------------------------------------------------
// retry (fake gh, injected sleep)
// ---------------------------------------------------------------------------

test('retry reruns failed jobs, polls to completion, reports passedOnRetry', async () => {
  let views = 0;
  const run = fakeRunner({
    ...baseHandlers({ changed: 'docs/x.md\n' }),
    'gh run rerun 777 --failed': () => ({ stdout: '' }),
    'gh run view 777 --json': () => {
      views += 1;
      return {
        stdout: JSON.stringify(
          views < 3
            ? { status: 'in_progress', conclusion: null }
            : { status: 'completed', conclusion: 'success' },
        ),
      };
    },
  });
  const slept = [];
  const r = await retry({
    prNumber: 1553,
    check: 'dart-test',
    repoRoot: '/repo',
    run,
    sleep: async (ms) => slept.push(ms),
    intervalMs: 10,
    maxWaitMs: 1000,
    existsSync: () => false,
  });
  assert.equal(r.passedOnRetry, true);
  assert.equal(r.conclusion, 'success');
  assert.equal(slept.length, 3);
  assert.ok(run.calls.some((c) => c.cmd === 'gh' && c.args.join(' ') === 'run rerun 777 --failed'));
});

test('retry times out → passedOnRetry false; --isolated runs the local file first', async () => {
  const run = fakeRunner({
    ...baseHandlers({ changed: 'docs/x.md\n' }),
    'gh run rerun': () => ({}),
    'gh run view 777 --json': () => ({ stdout: JSON.stringify({ status: 'in_progress' }) }),
    'flutter test': () => ({ status: 0, stdout: 'All tests passed!' }),
  });
  const r = await retry({
    prNumber: 1553,
    check: 'dart-test',
    repoRoot: '/repo',
    isolated: true,
    run,
    sleep: async () => {},
    intervalMs: 10,
    maxWaitMs: 25,
    existsSync: (p) =>
      p.endsWith('flutter/packages/sync_repo/test/sync/attach_test.dart') ||
      p.endsWith(path.join('flutter', 'packages', 'sync_repo', 'pubspec.yaml')),
    readFileSync: () => 'name: sync_repo\ndependencies:\n  flutter:\n    sdk: flutter\n',
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.passedOnRetry, false);
  assert.equal(r.isolated.length, 1);
  assert.equal(r.isolated[0].ran, true);
  assert.equal(r.isolated[0].cwd, 'flutter/packages/sync_repo');
  const local = run.calls.find((c) => c.cmd === 'flutter');
  assert.deepEqual(local.args, ['test', 'test/sync/attach_test.dart']);
});

test('retry rejects an unknown check', async () => {
  const run = fakeRunner(baseHandlers());
  await assert.rejects(
    retry({ prNumber: 1553, check: 'nope', repoRoot: '/repo', run, sleep: async () => {} }),
    /not failing/,
  );
});

// ---------------------------------------------------------------------------
// Dart skip transforms
// ---------------------------------------------------------------------------

const REASON = skipText('flaky under CI load', 'https://github.com/o/r/issues/9');

const DART_FILE = `import 'package:flutter_test/flutter_test.dart';

void main() {
  group('attach', () {
    test('recovers after wedge', () async {
      expect(1, 1);
    });

    testWidgets('renders spinner', (tester) async {
      await tester.pump();
    });

    blocTest<SyncBloc, SyncState>(
      'emits ready',
      build: SyncBloc.new,
      expect: () => [SyncState.ready],
    );

    test(
      'trailing comma style',
      () async {
        expect(true, isTrue);
      },
    );
  });
}
`;

test('skipText joins reason and issue', () => {
  assert.equal(REASON, 'flaky under CI load (https://github.com/o/r/issues/9)');
  assert.equal(skipText('r', ''), 'r');
});

test('Dart test(): inline skip inserted, idempotent, removable', () => {
  const r = addDartTestSkip(DART_FILE, 'recovers after wedge', REASON);
  assert.equal(r.changed, true);
  assert.match(
    r.source,
    /test\('recovers after wedge', \(\) async \{\n\s+expect\(1, 1\);\n\s+\}, skip: 'flaky under CI load \(https:\/\/github\.com\/o\/r\/issues\/9\)'\);/,
  );
  const again = addDartTestSkip(r.source, 'recovers after wedge', REASON);
  assert.equal(again.changed, false);
  assert.equal(again.alreadySkipped, true);
  const back = removeDartTestSkip(r.source, 'recovers after wedge');
  assert.equal(back.changed, true);
  assert.equal(back.source, DART_FILE);
});

test('Dart testWidgets(): skip inserted on the widget test only', () => {
  const r = addDartTestSkip(DART_FILE, 'renders spinner', REASON);
  assert.match(r.source, /await tester\.pump\(\);\n\s+\}, skip: 'flaky/);
  assert.doesNotMatch(r.source, /expect\(1, 1\);\n\s+\}, skip/);
  assert.equal(removeDartTestSkip(r.source, 'renders spinner').source, DART_FILE);
});

test('Dart group(): skip inserted on the group call', () => {
  const r = addDartTestSkip(DART_FILE, 'attach', REASON);
  assert.match(r.source, /\n  \}, skip: 'flaky under CI load[^']*'\);\n\}\n$/);
  assert.equal(removeDartTestSkip(r.source, 'attach').source, DART_FILE);
});

test('Dart trailing-comma call: skip goes on its own line with matching indent', () => {
  const r = addDartTestSkip(DART_FILE, 'trailing comma style', REASON);
  assert.match(r.source, /\n      \},\n      skip: 'flaky under CI load[^']*',\n    \);/);
  assert.equal(removeDartTestSkip(r.source, 'trailing comma style').source, DART_FILE);
});

test('Dart blocTest<...>(): falls back to file-level @Skip (skip: is an int there)', () => {
  const r = addDartTestSkip(DART_FILE, 'emits ready', REASON);
  assert.equal(r.changed, true);
  assert.match(r.fallback, /blocTest has no test-skip parameter/);
  assert.doesNotMatch(r.source, /blocTest<SyncBloc, SyncState>\([\s\S]*?skip: 'flaky/);
  assert.match(r.source, /^@Skip\('flaky under CI load[^']*'\)\nlibrary;\n\nimport /);
  assert.equal(removeDartTestSkip(r.source, 'emits ready').source, DART_FILE);
});

test('Dart unknown or duplicate description → file-level fallback', () => {
  const r = addDartTestSkip(DART_FILE, 'does not exist', REASON);
  assert.match(r.fallback, /no test\/testWidgets\/group\/blocTest call/);
  assert.match(r.source, /^@Skip\(/);
  const dup = `${DART_FILE}\nvoid other() { test('recovers after wedge', () {}); }\n`;
  const d = addDartTestSkip(dup, 'recovers after wedge', REASON);
  assert.match(d.fallback, /2 calls match/);
});

test('Dart file-level @Skip without library: inserted after header comments + library;', () => {
  const src = `// ignore_for_file: avoid_print
// Header comment.

import 'package:test/test.dart';

void main() {}
`;
  const r = addDartFileSkip(src, REASON);
  assert.equal(
    r.source,
    `// ignore_for_file: avoid_print
// Header comment.

@Skip('flaky under CI load (https://github.com/o/r/issues/9)')
library;

import 'package:test/test.dart';

void main() {}
`,
  );
  assert.equal(addDartFileSkip(r.source, REASON).changed, false);
  assert.equal(removeDartFileSkip(r.source).source, src);
  assert.equal(removeDartFileSkip(src).changed, false);
});

test('Dart file-level @Skip with an existing library directive goes right before it', () => {
  const src = `@TestOn('vm')\nlibrary attach_test;\n\nimport 'x.dart';\n`;
  const r = addDartFileSkip(src, "it's flaky");
  assert.equal(
    r.source,
    `@TestOn('vm')\n@Skip('it\\'s flaky')\nlibrary attach_test;\n\nimport 'x.dart';\n`,
  );
  assert.equal(removeDartFileSkip(r.source).source, src);
});

test('Dart file-level @Skip on a file with no header comments', () => {
  const src = `import 'x.dart';\n\nvoid main() {}\n`;
  const r = addDartFileSkip(src, 'flaky');
  assert.equal(r.source, `@Skip('flaky')\nlibrary;\n\nimport 'x.dart';\n\nvoid main() {}\n`);
  assert.equal(removeDartFileSkip(r.source).source, src);
});

// ---------------------------------------------------------------------------
// Node skip transforms
// ---------------------------------------------------------------------------

const NODE_FILE = `import test from 'node:test';

test('settles after quiet window', async () => {
  assert.ok(true);
});

it("has options", { timeout: 500 }, () => {});

test('unrelated', () => {});
`;

test('Node test(): adds { skip } options, idempotent, removable', () => {
  const r = addNodeTestSkip(NODE_FILE, 'settles after quiet window', REASON);
  assert.equal(r.changed, true);
  assert.match(
    r.source,
    /test\('settles after quiet window', \{ skip: 'flaky under CI load \(https:\/\/github\.com\/o\/r\/issues\/9\)' \}, async \(\) => \{/,
  );
  assert.equal(addNodeTestSkip(r.source, 'settles after quiet window', REASON).alreadySkipped, true);
  assert.equal(removeNodeTestSkip(r.source, 'settles after quiet window').source, NODE_FILE);
});

test('Node it() with an existing options object gets a skip property', () => {
  const r = addNodeTestSkip(NODE_FILE, 'has options', 'flaky');
  assert.match(r.source, /it\("has options", \{ timeout: 500, skip: 'flaky' \}, \(\) => \{\}\);/);
  assert.equal(removeNodeTestSkip(r.source, 'has options').source, NODE_FILE);
});

test('Node removal keeps other options and tolerates commas inside the reason', () => {
  const src = `test('a', { skip: 'flaky, see #1', timeout: 5 }, () => {});\n`;
  assert.equal(
    removeNodeTestSkip(src, 'a').source,
    `test('a', { timeout: 5 }, () => {});\n`,
  );
  assert.equal(removeNodeTestSkip(`test('a', () => {});\n`, 'a').changed, false);
});

test('Node unknown name → ok:false, no change', () => {
  const r = addNodeTestSkip(NODE_FILE, 'missing', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.source, NODE_FILE);
});

// ---------------------------------------------------------------------------
// Diff, ledger, issue body
// ---------------------------------------------------------------------------

test('simpleDiff shows only the changed hunk', () => {
  const d = simpleDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.dart');
  assert.equal(d, '--- a/f.dart\n+++ b/f.dart\n@@ -2,1 +2,1 @@\n-b\n+B');
  assert.equal(simpleDiff('x', 'x', 'f'), '');
});

test('ledger append/read/table/active', () => {
  const { dir, env } = tmpState();
  try {
    appendLedger({ ts: 't1', action: 'quarantine', repo: 'o/r', file: 'a_test.dart', test: 'x', issue: 'u', pr: 5 }, { env });
    appendLedger({ ts: 't2', action: 'quarantine', repo: 'o/r', file: 'b_test.dart', test: null, issue: 'u2', pr: 5 }, { env });
    appendLedger({ ts: 't3', action: 'unquarantine', repo: 'o/r', file: 'a_test.dart', test: 'x', pr: 5 }, { env });
    const entries = readLedger({ env });
    assert.equal(entries.length, 3);
    assert.equal(path.dirname(entries.length && fs.readdirSync(path.join(dir, 'quarantine'))[0] && path.join(dir, 'quarantine', 'ledger.jsonl')), path.join(dir, 'quarantine'));
    const table = formatLedgerTable(entries);
    assert.match(table, /^ts\s+action\s+repo\s+file\s+test\s+issue\s+pr/);
    assert.match(table, /t2\s+quarantine\s+o\/r\s+b_test\.dart/);
    const active = activeQuarantinesForPr(entries, 5);
    assert.equal(active.length, 1);
    assert.equal(active[0].file, 'b_test.dart');
    assert.equal(formatLedgerTable([]), 'ledger empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIssueBody contains run, job, excerpt, PR, attribution and the unquarantine command', () => {
  const body = buildIssueBody({
    pr: { number: 1553, url: 'https://github.com/o/r/pull/1553' },
    failure: {
      check: 'dart-test',
      runId: '777',
      jobName: 'dart-test',
      link: RUN_LINK,
      attributable: false,
      reason: 'none of 1 failing test file(s) appear in the PR diff',
      excerpt: Array.from({ length: 50 }, (_, i) => `l${i}`),
    },
    testFile: 'flutter/packages/sync_repo/test/sync/attach_test.dart',
    test: 'narrow attach recovers after wedge',
    repoSlug: 'o/r',
  });
  assert.match(body, /\| Run \| https:\/\/github\.com\/o\/r\/actions\/runs\/777\/job\/888 \|/);
  assert.match(body, /\| Job \| `dart-test` \|/);
  assert.match(body, /\| PR \| https:\/\/github\.com\/o\/r\/pull\/1553 \|/);
  assert.match(body, /Attributable to PR diff \| no — none of 1/);
  assert.match(body, /l39\n```/);
  assert.doesNotMatch(body, /\bl40\b/);
  assert.match(
    body,
    /flake-quarantine\.mjs" unquarantine --file flutter\/packages\/sync_repo\/test\/sync\/attach_test\.dart --test 'narrow attach recovers after wedge'/,
  );
  assert.equal(issueTitle('a_test.dart', 'my test'), 'flaky: my test');
  assert.equal(issueTitle('a_test.dart', null), 'flaky: a_test.dart');
});

test('createIssue: dry-run prints body without gh; live path creates label then issue', () => {
  const run = fakeRunner({
    ...baseHandlers({ changed: 'docs/x.md\n' }),
    'gh label create flaky-test': () => ({}),
    'gh issue create': () => ({ stdout: 'https://github.com/o/r/issues/42\n' }),
  });
  const dry = createIssue({
    prNumber: 1553,
    check: 'dart-test',
    testFile: 'test/sync/attach_test.dart',
    repoRoot: '/repo',
    dryRun: true,
    run,
    env: {},
  });
  assert.equal(dry.url, null);
  assert.match(dry.body, /Flaky test quarantined/);
  assert.ok(!run.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'issue'));

  const live = createIssue({
    prNumber: 1553,
    check: 'dart-test',
    testFile: 'test/sync/attach_test.dart',
    repoRoot: '/repo',
    run,
    env: {},
  });
  assert.equal(live.url, 'https://github.com/o/r/issues/42');
  const label = run.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'label');
  assert.deepEqual(label.args, ['label', 'create', 'flaky-test', '--color', 'E4E669', '--force']);
  const issue = run.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'issue');
  assert.equal(issue.args[2], '--title');
  assert.equal(issue.args[3], 'flaky: test/sync/attach_test.dart');
  assert.equal(issue.args[5], 'flaky-test');
});

// ---------------------------------------------------------------------------
// CLI main (quarantine / unquarantine end-to-end on a temp file)
// ---------------------------------------------------------------------------

test('parseCliArgs splits command and flags', () => {
  const p = parseCliArgs(['quarantine', '--file', 'a.dart', '--test', 'my test', '--json']);
  assert.equal(p.command, 'quarantine');
  assert.deepEqual(p.flags, { file: 'a.dart', test: 'my test', json: true });
});

test('main quarantine writes skip, prints diff, records ledger; unquarantine reverses', async () => {
  const { dir, env } = tmpState();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-repo-'));
  try {
    const rel = 'flutter/packages/p/test/a_test.dart';
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), DART_FILE);
    let out = '';
    const run = fakeRunner({ 'git remote get-url origin': () => ({ stdout: 'https://github.com/o/r\n' }) });
    const deps = { run, repoRoot: repo, env, stdout: (s) => (out += s), stderr: () => {} };

    const code = await main(
      ['quarantine', '--file', rel, '--test', 'recovers after wedge', '--reason', 'flaky', '--issue', 'https://github.com/o/r/issues/1', '--pr', '7'],
      deps,
    );
    assert.equal(code, 0);
    assert.match(out, /^--- a\/flutter\/packages\/p\/test\/a_test\.dart\n\+\+\+ b\//);
    assert.match(out, /\+\s+\}, skip: 'flaky \(https:\/\/github\.com\/o\/r\/issues\/1\)'\);/);
    assert.match(fs.readFileSync(path.join(repo, rel), 'utf8'), /skip: 'flaky \(/);

    out = '';
    await main(
      ['quarantine', '--file', rel, '--test', 'recovers after wedge', '--reason', 'flaky', '--issue', 'https://github.com/o/r/issues/1'],
      deps,
    );
    assert.match(out, /already quarantined/);

    const entries = readLedger({ env });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'quarantine');
    assert.equal(entries[0].repo, 'o/r');
    assert.equal(entries[0].pr, 7);
    assert.equal(entries[0].test, 'recovers after wedge');

    out = '';
    const back = await main(['unquarantine', '--file', rel, '--test', 'recovers after wedge'], deps);
    assert.equal(back, 0);
    assert.equal(fs.readFileSync(path.join(repo, rel), 'utf8'), DART_FILE);
    assert.equal(readLedger({ env }).length, 2);
    assert.equal(readLedger({ env })[1].action, 'unquarantine');

    out = '';
    await main(['ledger'], deps);
    assert.match(out, /quarantine\s+o\/r/);
    await main(['ledger', '--json'], deps);
    assert.match(out, /"action": "unquarantine"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('main quarantine refuses protected paths', async () => {
  const { dir, env } = tmpState();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-repo-'));
  try {
    const rel = 'flutter/apps/client_app/integration_test/scenario_a_test.dart';
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), DART_FILE);
    await assert.rejects(
      main(
        ['quarantine', '--file', rel, '--reason', 'r', '--issue', 'u'],
        { run: fakeRunner({}), repoRoot: repo, env, stdout: () => {}, stderr: () => {} },
      ),
      /protected/,
    );
    assert.equal(fs.readFileSync(path.join(repo, rel), 'utf8'), DART_FILE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('main unknown command → usage, exit 2', async () => {
  let err = '';
  const code = await main(['bogus'], { run: fakeRunner({}), repoRoot: '/x', env: {}, stdout: () => {}, stderr: (s) => (err += s) });
  assert.equal(code, 2);
  assert.match(err, /usage/);
});
