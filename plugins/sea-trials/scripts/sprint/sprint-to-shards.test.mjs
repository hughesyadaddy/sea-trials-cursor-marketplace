import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseExecutionMap } from '../../skills/st-build-with-subagents/scripts/suggest-shards-from-plan.mjs';
import { validateManifest } from '../../skills/st-build-with-subagents/scripts/validate-shard-manifest.mjs';
import {
  buildManifest,
  goalLine,
  inferPathsFromText,
  normalisePath,
  renderExecutionMap,
  shardIdForStory,
  tierForStory,
} from './sprint-to-shards.mjs';

const SCRIPT = fileURLToPath(new URL('./sprint-to-shards.mjs', import.meta.url));
const SUGGEST = fileURLToPath(
  new URL(
    '../../skills/st-build-with-subagents/scripts/suggest-shards-from-plan.mjs',
    import.meta.url,
  ),
);

// ===========================================================================
// FIXTURES
// ===========================================================================

/** Write `files` ({ name: content }) into a fresh temp folder. */
function fixture(files, root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-'))) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    fs.writeFileSync(full, body);
  }
  return root;
}

/**
 * A contract-shaped story.
 *
 * @param {{
 *   title: string, sp?: number, blockedBy?: string, labels?: string,
 *   kind?: string, goal?: string, files?: string[], subFiles?: string[],
 *   body?: string,
 * }} o
 */
function story(o) {
  const meta = [
    `**SP:** ${o.sp ?? 3}`,
    o.blockedBy ? `**Blocked by:** ${o.blockedBy}` : '',
    o.labels ? `**Labels:** ${o.labels}` : '',
    o.kind ? `**Kind:** ${o.kind}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const files = o.files
    ? `## Files to touch\n\n${o.files.map((f) => `- \`${f}\` - edit`).join('\n')}\n\n`
    : '';
  const subFiles = o.subFiles
    ? `**Files to change**\n\n${o.subFiles.map((f) => `- \`${f}\``).join('\n')}\n\n`
    : '';
  return (
    `# ${o.title}\n\n${meta}\n\n## Description\n\n` +
    `${o.goal ?? 'As a user, I want the thing.'}\n\n${o.body ?? ''}${files}` +
    `## Acceptance criteria\n\n- [ ] Works\n\n## Subtasks\n\n` +
    `### Subtask 1.1: Do it\n\n**SP:** 1\n\n${subFiles}` +
    `**Acceptance criteria**\n\n- [ ] Step\n`
  );
}

const EPIC = '# Epic: Billing parity\n\n## Goal\n\nShip it.\n';

function simpleEpic() {
  return fixture({
    '00-epic.md': EPIC,
    '01-us1-schema.md': story({
      title: 'User Story 1: Invoice schema',
      kind: 'migration',
      goal: 'Add the invoices table.',
      files: ['supabase/migrations/20260901_invoices.sql'],
    }),
    '02-us2-repo.md': story({
      title: 'User Story 2: Invoice repository',
      blockedBy: 'US1',
      goal: '**Goal:** Expose invoices to the app.',
      files: ['flutter/packages/invoice_repository/lib/src/'],
      subFiles: ['flutter/packages/invoice_repository/test/'],
    }),
    '03-us3-verify.md': story({
      title: 'User Story 3: Verify invoice flow',
      labels: 'qa',
      blockedBy: 'US2',
      files: ['flutter/apps/client_app/integration_test/invoice/'],
    }),
  });
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ===========================================================================
// UNIT HELPERS
// ===========================================================================

test('shardIdForStory derives us<N>-<slug> ids from file names', () => {
  const id = (file, storyId = '1') => shardIdForStory({ file, id: storyId });
  assert.equal(id('03-us3-invoice-pdf.md'), 'us3-invoice-pdf');
  assert.equal(id('03-us3a-Toggle_Fix.md'), 'us3a-toggle-fix');
  assert.equal(id('02-b-us12-x.md'), 'us12-x');
  assert.equal(id('07_legacy_slug.md', '07'), 'us07-legacy-slug');
  assert.equal(id('05-us5.md'), 'us5');
});

test('normalisePath yields repo-relative POSIX prefixes', () => {
  assert.equal(normalisePath('`lib/a.dart`'), 'lib/a.dart');
  assert.equal(normalisePath('./lib/src'), 'lib/src/');
  assert.equal(normalisePath('lib\\win\\file.ts'), 'lib/win/file.ts');
  assert.equal(normalisePath('(lib/a.dart),'), 'lib/a.dart');
  assert.equal(normalisePath('lib/a.dart.'), 'lib/a.dart');
  assert.equal(normalisePath('../escape.dart'), null);
  assert.equal(normalisePath('https://x.y/z'), null);
  assert.equal(normalisePath(''), null);
});

test('normalisePath uses --repo-root to relativise and detect dirs', () => {
  const root = fixture({ 'flutter/apps/x/lib/main.dart': '', 'Makefile': '' });
  const abs = path.join(root, 'flutter', 'apps', 'x', 'lib', 'main.dart');
  const opts = { repoRoot: root };
  assert.equal(normalisePath(abs, opts), 'flutter/apps/x/lib/main.dart');
  assert.equal(normalisePath('flutter/apps/x/lib', opts), 'flutter/apps/x/lib/');
  assert.equal(normalisePath('Makefile', opts), 'Makefile');
  assert.equal(normalisePath(path.join(os.tmpdir(), '..', 'x.dart'), opts), null);
});

test('inferPathsFromText finds repo-looking tokens, skips markdown', () => {
  const text =
    'Edit `flutter/apps/client_app/lib/a.dart` and web/apps/site/src/. ' +
    'See docs/plan/x.md and flutter/packages/foo/README.md; also ' +
    '(supabase/migrations/1.sql) again flutter/apps/client_app/lib/a.dart';
  assert.deepEqual(inferPathsFromText(text), [
    'flutter/apps/client_app/lib/a.dart',
    'web/apps/site/src/',
    'supabase/migrations/1.sql',
  ]);
});

test('goalLine prefers **Goal:**, then ## Description prose', () => {
  assert.equal(goalLine('intro\n\n**Goal:** Ship **it** with `x`.'), 'Ship it with x.');
  assert.equal(
    goalLine('## Context\n\nold\n\n## Description\n\n- list\n\nAs a user, I want.'),
    'As a user, I want.',
  );
  assert.equal(goalLine('| a |\n|---|\n\nFirst prose.'), 'First prose.');
  assert.equal(goalLine(''), '');
});

test('tierForStory maps kind, labels, title and sections', () => {
  const s = (o) => ({ summary: 'T', labels: [], description: '', kind: null, ...o });
  assert.equal(tierForStory(s({ kind: 'verify' })), 'mechanical');
  assert.equal(tierForStory(s({ labels: ['docs'] })), 'mechanical');
  assert.equal(tierForStory(s({ summary: 'Rename the l10n keys' })), 'mechanical');
  assert.equal(tierForStory(s({ kind: 'migration' })), 'reasoning');
  assert.equal(tierForStory(s({ summary: 'Schema change' })), 'reasoning');
  assert.equal(tierForStory(s({ labels: ['security'] })), 'reasoning');
  assert.equal(tierForStory(s({ description: '## What to test\n\nx' })), 'mechanical');
  assert.equal(tierForStory(s({ description: '## Commands\n\n1. x' })), 'reasoning');
  assert.equal(tierForStory(s({ kind: 'verify', labels: ['migration'] })), 'reasoning');
  assert.equal(tierForStory(s({ summary: 'Invoice page' })), 'code');
});

// ===========================================================================
// MANIFEST
// ===========================================================================

test('simple 3-story epic → valid manifest with ids, deps, tiers', () => {
  const { manifest, validation, needsPaths, hints } = buildManifest(simpleEpic());
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
  assert.deepEqual(needsPaths, []);
  assert.deepEqual(validateManifest(manifest).errors, []);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.maxParallel, 3);
  assert.deepEqual(manifest.sharedFiles, []);
  assert.deepEqual(
    manifest.shards.map((s) => [s.id, s.tier, s.dependsOn]),
    [
      ['us1-schema', 'reasoning', []],
      ['us2-repo', 'code', ['us1-schema']],
      ['us3-verify', 'mechanical', ['us2-repo']],
    ],
  );
  assert.deepEqual(manifest.shards[1].paths, [
    'flutter/packages/invoice_repository/lib/src/',
    'flutter/packages/invoice_repository/test/',
  ]);
  assert.equal(
    manifest.shards[0].summary,
    'User Story 1: Invoice schema - Add the invoices table.',
  );
  assert.equal(
    manifest.shards[1].summary,
    'User Story 2: Invoice repository - Expose invoices to the app.',
  );
  assert.equal(manifest.shards[0].sharedFiles, undefined);
  assert.equal(hints.length, 0, hints.join('\n'));
});

test('shared pubspec listed by two stories is lifted to sharedFiles', () => {
  const dir = fixture({
    '00-epic.md': EPIC,
    '01-us1-a.md': story({
      title: 'A',
      files: ['flutter/packages/foo/pubspec.yaml', 'flutter/packages/foo/lib/src/a/'],
    }),
    '02-us2-b.md': story({
      title: 'B',
      files: ['flutter/packages/foo/pubspec.yaml', 'flutter/packages/foo/lib/src/b/'],
    }),
    '03-us3-c.md': story({
      title: 'C',
      files: ['flutter/packages/bar/pubspec.yaml', 'flutter/packages/bar/lib/'],
    }),
  });
  const { manifest, validation, hints } = buildManifest(dir);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(manifest.sharedFiles, ['flutter/packages/foo/pubspec.yaml']);
  const [a, b, c] = manifest.shards;
  assert.deepEqual(a.paths, ['flutter/packages/foo/lib/src/a/']);
  assert.deepEqual(a.sharedFiles, ['flutter/packages/foo/pubspec.yaml']);
  assert.deepEqual(b.paths, ['flutter/packages/foo/lib/src/b/']);
  assert.deepEqual(b.sharedFiles, ['flutter/packages/foo/pubspec.yaml']);
  assert.deepEqual(a.dependsOn, []);
  assert.deepEqual(b.dependsOn, []);
  // bar is owned by a single story: pubspec stays with the shard.
  assert.deepEqual(c.paths.sort(), [
    'flutter/packages/bar/lib/',
    'flutter/packages/bar/pubspec.yaml',
  ]);
  assert.equal(c.sharedFiles, undefined);
  assert.ok(hints.some((h) => h.includes('→ sharedFiles')));
});

test('split package without a listed shared file gets defaults declared', () => {
  const dir = fixture({
    '01-us1-a.md': story({ title: 'A', files: ['flutter/packages/foo/lib/src/a/'] }),
    '02-us2-b.md': story({ title: 'B', files: ['flutter/packages/foo/lib/src/b/'] }),
    '03-us3-c.md': story({ title: 'C', files: ['web/apps/site/src/c/'] }),
    '04-us4-d.md': story({ title: 'D', files: ['web/apps/site/src/d/'] }),
  });
  const { manifest, validation, hints } = buildManifest(dir);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(manifest.sharedFiles, [
    'flutter/packages/foo/lib/foo.dart',
    'flutter/packages/foo/pubspec.yaml',
    'web/apps/site/package.json',
  ]);
  assert.ok(hints.some((h) => h.includes('split package flutter/packages/foo/')));
  assert.ok(hints.some((h) => h.includes('split package web/apps/site/')));
});

test('barrel owned by one story inside a split package is lifted', () => {
  const dir = fixture({
    '01-us1-a.md': story({
      title: 'A',
      files: ['flutter/packages/foo/lib/foo.dart', 'flutter/packages/foo/lib/src/a/'],
    }),
    '02-us2-b.md': story({ title: 'B', files: ['flutter/packages/foo/lib/src/b/'] }),
  });
  const { manifest, validation } = buildManifest(dir);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(manifest.sharedFiles, ['flutter/packages/foo/lib/foo.dart']);
  assert.deepEqual(manifest.shards[0].paths, ['flutter/packages/foo/lib/src/a/']);
  assert.deepEqual(manifest.shards[0].sharedFiles, ['flutter/packages/foo/lib/foo.dart']);
});

test('overlapping paths → earlier story owns, later one depends on it', () => {
  const dir = fixture({
    '01-us1-a.md': story({
      title: 'A',
      files: ['flutter/apps/client_app/lib/billing/', 'web/apps/site/src/x.ts'],
    }),
    '02-us2-b.md': story({
      title: 'B',
      files: [
        'flutter/apps/client_app/lib/billing/invoice_page.dart',
        'flutter/apps/client_app/lib/settings/',
      ],
    }),
    '03-us3-c.md': story({ title: 'C', files: ['web/apps/site/src/'] }),
  });
  const { manifest, validation, hints, needsPaths } = buildManifest(dir);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(needsPaths, ['us3-c']);
  assert.deepEqual(validateManifest(manifest).errors, [
    'shard us3-c needs non-empty paths[]',
  ]);
  const [a, b, c] = manifest.shards;
  assert.deepEqual(a.paths, [
    'flutter/apps/client_app/lib/billing/',
    'web/apps/site/src/x.ts',
  ]);
  assert.deepEqual(a.dependsOn, []);
  assert.deepEqual(b.paths, ['flutter/apps/client_app/lib/settings/']);
  assert.deepEqual(b.dependsOn, ['us1-a']);
  assert.deepEqual(c.paths, []);
  assert.deepEqual(c.dependsOn, ['us1-a']);
  assert.ok(hints.some((h) => /us2-b: .*overlaps .*owned by us1-a/.test(h)));
});

test('story without files infers paths from its text', () => {
  const dir = fixture({
    '01-us1-a.md': story({
      title: 'A',
      body:
        'Change `flutter/apps/client_app/lib/boot/boot_page.dart` and the ' +
        'function in functions/src/sync.ts. Ignore docs/plan/x.md.\n\n',
    }),
  });
  const { manifest, hints, needsPaths } = buildManifest(dir);
  assert.deepEqual(needsPaths, []);
  assert.deepEqual(manifest.shards[0].paths, [
    'flutter/apps/client_app/lib/boot/boot_page.dart',
    'functions/src/sync.ts',
  ]);
  assert.ok(hints.some((h) => h.includes('inferred 2 path(s)')));
});

test('story with no paths at all is emitted empty with a warning', () => {
  const dir = fixture({
    '01-us1-a.md': story({ title: 'A', files: ['flutter/apps/x/lib/'] }),
    '02-us2-b.md': story({ title: 'B', goal: 'Nothing concrete here.' }),
  });
  const { manifest, validation, needsPaths, hints } = buildManifest(dir);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(needsPaths, ['us2-b']);
  assert.deepEqual(manifest.shards[1].paths, []);
  assert.ok(hints.some((h) => h === 'shard us2-b: needs paths (no files listed or all owned elsewhere)'));
  // The emitted manifest itself does not pass the validator until filled.
  assert.ok(validateManifest(manifest).errors.some((e) => e.includes('needs non-empty paths')));
});

test('unknown **Blocked by:** target is dropped with a hint', () => {
  const dir = fixture({
    '01-us1-a.md': story({ title: 'A', blockedBy: 'US9', files: ['flutter/apps/x/lib/'] }),
  });
  const { manifest, validation, hints } = buildManifest(dir);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(manifest.shards[0].dependsOn, []);
  assert.ok(hints.some((h) => h.includes('blocked by US9')));
});

test('--max-parallel and default clamp', () => {
  const dir = simpleEpic();
  assert.equal(buildManifest(dir).manifest.maxParallel, 3);
  assert.equal(buildManifest(dir, { maxParallel: 2 }).manifest.maxParallel, 2);
  const one = fixture({ '01-us1-a.md': story({ title: 'A', files: ['x/lib/'] }) });
  assert.equal(buildManifest(one).manifest.maxParallel, 1);
});

// ===========================================================================
// MULTI-EPIC ROOT / --epic
// ===========================================================================

function multiEpicRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-root-'));
  fixture(
    {
      'sprint-a/00-epic.md': '# Epic: Alpha work\n\nbody\n',
      'sprint-a/01-us1-x.md': story({ title: 'AX', files: ['flutter/apps/a/lib/'] }),
      'sprint-a/sprint.json': { projectKey: 'STD', epicKey: 'STD-100' },
      'sprint-b/00-epic.md': '# Epic: Beta work\n\nbody\n',
      'sprint-b/01-us1-y.md': story({ title: 'BY', files: ['flutter/apps/b/lib/'] }),
      'notes/README.md': '# not a sprint',
    },
    root,
  );
  return root;
}

test('root with several sprint folders → prefixed shard ids', () => {
  const { manifest, validation } = buildManifest(multiEpicRoot());
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(
    manifest.shards.map((s) => s.id),
    ['sprint-a-us1-x', 'sprint-b-us1-y'],
  );
});

test('--epic filters by folder name, epic title slug, or epicKey', () => {
  const root = multiEpicRoot();
  for (const wanted of ['sprint-b', 'Beta work', 'beta-work']) {
    const { manifest } = buildManifest(root, { epic: wanted });
    assert.deepEqual(manifest.shards.map((s) => s.id), ['us1-y'], wanted);
  }
  const byKey = buildManifest(root, { epic: 'STD-100' });
  assert.deepEqual(byKey.manifest.shards.map((s) => s.id), ['us1-x']);
  assert.throws(() => buildManifest(root, { epic: 'nope' }), /no epic matches/);
});

// ===========================================================================
// EXECUTION MAP ROUND TRIP
// ===========================================================================

test('execution map table is parsed back into the same shards', () => {
  const dir = fixture({
    '00-epic.md': EPIC,
    '01-us1-a.md': story({
      title: 'A | with pipe',
      goal: 'First goal.',
      files: ['flutter/packages/foo/pubspec.yaml', 'flutter/packages/foo/lib/src/a/'],
    }),
    '02-us2-b.md': story({
      title: 'B',
      blockedBy: 'US1',
      files: ['flutter/packages/foo/pubspec.yaml', 'flutter/packages/foo/lib/src/b/'],
    }),
    '03-us3-c.md': story({ title: 'C', kind: 'docs' }),
  });
  const { manifest } = buildManifest(dir);
  const table = renderExecutionMap(manifest);
  assert.ok(table.startsWith('## Parallel execution map\n'));
  assert.ok(table.includes('| id | paths | dependsOn | tier | sharedFiles | summary |'));
  assert.equal(table.includes('A | with pipe'), false);
  const parsed = parseExecutionMap(`# Plan\n\nintro\n\n${table}\n## Next\n`);
  assert.equal(parsed.source, 'plan-execution-map');
  assert.deepEqual(parsed.shards, manifest.shards);
});

test('execution map round-trips through the suggest-shards CLI too', () => {
  const dir = simpleEpic();
  const { manifest } = buildManifest(dir);
  const plan = path.join(dir, 'plan.md');
  fs.writeFileSync(plan, `# Plan\n\n${renderExecutionMap(manifest)}`);
  const res = spawnSync(process.execPath, [SUGGEST, plan], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.shards, manifest.shards);
});

// ===========================================================================
// CLI
// ===========================================================================

test('CLI prints pure JSON on stdout, hints on stderr, exit 0', () => {
  const dir = simpleEpic();
  const { code, stdout, stderr } = run([dir]);
  assert.equal(code, 0, stderr);
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.shards.length, 3);
  assert.ok(stderr.includes('3 shard(s)'));
  assert.ok(stderr.includes('run validate-shard-manifest.mjs'));
});

test('CLI --out / --out-map write files; --dry-run does not', () => {
  const dir = simpleEpic();
  const out = path.join(dir, 'shards.json');
  const map = path.join(dir, 'map.md');
  const dry = run([dir, '--out', out, '--out-map', map, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(map), false);
  assert.equal(JSON.parse(dry.stdout).shards.length, 3);

  const wet = run([dir, '--out', out, '--out-map', map, '--max-parallel', '2']);
  assert.equal(wet.code, 0, wet.stderr);
  assert.equal(wet.stdout, '');
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.maxParallel, 2);
  assert.ok(fs.readFileSync(map, 'utf8').startsWith('## Parallel execution map'));
  assert.ok(wet.stderr.includes(`wrote ${out}`));
});

test('CLI warns "needs paths" and still emits the manifest', () => {
  const dir = fixture({
    '01-us1-a.md': story({ title: 'A', files: ['flutter/apps/x/lib/'] }),
    '02-us2-b.md': story({ title: 'B' }),
  });
  const { code, stdout, stderr } = run([dir]);
  assert.equal(code, 0, stderr);
  assert.ok(stderr.includes('shard us2-b: needs paths'));
  assert.ok(stderr.includes('1 shard(s) need paths'));
  assert.deepEqual(JSON.parse(stdout).shards[1].paths, []);
});

test('CLI --epic filter', () => {
  const root = multiEpicRoot();
  const { code, stdout } = run([root, '--epic', 'sprint-a']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).shards.map((s) => s.id), ['us1-x']);
  const miss = run([root, '--epic', 'zzz']);
  assert.equal(miss.code, 1);
  assert.ok(miss.stderr.includes('no epic matches'));
});

test('validator failure (dependency cycle) propagates as exit 1', () => {
  const dir = fixture({
    '01-us1-a.md': story({ title: 'A', blockedBy: 'US2', files: ['flutter/apps/a/lib/'] }),
    '02-us2-b.md': story({ title: 'B', blockedBy: 'US1', files: ['flutter/apps/b/lib/'] }),
  });
  const api = buildManifest(dir);
  assert.equal(api.validation.ok, false);
  assert.ok(api.validation.errors.some((e) => e.includes('cycle detected')));
  const { code, stdout, stderr } = run([dir]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('manifest invalid'));
  assert.ok(stderr.includes('cycle detected'));
});

test('CLI usage errors exit 2', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run([os.tmpdir(), '--max-parallel', '99']).code, 2);
  assert.equal(run([path.join(os.tmpdir(), 'does-not-exist-sts')]).code, 2);
});
