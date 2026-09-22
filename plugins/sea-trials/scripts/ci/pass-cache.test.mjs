import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PASS_CACHE_SALT,
  directDepDirs,
  effectivePassCacheSalt,
  emptyPassCache,
  hasPassed,
  packageInputHash,
  parseGitLsFilesS,
  parsePassCache,
  recordPassed,
} from './pass-cache.mjs';

test('empty cache never reports a pass', () => {
  assert.equal(hasPassed(emptyPassCache(), 'packages/app_ui', 'abc'), false);
});

test('recordPassed is visible to hasPassed', () => {
  const cache = recordPassed(emptyPassCache(), 'packages/app_ui', 'abc');
  assert.equal(hasPassed(cache, 'packages/app_ui', 'abc'), true);
  assert.equal(hasPassed(cache, 'packages/app_ui', 'other'), false);
});

test('a different salt invalidates every sentinel', () => {
  const cache = recordPassed(emptyPassCache(), 'packages/app_ui', 'abc');
  assert.equal(
    hasPassed({ ...cache, salt: 'old-salt' }, 'packages/app_ui', 'abc'),
    false,
  );
});

test('parsePassCache recovers from junk', () => {
  assert.deepEqual(parsePassCache(''), emptyPassCache());
  assert.deepEqual(parsePassCache('not-json'), emptyPassCache());
  assert.deepEqual(parsePassCache('[]'), emptyPassCache());
});

test('parsePassCache round-trips recorded hashes', () => {
  const cache = recordPassed(emptyPassCache(), 'apps/client_app', 'deadbeef');
  const parsed = parsePassCache(JSON.stringify(cache));
  assert.equal(hasPassed(parsed, 'apps/client_app', 'deadbeef'), true);
  assert.equal(parsed.salt, effectivePassCacheSalt());
});

test('effectivePassCacheSalt includes FLUTTER_REVISION when set', () => {
  const prev = process.env.FLUTTER_REVISION;
  process.env.FLUTTER_REVISION = 'abc123';
  try {
    assert.equal(
      effectivePassCacheSalt(),
      `${PASS_CACHE_SALT}:abc123`,
    );
  } finally {
    if (prev === undefined) delete process.env.FLUTTER_REVISION;
    else process.env.FLUTTER_REVISION = prev;
  }
});

test('parseGitLsFilesS reads blob ids and paths', () => {
  const stdout = [
    '100644 abc111 0\tpackages/app_ui/lib/a.dart',
    '100644 def222 0\tpackages/app_ui/test/a_test.dart',
    '',
  ].join('\n');
  assert.deepEqual(parseGitLsFilesS(stdout), [
    { path: 'packages/app_ui/lib/a.dart', blob: 'abc111' },
    { path: 'packages/app_ui/test/a_test.dart', blob: 'def222' },
  ]);
});

const ENTRIES = [
  { path: 'packages/app_ui/lib/a.dart', blob: 'ui-lib' },
  { path: 'packages/app_ui/dart_test.yaml', blob: 'ui-yaml' },
  { path: 'packages/l10n/lib/b.dart', blob: 'l10n-lib' },
  { path: 'apps/client_app/lib/c.dart', blob: 'app-lib' },
];

test('package hash includes every tracked file, not an allowlist', () => {
  const withYaml = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: [],
    entries: ENTRIES,
    lockfileBlob: 'lock1',
  });
  const withoutYaml = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: [],
    entries: ENTRIES.filter((e) => !e.path.endsWith('dart_test.yaml')),
    lockfileBlob: 'lock1',
  });
  assert.notEqual(withYaml, withoutYaml);
});

test('changing a direct workspace dep changes the hash', () => {
  const before = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: ['packages/l10n'],
    entries: ENTRIES,
    lockfileBlob: 'lock1',
  });
  const after = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: ['packages/l10n'],
    entries: ENTRIES.map((e) =>
      e.path === 'packages/l10n/lib/b.dart' ? { ...e, blob: 'changed' } : e,
    ),
    lockfileBlob: 'lock1',
  });
  assert.notEqual(before, after);
});

test('an unrelated package file does not change the hash', () => {
  const before = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: [],
    entries: ENTRIES,
    lockfileBlob: 'lock1',
  });
  const after = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: [],
    entries: ENTRIES.map((e) =>
      e.path === 'apps/client_app/lib/c.dart' ? { ...e, blob: 'nope' } : e,
    ),
    lockfileBlob: 'lock1',
  });
  assert.equal(before, after);
});

test('lockfile blob is part of every package hash', () => {
  const a = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: [],
    entries: ENTRIES,
    lockfileBlob: 'lock1',
  });
  const b = packageInputHash({
    packageDir: 'packages/app_ui',
    depDirs: [],
    entries: ENTRIES,
    lockfileBlob: 'lock2',
  });
  assert.notEqual(a, b);
});

test('directDepDirs inverts dependentsByName', () => {
  const graph = {
    nameByDir: new Map([
      ['packages/l10n', 'l10n'],
      ['packages/app_ui', 'app_ui'],
    ]),
    dirByName: new Map([
      ['l10n', 'packages/l10n'],
      ['app_ui', 'packages/app_ui'],
    ]),
    dependentsByName: new Map([['l10n', new Set(['app_ui'])]]),
  };
  assert.deepEqual(directDepDirs(graph, 'packages/app_ui'), ['packages/l10n']);
  assert.deepEqual(directDepDirs(graph, 'packages/l10n'), []);
});

test('resolve-flutter-channel-head prints a 40-char revision', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const result = spawnSync(
    'node',
    ['scripts/ci/resolve-flutter-channel-head.mjs'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FLUTTER_CHANNEL: 'main' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^revision=[0-9a-f]{40}\n$/);
});
