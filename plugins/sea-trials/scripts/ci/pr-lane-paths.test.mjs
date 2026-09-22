import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LANE_INFRA_GLOBS,
  REPO_ROOT_TREE,
  anyPathMatches,
  fingerprintFromRevParse,
  globMatches,
  matchLanePaths,
  fingerprintTreePaths,
  parseLanePathArgs,
  revParseSpec,
  treePathsFromGlobs,
} from './pr-lane-paths.mjs';

test('the lane registry fails every lane open', () => {
  // A PR that only rewrites the lane registry (the checkout's remaining
  // scripts/ci surface) must not be graded by the config it replaces.
  // The matcher itself ships in the plugin, so a plugin bump — not a repo
  // path — is what changes it.
  assert.equal(
    matchLanePaths(['scripts/ci/pr-lane-registry.mjs'], ['functions/**']),
    true,
  );
  assert.ok(LANE_INFRA_GLOBS.includes('scripts/ci/**'));
  assert.ok(
    LANE_INFRA_GLOBS.includes('.github/actions/setup-flutter-stable/**'),
  );
});

test('a leading ** glob fingerprints the whole repo tree', () => {
  // Dropping it would give every PR that touches only a `**/*.arb` file
  // the same fingerprint, so the second such PR hits the first one's
  // pass sentinel and skips a lane whose inputs changed.
  assert.deepEqual(treePathsFromGlobs(['**/*.arb']), [REPO_ROOT_TREE]);
  assert.deepEqual(treePathsFromGlobs(['**/*.arb', 'flutter/**/*.dart']), [
    REPO_ROOT_TREE,
    'flutter',
  ]);
});

test('revParseSpec maps the repo-root sentinel to a bare HEAD:', () => {
  // `git rev-parse HEAD:.` is a hard error, not the root tree.
  assert.equal(revParseSpec(REPO_ROOT_TREE), 'HEAD:');
  assert.equal(revParseSpec('flutter'), 'HEAD:flutter');
});

test('prefix /** matches the dir and everything under it', () => {
  assert.equal(globMatches('flutter/**', 'flutter/pubspec.yaml'), true);
  assert.equal(globMatches('flutter/**', 'flutter'), true);
  assert.equal(globMatches('flutter/**', 'functions/src/a.ts'), false);
});

test('single-star does not cross directories', () => {
  assert.equal(
    globMatches('scripts/setup-secrets*', 'scripts/setup-secrets.sh'),
    true,
  );
  assert.equal(
    globMatches('scripts/setup-secrets*', 'scripts/setup-secrets.test.mjs'),
    true,
  );
  assert.equal(
    globMatches('scripts/setup-secrets*', 'scripts/env/setup-secrets.sh'),
    false,
  );
});

test('**/*.arb matches arb files in any directory', () => {
  assert.equal(globMatches('**/*.arb', 'flutter/packages/l10n/lib/a.arb'), true);
  assert.equal(globMatches('**/*.arb', 'app_en.arb'), true);
  assert.equal(globMatches('**/*.arb', 'flutter/packages/l10n/lib/a.dart'), false);
});

test('literal file matches only that file', () => {
  assert.equal(
    globMatches(
      'supabase/checks/rest_schema_surface_check.sql',
      'supabase/checks/rest_schema_surface_check.sql',
    ),
    true,
  );
  assert.equal(
    globMatches(
      'supabase/checks/rest_schema_surface_check.sql',
      'supabase/checks/other.sql',
    ),
    false,
  );
});

test('a functions-only PR does not match flutter jobs', () => {
  assert.equal(
    anyPathMatches(['functions/src/index.ts'], ['flutter/**', 'scripts/ci/**']),
    false,
  );
});

test('a flutter file matches the dart lanes', () => {
  assert.equal(
    anyPathMatches(
      ['flutter/packages/app_ui/lib/a.dart'],
      ['flutter/**', 'scripts/hooks/**'],
    ),
    true,
  );
});

test('empty globs fail open (run the job)', () => {
  assert.equal(anyPathMatches(['docs/a.md'], []), true);
});

test('workflow-only PRs still match every lane', () => {
  assert.equal(
    matchLanePaths(
      ['.github/workflows/pr-checks.yml'],
      ['flutter/**', 'scripts/ci/**'],
    ),
    true,
  );
});

test('pass-cache action edits still match every lane', () => {
  assert.equal(
    matchLanePaths(
      ['.github/actions/pr-lane-pass-cache/action.yml'],
      ['supabase/migrations/**'],
    ),
    true,
  );
});

test('domain-only PRs still miss unrelated lanes', () => {
  assert.equal(
    matchLanePaths(['functions/src/index.ts'], ['flutter/**']),
    false,
  );
});

test('treePathsFromGlobs strips glob suffixes', () => {
  assert.deepEqual(
    treePathsFromGlobs([
      'flutter/**',
      'scripts/hooks/**',
      'scripts/ci/run-lane.mjs',
      'scripts/setup-secrets*',
      '**/*.arb',
    ]),
    [
      // `**/*.arb` names no subtree, so it widens to the whole repo
      // rather than vanishing from the fingerprint.
      REPO_ROOT_TREE,
      'flutter',
      'scripts',
      'scripts/ci/run-lane.mjs',
      'scripts/hooks',
    ],
  );
});

test('fingerprintFromRevParse keeps path order and marks misses', () => {
  const sha = 'a'.repeat(40);
  assert.equal(
    fingerprintFromRevParse(`${sha}\nnot-a-hash\n`, ['flutter', 'missing']),
    `flutter:${sha}\nmissing:missing`,
  );
});

test('parseLanePathArgs splits --globs on newlines', () => {
  assert.deepEqual(
    parseLanePathArgs(['--match', '--globs', 'flutter/**\nscripts/ci/**']),
    {
      match: true,
      fingerprint: false,
      globs: ['flutter/**', 'scripts/ci/**'],
      changed: [],
    },
  );
});

const SCRIPT = fileURLToPath(new URL('./pr-lane-paths.mjs', import.meta.url));

/** Real repo so `git rev-parse HEAD:<dir>` has something to resolve. */
function fingerprintInFixture(globs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-fp-'));
  const run = (args, opts = {}) =>
    spawnSync(args[0], args.slice(1), { cwd: dir, encoding: 'utf8', ...opts });
  try {
    run(['git', 'init', '-q']);
    run(['git', 'config', 'user.email', 't@example.com']);
    run(['git', 'config', 'user.name', 'T']);
    for (const f of [
      '.github/workflows/pr-checks.yml',
      '.github/actions/pr-lane-pass-cache/action.yml',
      'scripts/ci/pr-lane-registry.mjs',
      'flutter/lib/main.dart',
    ]) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '#\n');
    }
    run(['git', 'add', '-A']);
    run(['git', 'commit', '-qm', 'init']);
    const r = run([
      process.execPath,
      SCRIPT,
      '--fingerprint',
      '--globs',
      globs.join('\n'),
    ]);
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the CLI fingerprint covers every lane-infrastructure tree', () => {
  // Observes main() end to end, not just the exported helper. The bug
  // this replaces lived inside main() under `c8 ignore`, where a test
  // that only imported the constant passed while the real second copy
  // had already drifted. Spawning the CLI is the only way to see it.
  const { status, stdout } = fingerprintInFixture(['flutter/**']);
  assert.equal(status, 0, stdout);
  // The expected set is written out, NOT computed by calling
  // fingerprintTreePaths — using the implementation as its own oracle
  // means deleting the LANE_INFRA_GLOBS union from inside that function
  // leaves this green, which is the same self-referential trap as the
  // bug this test replaced, one layer up.
  for (const tree of [
    '.github/actions/pr-lane-pass-cache',
    '.github/workflows/pr-checks.yml',
    'scripts/ci',
    'flutter',
  ]) {
    assert.ok(
      stdout.includes(`${tree}:`),
      `fingerprint omitted ${tree}\n${stdout}`,
    );
  }
});

test('a non-infra repo script change skips unrelated product lanes', () => {
  // This is the fast lane, and it already falls out of the matcher: a
  // file that is not lane infrastructure only runs the lanes whose own
  // globs claim it. Asserted here because nothing pinned it before, and
  // a well-meaning widening of LANE_INFRA_GLOBS (say, to `scripts/**`)
  // would silently make every repo script change run all 18 lanes again.
  assert.equal(
    matchLanePaths(['scripts/setup-secrets.sh'], ['flutter/**']),
    false,
  );
  assert.equal(
    matchLanePaths(['scripts/setup-secrets.sh'], ['scripts/**']),
    true,
  );
});

test('lane infrastructure still fails every lane open', () => {
  // The counterweight to the test above. These three cannot take the
  // fast lane: pr-checks.yml can redefine any lane, the registry can
  // redefine any lane's paths, and the matcher must not grade the PR
  // that rewrites either.
  for (const file of [
    '.github/workflows/pr-checks.yml',
    '.github/actions/pr-lane-pass-cache/action.yml',
    'scripts/ci/pr-lane-registry.mjs',
  ]) {
    assert.equal(matchLanePaths([file], ['flutter/**']), true, file);
  }
});
