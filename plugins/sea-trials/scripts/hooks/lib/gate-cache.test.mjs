import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as gateCache from './gate-cache.mjs';
import { runParallelLimited } from './parallel.mjs';

const {
  CACHEABLE_KINDS,
  cacheKeyForTask,
  describeSkip,
  entryPath,
  findRepoRoot,
  isCacheableTask,
  lookup,
  parsePathDeps,
  pathArgs,
  prune,
  record,
  taskInputs,
  transitiveLocalDeps,
} = gateCache;

const TOOLS = { dart: 'Dart SDK version: 3.10.0 (stable)' };

/**
 * Minimal Sea Trials-shaped checkout:
 *   <root>/.git
 *   <root>/flutter/{pubspec.yaml,pubspec.lock,analysis_options.yaml}
 *   <root>/flutter/packages/foo/{pubspec.yaml,analysis_options.yaml}
 *   <root>/flutter/packages/foo/lib/{a,b}.dart, test/a_test.dart
 *   <root>/flutter/packages/bar/{pubspec.yaml,lib/z.dart}
 */
function makeRepo(prefix = 'st-gate-cache-repo-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const w = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
  };
  fs.mkdirSync(path.join(root, '.git'));
  w('flutter/pubspec.yaml', 'name: workspace\nworkspace:\n  - packages/foo\n');
  w('flutter/pubspec.lock', 'packages: {}\n');
  w('flutter/analysis_options.yaml', 'formatter:\n  page_width: 80\n');
  w('flutter/packages/foo/pubspec.yaml', 'name: foo\n');
  w('flutter/packages/foo/analysis_options.yaml', 'include: ../../analysis_options.yaml\n');
  w('flutter/packages/foo/lib/a.dart', 'void a() {}\n');
  w('flutter/packages/foo/lib/b.dart', 'void b() {}\n');
  w('flutter/packages/foo/test/a_test.dart', 'void main() {}\n');
  w('flutter/packages/bar/pubspec.yaml', 'name: bar\n');
  w('flutter/packages/bar/lib/z.dart', 'void z() {}\n');
  w(
    'flutter/.dart_tool/package_config.json',
    '{"configVersion":2,"packages":[]}\n',
  );
  return { root, flutter: path.join(root, 'flutter'), write: w };
}

/**
 * Pub workspace with a dependency chain:
 *   z → y (bare workspace key) → x (`path: ../x`)
 * x has lib/{a,b}.dart + test/x_test.dart; y and z have one lib file each.
 */
function makeWorkspace(prefix = 'st-gate-cache-ws-') {
  const repo = makeRepo(prefix);
  repo.write(
    'flutter/pubspec.yaml',
    'name: workspace\nworkspace:\n  - packages/x\n  - packages/y\n  - packages/z\n',
  );
  repo.write('flutter/packages/x/pubspec.yaml', 'name: x\nresolution: workspace\n');
  repo.write('flutter/packages/x/lib/a.dart', 'void a() {}\n');
  repo.write('flutter/packages/x/lib/b.dart', 'void b() {}\n');
  repo.write('flutter/packages/x/test/x_test.dart', 'void main() {}\n');
  repo.write(
    'flutter/packages/y/pubspec.yaml',
    'name: y\nresolution: workspace\ndependencies:\n  x:\n    path: ../x\n',
  );
  repo.write('flutter/packages/y/lib/y.dart', 'void y() {}\n');
  repo.write(
    'flutter/packages/z/pubspec.yaml',
    'name: z\nresolution: workspace\ndependencies:\n  y:\n  http: ^1.0.0\n',
  );
  repo.write('flutter/packages/z/lib/z.dart', 'void z() {}\n');
  const pkg = (name) => path.join(repo.flutter, 'packages', name);
  return { ...repo, pkg };
}

function stateEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-cache-state-'));
  return { dir, env: { ST_STATE_DIR: dir, ...extra } };
}

function formatTask(repo, files = ['packages/foo/lib/a.dart']) {
  return {
    kind: 'format',
    label: `dart format --check (${files.length} files)`,
    cmd: 'dart',
    args: ['format', '--output', 'none', '--set-exit-if-changed', ...files],
    options: { cwd: repo.flutter },
  };
}

function analyzeTask(repo, paths = ['packages/foo/lib']) {
  return {
    kind: 'analyze',
    label: 'dart analyze --fatal-infos (chunk 1/1)',
    cmd: 'dart',
    args: ['analyze', '--fatal-infos', ...paths],
    options: { cwd: repo.flutter },
    weight: 3,
  };
}

function lintTask(repo, files = ['packages/foo/lib/a.dart']) {
  const bin = path.join(repo.root, 'tools', 'sea-trials-lint', 'bin', 'sea-trials-lint');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  return {
    kind: 'lint',
    label: `sea-trials-lint check (${files.length} files)`,
    cmd: bin,
    args: ['check', '--root', repo.flutter, ...files.map((f) => path.join(repo.flutter, f))],
  };
}

function key(task, repo, env, extra = {}) {
  return cacheKeyForTask(task, {
    repoRoot: repo.root,
    env,
    toolVersions: { ...TOOLS, [task.cmd]: TOOLS[task.cmd] ?? 'lint 1.0' },
    ...extra,
  });
}

// ---------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------

test('isCacheableTask: kind + command shape, never lane wrappers', () => {
  assert.deepEqual([...CACHEABLE_KINDS].sort(), ['analyze', 'format', 'lint']);
  assert.equal(isCacheableTask({ kind: 'format', cmd: 'dart', args: ['format', 'x'] }), true);
  assert.equal(isCacheableTask({ kind: 'analyze', cmd: 'dart.exe', args: ['analyze'] }), true);
  assert.equal(
    isCacheableTask({ kind: 'lint', cmd: '/r/tools/sea-trials-lint/bin/sea-trials-lint', args: ['check'] }),
    true,
  );
  // push-gate JSON lines label CI lanes with `kind: 'analyze'` too.
  assert.equal(
    isCacheableTask({ kind: 'analyze', cmd: 'node', args: ['run-lane.mjs', '--lane', 'analyze'] }),
    false,
  );
  assert.equal(isCacheableTask({ kind: 'test', cmd: 'flutter', args: ['test'] }), false);
  assert.equal(isCacheableTask({ cmd: 'dart', args: ['format'] }), false);
  assert.equal(isCacheableTask(null), false);
});

test('pathArgs skips flags and flag values, keeps existing paths', () => {
  const repo = makeRepo();
  const got = pathArgs(
    ['format', '--output', 'none', '--set-exit-if-changed', 'packages/foo/lib/a.dart', 'missing.dart'],
    repo.flutter,
  );
  assert.deepEqual(got, [path.join(repo.flutter, 'packages/foo/lib/a.dart')]);
});

test('findRepoRoot walks up to the .git marker (dir or worktree file)', () => {
  const repo = makeRepo();
  assert.equal(findRepoRoot(path.join(repo.flutter, 'packages/foo/lib')), repo.root);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-cache-wt-'));
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
  fs.mkdirSync(path.join(wt, 'a', 'b'), { recursive: true });
  assert.equal(findRepoRoot(path.join(wt, 'a', 'b')), wt);
});

// ---------------------------------------------------------------------
// inputs + keys
// ---------------------------------------------------------------------

test('taskInputs: format takes listed files plus nearest configs', () => {
  const repo = makeRepo();
  const { files, tooBig } = taskInputs(formatTask(repo), { repoRoot: repo.root });
  const rel = files.map((f) => path.relative(repo.root, f).split(path.sep).join('/'));
  assert.equal(tooBig, false);
  assert.deepEqual(rel, [
    'flutter/.dart_tool/package_config.json',
    'flutter/packages/foo/analysis_options.yaml',
    'flutter/packages/foo/lib/a.dart',
    'flutter/packages/foo/pubspec.yaml',
  ]);
});

test('taskInputs: format is uncacheable without package_config', () => {
  const repo = makeRepo();
  repo.write('flutter/.dart_tool/package_config.json', '');
  const abs = path.join(repo.root, 'flutter', '.dart_tool', 'package_config.json');
  fs.unlinkSync(abs);
  const { tooBig } = taskInputs(formatTask(repo), { repoRoot: repo.root });
  assert.equal(tooBig, true);
});

test('cacheKeyForTask: format key changes when package_config changes', () => {
  const repo = makeRepo();
  const { env } = stateEnv();
  const base = key(formatTask(repo), repo, env);
  repo.write(
    'flutter/.dart_tool/package_config.json',
    '{"configVersion":2,"packages":[{"name":"foo"}]}\n',
  );
  assert.notEqual(key(formatTask(repo), repo, env), base);
});

test('taskInputs: analyze is package-scoped (lib + test + configs + workspace)', () => {
  const repo = makeRepo();
  const { files, packages } = taskInputs(analyzeTask(repo), { repoRoot: repo.root });
  const rel = files.map((f) => path.relative(repo.root, f).split(path.sep).join('/'));
  assert.deepEqual(packages, [path.join(repo.flutter, 'packages', 'foo')]);
  assert.deepEqual(rel, [
    'flutter/analysis_options.yaml',
    'flutter/packages/foo/analysis_options.yaml',
    'flutter/packages/foo/lib/a.dart',
    'flutter/packages/foo/lib/b.dart',
    'flutter/packages/foo/pubspec.yaml',
    'flutter/packages/foo/test/a_test.dart',
    'flutter/pubspec.lock',
    'flutter/pubspec.yaml',
  ]);
  // A file-scoped analyze still hashes its whole owning package.
  const scoped = taskInputs(analyzeTask(repo, ['packages/foo/lib/a.dart']), {
    repoRoot: repo.root,
  });
  assert.ok(scoped.files.some((f) => f.endsWith('a_test.dart')));
});

test('cacheKeyForTask: stable, and identical across checkouts at other paths', () => {
  const repoA = makeRepo();
  const { env } = stateEnv();
  const k1 = key(formatTask(repoA), repoA, env);
  const k2 = key(formatTask(repoA), repoA, env);
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(k1, k2);

  const repoB = makeRepo('st-gate-cache-repo-b-');
  assert.notEqual(repoA.root, repoB.root);
  assert.equal(key(formatTask(repoB), repoB, env), k1);
  // Lint args are absolute — normalisation must still line up.
  assert.equal(key(lintTask(repoA), repoA, env), key(lintTask(repoB), repoB, env));
  // Analyze too.
  assert.equal(key(analyzeTask(repoA), repoA, env), key(analyzeTask(repoB), repoB, env));
});

test('cacheKeyForTask: changes when an input, a config or the tool changes', () => {
  const repo = makeRepo();
  const { env } = stateEnv();
  const base = key(formatTask(repo), repo, env);

  repo.write('flutter/packages/foo/lib/a.dart', 'void a() { }\n');
  const afterFile = key(formatTask(repo), repo, env);
  assert.notEqual(afterFile, base);

  repo.write('flutter/packages/foo/analysis_options.yaml', 'formatter:\n  page_width: 100\n');
  const afterOptions = key(formatTask(repo), repo, env);
  assert.notEqual(afterOptions, afterFile);

  const otherTool = key(formatTask(repo), repo, env, {
    toolVersions: { dart: 'Dart SDK version: 3.11.0' },
  });
  assert.notEqual(otherTool, afterOptions);

  // A different file list is a different task.
  assert.notEqual(
    key(formatTask(repo, ['packages/foo/lib/a.dart', 'packages/foo/lib/b.dart']), repo, env),
    afterOptions,
  );
});

test('cacheKeyForTask: analyze key tracks the whole package, not other packages', () => {
  const repo = makeRepo();
  const { env } = stateEnv();
  const base = key(analyzeTask(repo), repo, env);

  repo.write('flutter/packages/bar/lib/z.dart', 'void z() { }\n');
  assert.equal(key(analyzeTask(repo), repo, env), base, 'sibling package is not an input');

  repo.write('flutter/packages/foo/test/a_test.dart', 'void main() { }\n');
  const afterTest = key(analyzeTask(repo), repo, env);
  assert.notEqual(afterTest, base, 'test/ change invalidates');

  repo.write('flutter/packages/foo/pubspec.yaml', 'name: foo\nversion: 1.0.0\n');
  const afterPubspec = key(analyzeTask(repo), repo, env);
  assert.notEqual(afterPubspec, afterTest);

  repo.write('flutter/pubspec.lock', 'packages: {x: 1}\n');
  assert.notEqual(key(analyzeTask(repo), repo, env), afterPubspec, 'workspace lock invalidates');
});

// ---------------------------------------------------------------------
// dependency closure
// ---------------------------------------------------------------------

test('parsePathDeps: nested and inline path values, both sections', () => {
  const deps = parsePathDeps(
    [
      'name: y',
      'dependencies:',
      '  x:',
      '    path: ../x',
      '  http: ^1.0.0',
      '  inline: {path: "../inline"}',
      'dev_dependencies:',
      '  tools:',
      '    path: ../../tools',
      '    version: 1.0.0',
      'flutter:',
      '  assets:',
      '    - path: not/a/dep',
    ].join('\n'),
  );
  assert.deepEqual(
    [...deps.entries()].sort(),
    [['inline', '../inline'], ['tools', '../../tools'], ['x', '../x']],
  );
});

test('transitiveLocalDeps resolves path deps and bare workspace keys', () => {
  const ws = makeWorkspace();
  assert.deepEqual(transitiveLocalDeps([ws.pkg('x')], ws.root), []);
  assert.deepEqual(transitiveLocalDeps([ws.pkg('y')], ws.root), [ws.pkg('x')]);
  assert.deepEqual(transitiveLocalDeps([ws.pkg('z')], ws.root), [ws.pkg('x'), ws.pkg('y')]);
  // Starting packages are never listed as their own dependency.
  assert.deepEqual(transitiveLocalDeps([ws.pkg('y'), ws.pkg('x')], ws.root), []);
});

test('analyze key of y follows its path dependency x: lib/ yes, test/ no', () => {
  const ws = makeWorkspace();
  const { env } = stateEnv();
  const yTask = analyzeTask(ws, ['packages/y/lib']);

  const inputs = taskInputs(yTask, { repoRoot: ws.root });
  assert.deepEqual(inputs.packages, [ws.pkg('y')]);
  assert.deepEqual(inputs.dependencies, [ws.pkg('x')]);
  const rel = inputs.files.map((f) => path.relative(ws.root, f).split(path.sep).join('/'));
  assert.ok(rel.includes('flutter/packages/x/pubspec.yaml'));
  assert.ok(rel.includes('flutter/packages/x/lib/a.dart'));
  assert.ok(!rel.includes('flutter/packages/x/test/x_test.dart'), 'dep test/ is not an input');

  const base = key(yTask, ws, env);
  ws.write('flutter/packages/x/test/x_test.dart', 'void main() { }\n');
  assert.equal(key(yTask, ws, env), base, 'editing a dependency test does not invalidate');

  ws.write('flutter/packages/x/lib/a.dart', 'void a(int changed) {}\n');
  const afterLib = key(yTask, ws, env);
  assert.notEqual(afterLib, base, 'editing a dependency lib invalidates');

  ws.write('flutter/packages/x/pubspec.yaml', 'name: x\nresolution: workspace\nversion: 2.0.0\n');
  assert.notEqual(key(yTask, ws, env), afterLib, 'dependency pubspec invalidates');

  // x itself does not depend on y: y edits leave x's key alone.
  const xTask = analyzeTask(ws, ['packages/x/lib']);
  const xBase = key(xTask, ws, env);
  ws.write('flutter/packages/y/lib/y.dart', 'void y() { }\n');
  assert.equal(key(xTask, ws, env), xBase);
});

test('analyze key of z follows the transitive chain z → y → x', () => {
  const ws = makeWorkspace();
  const { env } = stateEnv();
  const zTask = analyzeTask(ws, ['packages/z/lib']);
  const inputs = taskInputs(zTask, { repoRoot: ws.root });
  assert.deepEqual(inputs.dependencies, [ws.pkg('x'), ws.pkg('y')]);

  const base = key(zTask, ws, env);
  ws.write('flutter/packages/x/lib/b.dart', 'void b() { }\n');
  const afterX = key(zTask, ws, env);
  assert.notEqual(afterX, base, 'transitive dependency lib invalidates');
  ws.write('flutter/packages/y/lib/y.dart', 'void y() { }\n');
  assert.notEqual(key(zTask, ws, env), afterX, 'direct dependency lib invalidates');
});

test('the dart-file cap counts dependency files too', () => {
  const ws = makeWorkspace();
  const { env } = stateEnv();
  // y: 1 own lib file + x: 2 dep lib files = 3 (x/test is not counted).
  const yTask = analyzeTask(ws, ['packages/y/lib']);
  assert.equal(taskInputs(yTask, { repoRoot: ws.root, maxPackageDartFiles: 2 }).tooBig, true);
  assert.equal(taskInputs(yTask, { repoRoot: ws.root, maxPackageDartFiles: 3 }).tooBig, false);
  assert.equal(key(yTask, ws, env, { maxPackageDartFiles: 2 }), null);
  assert.match(key(yTask, ws, env, { maxPackageDartFiles: 3 }), /^[0-9a-f]{64}$/);
  // x alone (2 lib + 1 test) fits in 3 as well; z pulls 4 in total.
  assert.equal(key(analyzeTask(ws, ['packages/x/lib']), ws, env, { maxPackageDartFiles: 3 }) !== null, true);
  assert.equal(key(analyzeTask(ws, ['packages/z/lib']), ws, env, { maxPackageDartFiles: 3 }), null);
});

test('cacheKeyForTask: null when disabled, uncacheable, oversized or unknown tool', () => {
  const repo = makeRepo();
  const { env } = stateEnv();
  assert.equal(key(formatTask(repo), repo, { ...env, ST_GATE_CACHE: '0' }), null);
  assert.equal(key({ ...formatTask(repo), kind: 'test' }, repo, env), null);
  assert.equal(
    key(analyzeTask(repo), repo, env, { maxPackageDartFiles: 2 }),
    null,
    'package with > max dart files is not cached',
  );
  assert.equal(
    cacheKeyForTask(formatTask(repo), { repoRoot: repo.root, env, toolVersions: { dart: '' } }),
    null,
    'unknown tool version is not cached',
  );
  // Analyze aimed at a path with no owning package: nothing to key on.
  repo.write('docs/x.dart', 'void x() {}\n');
  assert.equal(key(analyzeTask(repo, ['../docs']), repo, env), null);
  // Workspace-root analyze with a tiny cap: the dir listing trips it.
  assert.equal(key(analyzeTask(repo, ['.']), repo, env, { maxPackageDartFiles: 1 }), null);
  // Empty file list (all paths missing) is not cached.
  assert.equal(key(formatTask(repo, ['nope.dart']), repo, env), null);
});

// ---------------------------------------------------------------------
// store
// ---------------------------------------------------------------------

test('lookup / record: success only, atomic file per key', () => {
  const { dir, env } = stateEnv();
  const k = 'a'.repeat(64);
  assert.deepEqual(lookup(k, { env }), { hit: false });
  assert.equal(record(k, { kind: 'format', ok: false }, { env }), false, 'failures are never recorded');
  assert.equal(lookup(k, { env }).hit, false);

  const now = new Date('2026-09-22T10:00:00.000Z');
  assert.equal(record(k, { kind: 'format', label: 'x', ms: 12 }, { env, now }), true);
  const hit = lookup(k, { env });
  assert.equal(hit.hit, true);
  assert.equal(hit.at, now.getTime());
  assert.equal(hit.meta.label, 'x');
  assert.ok(entryPath(k, { env }).startsWith(dir));
  assert.deepEqual(
    fs.readdirSync(path.join(dir, 'gate-cache')).filter((n) => n.endsWith('.tmp')),
    [],
    'no temp files left behind',
  );
  assert.deepEqual(lookup(null, { env }), { hit: false });
  assert.equal(record(null, {}, { env }), false);
  assert.equal(describeSkip({ label: 'dart format --check (3 files)' }), '⏭ cache hit: dart format --check (3 files)');
});

test('prune drops stale entries, then the oldest beyond maxEntries', () => {
  const { dir, env } = stateEnv();
  const now = Date.now();
  const keys = Array.from({ length: 6 }, (_, i) => String(i).repeat(64));
  for (const [i, k] of keys.entries()) {
    record(k, { kind: 'format' }, { env });
    // Entries 0 and 1 are 20 days old; the rest are fresh but ordered.
    const age = i < 2 ? 20 * 86_400_000 : (6 - i) * 60_000;
    const t = new Date(now - age);
    fs.utimesSync(entryPath(k, { env }), t, t);
  }
  const stale = path.join(dir, 'gate-cache', 'dead.1.abcd.tmp');
  fs.writeFileSync(stale, '{}');
  const old = new Date(now - 3 * 3_600_000);
  fs.utimesSync(stale, old, old);

  const first = prune({ env, now, maxAgeDays: 14, maxEntries: 5000 });
  assert.equal(first.removed, 3, 'two stale entries + one stale tmp');
  assert.equal(first.kept, 4);
  assert.equal(fs.existsSync(stale), false);

  const second = prune({ env, now, maxAgeDays: 14, maxEntries: 2 });
  assert.equal(second.removed, 2);
  assert.equal(second.kept, 2);
  assert.equal(lookup(keys[5], { env }).hit, true, 'newest survives');
  assert.equal(lookup(keys[2], { env }).hit, false, 'oldest fresh entry pruned');
  assert.deepEqual(prune({ env: { ST_STATE_DIR: path.join(dir, 'missing') } }).removed, 0);
});

// ---------------------------------------------------------------------
// runParallelLimited integration
// ---------------------------------------------------------------------

function fakeRunner(codeFor) {
  const calls = [];
  const runner = async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options.cwd });
    return { code: codeFor(cmd, args), stdout: '', stderr: '', durationMs: 5 };
  };
  return { runner, calls };
}

function injectedCache(env) {
  return {
    ...gateCache,
    cacheKeyForTask: (task, opts) =>
      gateCache.cacheKeyForTask(task, { ...opts, env, toolVersions: TOOLS }),
    lookup: (k) => gateCache.lookup(k, { env }),
    record: (k, meta) => gateCache.record(k, meta, { env }),
  };
}

test('runParallelLimited: hit skips the spawn, success records, failure does not', async () => {
  const repo = makeRepo();
  const { env } = stateEnv();
  const cache = injectedCache(env);
  const telemetry = { rows: [], recordRun(row) { this.rows.push(row); } };
  const tasks = [
    formatTask(repo),
    analyzeTask(repo),
    { ...formatTask(repo, ['packages/foo/lib/b.dart']), label: 'failing format' },
  ];
  const codeFor = (cmd, args) => (args.includes('packages/foo/lib/b.dart') ? 1 : 0);

  const first = fakeRunner(codeFor);
  const r1 = await runParallelLimited(tasks, 8, {
    failFast: false,
    repoRoot: repo.root,
    cache,
    telemetry,
    runner: first.runner,
  });
  assert.equal(first.calls.length, 3, 'cold cache spawns everything');
  assert.equal(r1.cacheHits, 0);
  assert.equal(r1.failures.length, 1);
  assert.equal(r1.failures[0].label, 'failing format');

  const second = fakeRunner(codeFor);
  const r2 = await runParallelLimited(tasks, 8, {
    failFast: false,
    repoRoot: repo.root,
    cache,
    telemetry,
    runner: second.runner,
  });
  assert.equal(r2.cacheHits, 2, 'two green tasks hit');
  assert.equal(second.calls.length, 1, 'only the failed task is re-run');
  assert.equal(second.calls[0].args.at(-1), 'packages/foo/lib/b.dart');
  const hits = r2.results.filter((r) => r.cacheHit);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((r) => r.code === 0 && r.skipped === 'cache'));

  // Telemetry saw every runnable, hits flagged, failure not ok.
  assert.equal(telemetry.rows.length, 6);
  assert.equal(telemetry.rows.filter((r) => r.cacheHit).length, 2);
  assert.equal(telemetry.rows.filter((r) => r.ok === false).length, 2);
  assert.ok(telemetry.rows.every((r) => r.kind === 'gate' && r.repo === path.basename(repo.root)));

  // Editing the analyzed package invalidates only that entry.
  repo.write('flutter/packages/foo/lib/b.dart', 'void b() { }\n');
  const third = fakeRunner(() => 0);
  const r3 = await runParallelLimited([formatTask(repo), analyzeTask(repo)], 8, {
    failFast: false,
    repoRoot: repo.root,
    cache,
    telemetry,
    runner: third.runner,
  });
  assert.equal(r3.cacheHits, 1, 'format of a.dart still hits');
  assert.equal(third.calls.length, 1);
  assert.equal(third.calls[0].args[0], 'analyze');
});

test('runParallelLimited: noCache / cache:null bypass the store entirely', async () => {
  const repo = makeRepo();
  const { env } = stateEnv();
  const cache = injectedCache(env);
  const warm = fakeRunner(() => 0);
  await runParallelLimited([formatTask(repo)], 8, {
    repoRoot: repo.root,
    cache,
    telemetry: null,
    runner: warm.runner,
  });
  const bypass = fakeRunner(() => 0);
  const r = await runParallelLimited([formatTask(repo)], 8, {
    repoRoot: repo.root,
    cache,
    noCache: true,
    telemetry: null,
    runner: bypass.runner,
  });
  assert.equal(r.cacheHits, 0);
  assert.equal(bypass.calls.length, 1);
  const nul = fakeRunner(() => 0);
  const r2 = await runParallelLimited([formatTask(repo)], 8, {
    repoRoot: repo.root,
    cache: null,
    telemetry: null,
    runner: nul.runner,
  });
  assert.equal(r2.cacheHits, 0);
  assert.equal(nul.calls.length, 1);
});
