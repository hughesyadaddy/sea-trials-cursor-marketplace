import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_MAX_PARALLEL,
  MAX_PARALLEL_CAP,
  TIER_MODELS,
  applyResult,
  buildTask,
  computeStatus,
  emptyState,
  inferTier,
  loadState,
  parseArgs,
  parseResult,
  previewWave,
  readyShards,
  resolveMaxParallel,
  resolveModels,
  resolveSubagentType,
  selectForEmit,
} from './st-build-shard-tasks.mjs';

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(hooksDir, 'st-build-shard-tasks.mjs');
const skillScripts = path.join(
  hooksDir,
  '..',
  '..',
  'skills',
  'st-build-with-subagents',
  'scripts',
);
const validateScript = path.join(skillScripts, 'validate-shard-manifest.mjs');
const suggestScript = path.join(skillScripts, 'suggest-shards-from-plan.mjs');
const repoShardsJson = path.join(
  hooksDir,
  '..',
  '..',
  '..',
  '..',
  'shards.json',
);

const { validateManifest, packageRoot, looksShared } = await import(
  pathToFileURL(validateScript).href
);
const {
  suggestManifest,
  parseShardsFence,
  parseExecutionMap,
  heuristicShards,
  packageRootOf,
} = await import(pathToFileURL(suggestScript).href);

const chain = [
  { id: 'a', paths: ['a/'] },
  { id: 'b', paths: ['b/'], dependsOn: ['a'] },
  { id: 'c', paths: ['c/'] },
];

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function tmpManifest(prefix, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'shards.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  return { dir, file, state: path.join(dir, 'state.json') };
}

function jsonLines(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------
// Emitter: pure functions
// ---------------------------------------------------------------------

test('parseArgs collects done ids, results, flags', () => {
  const args = parseArgs([
    '--manifest',
    'm.json',
    '--done',
    'a, b',
    '--done',
    'c',
    '--result',
    '{"shard":"x","status":"done"}',
    '--status',
    '--reemit',
    '--max-parallel',
    '3',
  ]);
  assert.equal(args.manifest, 'm.json');
  assert.deepEqual(args.done, ['a', 'b', 'c']);
  assert.equal(args.results[0].shard, 'x');
  assert.equal(args.status, true);
  assert.equal(args.reemit, true);
  assert.equal(args.maxParallel, 3);
});

test('parseResult validates the worker contract', () => {
  const ok = parseResult(
    '{"shard":"a","status":"blocked","filesChanged":["x"],' +
      '"needsIntegration":["export Foo"],"notes":"n"}',
  );
  assert.equal(ok.status, 'blocked');
  assert.deepEqual(ok.needsIntegration, ['export Foo']);
  assert.throws(() => parseResult('nope'), /not valid JSON/);
  assert.throws(() => parseResult('{"status":"done"}'), /"shard"/);
  assert.throws(
    () => parseResult('{"shard":"a","status":"maybe"}'),
    /done.*blocked/,
  );
});

test('emitted is not done: readyShards skips in-flight shards', () => {
  const state = emptyState();
  state.emitted.add('a');
  assert.deepEqual(
    readyShards(chain, state).map((s) => s.id),
    ['c'],
  );
  assert.deepEqual(
    readyShards(chain, state, { reemit: true }).map((s) => s.id),
    ['a', 'c'],
  );
  state.done.add('a');
  assert.deepEqual(
    readyShards(chain, state).map((s) => s.id),
    ['b', 'c'],
  );
});

test('applyResult: done completes, blocked parks the shard', () => {
  const state = emptyState();
  state.emitted.add('a');
  applyResult(state, parseResult('{"shard":"a","status":"blocked"}'));
  assert.ok(state.blocked.has('a'));
  assert.deepEqual(readyShards(chain, state).map((s) => s.id), ['c']);
  applyResult(state, parseResult('{"shard":"a","status":"done"}'));
  assert.ok(state.done.has('a'));
  assert.ok(!state.blocked.has('a'));
});

test('selectForEmit is a rolling window over free slots', () => {
  const many = ['p', 'q', 'r', 's', 't'].map((id) => ({
    id,
    paths: [`${id}/`],
  }));
  const state = emptyState();
  let sel = selectForEmit(many, state, 3);
  assert.deepEqual(sel.chosen.map((s) => s.id), ['p', 'q', 'r']);
  for (const s of sel.chosen) state.emitted.add(s.id);
  sel = selectForEmit(many, state, 3);
  assert.equal(sel.slots, 0);
  assert.equal(sel.chosen.length, 0);
  state.done.add('q');
  sel = selectForEmit(many, state, 3);
  assert.deepEqual(sel.chosen.map((s) => s.id), ['s']);
});

test('computeStatus buckets pending/ready/inFlight/done/blocked', () => {
  const state = emptyState();
  state.emitted.add('a');
  const status = computeStatus(chain, state, 6);
  assert.deepEqual(status.inFlight, ['a']);
  assert.deepEqual(status.ready, ['c']);
  assert.deepEqual(status.pending, ['b']);
  assert.deepEqual(status.blockedBy, { b: ['a'] });
  assert.equal(status.slots, 5);
  assert.equal(status.complete, false);
  applyResult(
    state,
    parseResult(
      '{"shard":"a","status":"done","needsIntegration":["barrel"]}',
    ),
  );
  const next = computeStatus(chain, state, 6);
  assert.deepEqual(next.needsIntegration, [
    { shard: 'a', items: ['barrel'] },
  ]);
});

test('previewWave simulates earlier waves finishing', () => {
  assert.deepEqual(
    previewWave(chain, emptyState(), 6, 0).map((s) => s.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    previewWave(chain, emptyState(), 6, 1).map((s) => s.id),
    ['b'],
  );
  assert.deepEqual(previewWave(chain, emptyState(), 6, 2), []);
});

test('resolveMaxParallel defaults to 6 and caps at 12', () => {
  assert.equal(DEFAULT_MAX_PARALLEL, 6);
  assert.equal(MAX_PARALLEL_CAP, 12);
  assert.equal(resolveMaxParallel(undefined), 6);
  assert.equal(resolveMaxParallel(0), 6);
  assert.equal(resolveMaxParallel(40), 12);
  assert.equal(resolveMaxParallel(8), 8);
});

test('inferTier: l10n / generated shards are mechanical', () => {
  assert.equal(inferTier({ paths: ['flutter/packages/l10n/'] }), 'mechanical');
  assert.equal(inferTier({ paths: ['x/lib/l10n/app_en.arb'] }), 'mechanical');
  assert.equal(inferTier({ paths: ['x/lib/'] }), 'code');
  assert.equal(
    inferTier({ paths: ['x/lib/'], tier: 'reasoning' }),
    'reasoning',
  );
});

test('resolveModels: shard > env > probe > tier defaults', () => {
  // caps=null skips the on-disk probe so the test is machine-independent.
  const noCaps = resolveModels({ paths: ['x/lib/'] }, {}, null);
  assert.equal(noCaps.tier, 'code');
  assert.equal(noCaps.model, TIER_MODELS.code.cursor);
  assert.equal(noCaps.claudeModel, TIER_MODELS.code.claude);
  assert.equal(noCaps.modelVerified, false);
  assert.equal(noCaps.modelSource, 'static-fallback');
  assert.equal(TIER_MODELS.code.cursor, 'composer-2.5');
  assert.equal(TIER_MODELS.code.claude, 'sonnet');
  assert.equal(TIER_MODELS.mechanical.claude, 'haiku');

  const env = {
    ST_SHARD_MODEL_CODE: 'grok-4.7-high-fast',
    ST_SHARD_MODEL_CODE_CLAUDE: 'opus',
  };
  const fromEnv = resolveModels({ paths: ['x/lib/'] }, env, null);
  assert.equal(fromEnv.model, 'grok-4.7-high-fast');
  assert.equal(fromEnv.claudeModel, 'opus');
  assert.equal(fromEnv.modelSource, 'env');

  // A probed list wins over static defaults when no env override exists.
  const caps = {
    host: 'cursor',
    cursor: { models: ['inherit', 'composer-2.5'], source: 'probe' },
    claude: { models: ['inherit', 'haiku', 'sonnet'], source: 'probe' },
  };
  const probed = resolveModels(
    { paths: ['docs/'], tier: 'mechanical' },
    {},
    caps,
  );
  assert.equal(probed.tier, 'mechanical');
  assert.equal(probed.model, 'composer-2.5'); // no *-fast slug available
  assert.equal(probed.claudeModel, 'haiku');
  assert.equal(probed.modelVerified, true);

  const explicit = resolveModels(
    { paths: ['x/lib/'], model: 'gpt-5.6-sol-medium', claudeModel: 'haiku' },
    env,
    null,
  );
  assert.equal(explicit.model, 'gpt-5.6-sol-medium');
  assert.equal(explicit.claudeModel, 'haiku');
  assert.equal(explicit.modelSource, 'shard');
  assert.equal(explicit.modelVerified, false);
});

test('resolveSubagentType prefers the plugin worker agent', () => {
  assert.equal(
    resolveSubagentType({ agentFileExists: true }),
    'st-shard-worker',
  );
  assert.equal(
    resolveSubagentType({ agentFileExists: false }),
    'generalPurpose',
  );
  assert.equal(resolveSubagentType({ override: 'custom' }), 'custom');
  // The agent file ships with this plugin.
  assert.equal(resolveSubagentType(), 'st-shard-worker');
});

test('buildTask carries models, sharedFiles and the result contract', () => {
  const task = buildTask(
    {
      id: 'ui',
      paths: ['pkg/lib/src/ui/'],
      sharedFiles: ['pkg/lib/pkg.dart'],
      dependsOn: ['core'],
      summary: 'Add widgets',
    },
    {
      root: '/repo',
      plan: 'docs/plan/x.md',
      subagentType: 'st-shard-worker',
      manifestSharedFiles: ['pkg/pubspec.yaml'],
      env: {},
    },
  );
  assert.equal(task.source, 'build-shard');
  assert.equal(task.taskId, 'ui');
  assert.equal(task.subagent_type, 'st-shard-worker');
  assert.equal(task.fallbackSubagentType, 'generalPurpose');
  assert.equal(task.claudeAgent, 'sea-trials:st-shard-worker');
  assert.equal(task.model, 'composer-2.5');
  assert.equal(task.claudeModel, 'sonnet');
  assert.equal(task.run_in_background, true);
  assert.deepEqual(task.sharedFiles, ['pkg/lib/pkg.dart', 'pkg/pubspec.yaml']);
  assert.match(task.prompt, /DO NOT edit\): pkg\/lib\/pkg\.dart/);
  assert.match(task.prompt, /docs\/plan\/x\.md/);
  assert.match(task.prompt, /Add widgets/);
  assert.match(task.prompt, /"shard":"ui","status":"done\|blocked"/);
  assert.match(task.prompt, /no git push/);
});

// ---------------------------------------------------------------------
// Emitter: CLI
// ---------------------------------------------------------------------

test('CLI emits ready shards only, with a stderr summary', () => {
  const { dir, file } = tmpManifest('shard-', { shards: chain });
  const res = run(['--manifest', file, '--root', dir]);
  assert.equal(res.status, 0, res.stderr);
  const tasks = jsonLines(res.stdout);
  assert.deepEqual(tasks.map((t) => t.taskId), ['a', 'c']);
  assert.match(res.stderr, /ready=\d+ emitted-now=2 in-flight=2/);
});

test('CLI advances with --done', () => {
  const { dir, file } = tmpManifest('shard-done-', { shards: chain });
  const res = run(['--manifest', file, '--root', dir, '--done', 'a']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(jsonLines(res.stdout).map((t) => t.taskId), ['b', 'c']);
});

test('CLI --state-file: emitted shards are not skipped as done', () => {
  const { dir, file, state } = tmpManifest('shard-state-', {
    shards: chain,
    maxParallel: 1,
  });
  const first = run(['--manifest', file, '--root', dir, '--state-file', state]);
  assert.deepEqual(jsonLines(first.stdout).map((t) => t.taskId), ['a']);
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.deepEqual(saved.emitted, ['a']);
  assert.deepEqual(saved.done, []);

  // Re-run without --done: slot is full, nothing new, `a` not lost.
  const second = run([
    '--manifest',
    file,
    '--root',
    dir,
    '--state-file',
    state,
  ]);
  assert.equal(jsonLines(second.stdout).length, 0);
  assert.match(second.stderr, /in-flight=1 slots=0/);

  // Worker reports done via --result: dependents become ready.
  const third = run([
    '--manifest',
    file,
    '--root',
    dir,
    '--state-file',
    state,
    '--result',
    '{"shard":"a","status":"done","filesChanged":["a/x.dart"],' +
      '"needsIntegration":["export a/x.dart"],"notes":"ok"}',
  ]);
  assert.deepEqual(jsonLines(third.stdout).map((t) => t.taskId), ['b']);

  const status = run([
    '--manifest',
    file,
    '--root',
    dir,
    '--state-file',
    state,
    '--status',
  ]);
  const view = JSON.parse(status.stdout);
  assert.deepEqual(view.done, ['a']);
  assert.deepEqual(view.inFlight, ['b']);
  assert.deepEqual(view.ready, ['c']);
  assert.deepEqual(view.needsIntegration, [
    { shard: 'a', items: ['export a/x.dart'] },
  ]);
});

test('CLI --result blocked parks dependents; --reemit re-issues', () => {
  const { dir, file, state } = tmpManifest('shard-blocked-', {
    shards: chain,
  });
  run(['--manifest', file, '--root', dir, '--state-file', state]);
  const blocked = run([
    '--manifest',
    file,
    '--root',
    dir,
    '--state-file',
    state,
    '--result',
    '{"shard":"a","status":"blocked","notes":"needs API decision"}',
    '--status',
  ]);
  const view = JSON.parse(blocked.stdout);
  assert.deepEqual(view.blocked, ['a']);
  assert.deepEqual(view.pending, ['b']);
  const re = run([
    '--manifest',
    file,
    '--root',
    dir,
    '--state-file',
    state,
    '--reemit',
  ]);
  assert.deepEqual(jsonLines(re.stdout).map((t) => t.taskId), ['c']);
});

test('CLI honours legacy state files with only done[]', () => {
  const { dir, file, state } = tmpManifest('shard-legacy-', { shards: chain });
  fs.writeFileSync(state, JSON.stringify({ done: ['a'] }));
  const loaded = loadState(state);
  assert.ok(loaded.done.has('a'));
  const res = run(['--manifest', file, '--root', dir, '--state-file', state]);
  assert.deepEqual(jsonLines(res.stdout).map((t) => t.taskId), ['b', 'c']);
});

test('CLI env override changes the emitted model', () => {
  const { dir, file } = tmpManifest('shard-env-', { shards: chain });
  const res = run(['--manifest', file, '--root', dir], {
    ST_SHARD_MODEL_CODE: 'composer-2.5-fast',
    ST_SHARD_MODEL_CODE_CLAUDE: 'haiku',
  });
  const [task] = jsonLines(res.stdout);
  assert.equal(task.model, 'composer-2.5-fast');
  assert.equal(task.claudeModel, 'haiku');
});

test('CLI --wave previews batch view', () => {
  const { dir, file } = tmpManifest('shard-wave-', { shards: chain });
  const res = run(['--manifest', file, '--root', dir, '--wave', '1']);
  assert.deepEqual(jsonLines(res.stdout).map((t) => t.taskId), ['b']);
});

// ---------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------

test('validateManifest accepts a clean manifest with defaults', () => {
  const res = validateManifest({ shards: chain });
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.maxParallel, 6);
});

test('validateManifest enforces maxParallel 1..12', () => {
  assert.equal(validateManifest({ shards: chain, maxParallel: 12 }).ok, true);
  assert.match(
    validateManifest({ shards: chain, maxParallel: 13 }).errors[0],
    /between 1 and 12/,
  );
});

test('validateManifest rejects overlap, cycles, unknown deps, bad tier', () => {
  const overlap = validateManifest({
    shards: [
      { id: 'a', paths: ['pkg/lib/'] },
      { id: 'b', paths: ['pkg/lib/src/'] },
    ],
  });
  assert.match(overlap.errors.join('\n'), /path overlap/);
  const cycle = validateManifest({
    shards: [
      { id: 'a', paths: ['a/'], dependsOn: ['b'] },
      { id: 'b', paths: ['b/'], dependsOn: ['a'] },
    ],
  });
  assert.match(cycle.errors.join('\n'), /cycle/);
  const unknown = validateManifest({
    shards: [{ id: 'a', paths: ['a/'], dependsOn: ['zz'] }],
  });
  assert.match(unknown.errors.join('\n'), /unknown id/);
  const tier = validateManifest({
    shards: [{ id: 'a', paths: ['a/'], tier: 'fast' }],
  });
  assert.match(tier.errors.join('\n'), /tier must be one of/);
});

test('validateManifest: intra-package split needs sharedFiles', () => {
  const split = {
    shards: [
      { id: 'core', paths: ['flutter/packages/foo/lib/src/core/'] },
      { id: 'ui', paths: ['flutter/packages/foo/lib/src/ui/'] },
    ],
  };
  const missing = validateManifest(split);
  assert.equal(missing.ok, false);
  assert.match(
    missing.errors[0],
    /split package flutter\/packages\/foo\/ .*foo\/lib\/foo\.dart/,
  );
  const declared = validateManifest({
    ...split,
    sharedFiles: [
      'flutter/packages/foo/lib/foo.dart',
      'flutter/packages/foo/pubspec.yaml',
    ],
  });
  assert.equal(declared.ok, true, declared.errors.join('; '));
  const perShard = validateManifest({
    shards: split.shards.map((s) => ({
      ...s,
      sharedFiles: ['flutter/packages/foo/lib/foo.dart'],
    })),
  });
  assert.equal(perShard.ok, true, perShard.errors.join('; '));
});

test('validateManifest: shards may not own declared shared files', () => {
  const res = validateManifest({
    sharedFiles: ['pkg/pubspec.yaml'],
    shards: [
      { id: 'a', paths: ['pkg/pubspec.yaml'] },
      { id: 'b', paths: ['other/'] },
    ],
  });
  assert.match(res.errors.join('\n'), /integrator-owned/);
  const dirEntry = validateManifest({
    shards: [{ id: 'a', paths: ['a/'], sharedFiles: ['a/lib/'] }],
  });
  assert.match(dirEntry.errors.join('\n'), /must be files/);
});

test('validateManifest: shared-looking file inside a split package', () => {
  const res = validateManifest({
    sharedFiles: ['pkg/lib/pkg.dart'],
    shards: [
      { id: 'a', paths: ['pkg/lib/src/'] },
      { id: 'b', paths: ['pkg/pubspec.yaml'] },
    ],
  });
  assert.match(res.errors.join('\n'), /shared-looking file pkg\/pubspec/);
});

test('packageRoot / looksShared heuristics', () => {
  assert.equal(
    packageRoot('flutter/packages/foo/lib/src/x/'),
    'flutter/packages/foo/',
  );
  assert.equal(packageRoot('pkg/test/'), 'pkg/');
  assert.equal(
    packageRoot('plugins/sea-trials/.mcp.json'),
    'plugins/sea-trials/',
  );
  assert.equal(packageRoot('README.md'), '');
  assert.equal(looksShared('pkg/lib/pkg.dart'), true);
  assert.equal(looksShared('pkg/lib/src/pkg.dart'), false);
  assert.equal(looksShared('x/l10n/app_en.arb'), true);
  assert.equal(looksShared('x/pubspec.yaml'), true);
  assert.equal(looksShared('x/lib/src/a.dart'), false);
});

test('validator CLI passes the repo-root example shards.json', () => {
  const res = spawnSync(process.execPath, [validateScript, repoShardsJson], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Shard manifest OK/);
});

test('validator CLI fails on invalid JSON and stdin works', () => {
  const bad = spawnSync(process.execPath, [validateScript], {
    encoding: 'utf8',
    input: '{not json',
  });
  assert.equal(bad.status, 1);
  const good = spawnSync(process.execPath, [validateScript], {
    encoding: 'utf8',
    input: JSON.stringify({ shards: chain }),
  });
  assert.equal(good.status, 0, good.stderr);
});

// ---------------------------------------------------------------------
// suggest-shards-from-plan
// ---------------------------------------------------------------------

test('suggest: ```shards fence wins and yields a valid manifest', () => {
  const plan = `# Plan

Mentions \`flutter/packages/other/lib/\` which must be ignored.

\`\`\`shards
{
  "shards": [
    { "id": "core", "paths": ["flutter/packages/foo/lib/src/core/"],
      "tier": "code" },
    { "id": "ui", "paths": ["flutter/packages/foo/lib/src/ui/"],
      "dependsOn": ["core"] }
  ],
  "sharedFiles": ["flutter/packages/foo/lib/foo.dart"]
}
\`\`\`

## Parallel execution map

| id | paths | dependsOn | tier |
| --- | --- | --- | --- |
| x | x/ | - | code |
`;
  const manifest = parseShardsFence(plan);
  assert.equal(manifest.source, 'plan-shards-block');
  assert.deepEqual(manifest.shards.map((s) => s.id), ['core', 'ui']);
  assert.deepEqual(manifest.shards[1].dependsOn, ['core']);
  assert.equal(manifest.maxParallel, 2);
  assert.equal(suggestManifest(plan).source, 'plan-shards-block');
  const check = validateManifest(manifest);
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('suggest: shard array fence is accepted', () => {
  const plan = '```shards\n[{"id":"a","paths":["a/"]}]\n```\n';
  const manifest = parseShardsFence(plan);
  assert.deepEqual(manifest.shards, [
    { id: 'a', paths: ['a/'], dependsOn: [] },
  ]);
});

test('suggest: invalid fence JSON throws', () => {
  assert.throws(
    () => parseShardsFence('```shards\n{oops\n```'),
    /not valid JSON/,
  );
});

test('suggest: Parallel execution map table', () => {
  const plan = `# Plan

## Parallel execution map

| id | paths | dependsOn | tier | sharedFiles |
| --- | --- | --- | --- | --- |
| l10n | \`flutter/packages/l10n/\` | - | mechanical | |
| core | flutter/packages/foo/lib/src/core/ | l10n | code | flutter/packages/foo/lib/foo.dart |
| ui | flutter/packages/foo/lib/src/ui/, flutter/packages/foo/test/ | core l10n | | flutter/packages/foo/lib/foo.dart |

## Next section

| id | paths |
| --- | --- |
| ignored | zzz/ |
`;
  const manifest = parseExecutionMap(plan);
  assert.equal(manifest.source, 'plan-execution-map');
  assert.deepEqual(manifest.shards.map((s) => s.id), ['l10n', 'core', 'ui']);
  assert.equal(manifest.shards[0].tier, 'mechanical');
  assert.deepEqual(manifest.shards[0].dependsOn, []);
  assert.deepEqual(manifest.shards[2].paths, [
    'flutter/packages/foo/lib/src/ui/',
    'flutter/packages/foo/test/',
  ]);
  assert.deepEqual(manifest.shards[2].dependsOn, ['core', 'l10n']);
  assert.equal(manifest.shards[2].tier, undefined);
  assert.equal(manifest.maxParallel, 3);
  assert.equal(suggestManifest(plan).source, 'plan-execution-map');
  const check = validateManifest(manifest);
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('suggest: heuristic fallback is generic across monorepo layouts', () => {
  const plan = `# Plan
Touch \`flutter/packages/foo/lib/src/a.dart\` and
\`flutter/apps/client_app/lib/feature/\` plus \`web/packages/site/src/\`,
\`functions/src/sync/handler.ts\`, \`scripts/hooks/x.mjs\`, and
\`docs/plan/other.md\`. Also plain flutter/packages/bar/lib text.
Ignore https://example.com/a/b.
`;
  const manifest = heuristicShards(plan);
  assert.equal(manifest.source, 'heuristic');
  assert.deepEqual(
    manifest.shards.map((s) => s.paths[0]),
    [
      'flutter/apps/client_app/',
      'flutter/packages/bar/',
      'flutter/packages/foo/',
      'functions/src/',
      'scripts/hooks/',
      'web/packages/site/',
    ],
  );
  assert.deepEqual(
    manifest.shards.map((s) => s.id),
    ['client-app', 'bar', 'foo', 'src', 'hooks', 'site'],
  );
  assert.equal(manifest.maxParallel, 6);
  assert.equal(suggestManifest(plan).source, 'heuristic');
  assert.equal(validateManifest(manifest).ok, true);
});

test('packageRootOf handles files, nested roots and junk', () => {
  assert.equal(
    packageRootOf('flutter/packages/foo/lib/a.dart'),
    'flutter/packages/foo/',
  );
  assert.equal(packageRootOf('a/b/c/d/'), 'a/b/');
  assert.equal(packageRootOf('README.md'), null);
  assert.equal(packageRootOf('https://x/y'), null);
  assert.equal(packageRootOf('only/'), null);
});

test('suggest CLI writes JSON to stdout and hints to stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-'));
  const plan = path.join(dir, 'plan.md');
  fs.writeFileSync(plan, '```shards\n[{"id":"a","paths":["a/"]}]\n```\n');
  const res = spawnSync(process.execPath, [suggestScript, plan], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const manifest = JSON.parse(res.stdout);
  assert.equal(manifest.shards[0].id, 'a');
  assert.match(res.stderr, /plan-shards-block/);
  const out = path.join(dir, 'shards.json');
  fs.writeFileSync(out, res.stdout);
  const check = spawnSync(process.execPath, [validateScript, out], {
    encoding: 'utf8',
  });
  assert.equal(check.status, 0, check.stderr);
});
