import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('./assert-workflow-paths.sh', import.meta.url),
);

/**
 * Run the guard against a synthetic repo.
 *
 * The script ships in the plugin and takes the checkout from
 * `ST_REPO_ROOT` (else the git toplevel of cwd), so the fixture is passed
 * both ways and the script itself is never copied into it.
 *
 * @param {{workflows: Record<string,string>, dirs?: string[]}} fixture
 */
function runGuard({ workflows, dirs = [], files = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfguard-'));
  try {
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    for (const dir of dirs) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    for (const [name, body] of Object.entries(workflows)) {
      fs.writeFileSync(path.join(root, '.github/workflows', name), body);
    }
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    // The guard matches against tracked paths, so the fixture needs a
    // real index rather than a bare directory tree.
    for (const args of [['init', '-q'], ['add', '-A']]) {
      spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    }
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, ST_REPO_ROOT: root },
    });
    return { code: result.status, stderr: result.stderr, stdout: result.stdout };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const wf = (paths) =>
  ['name: x', 'on:', '  pull_request:', '    paths:', ...paths, 'jobs:', '  a:', '    runs-on: ubuntu-latest'].join(
    '\n',
  );

test('passes when every globbed path resolves and matches a file', () => {
  const { code, stdout } = runGuard({
    workflows: { 'ok.yml': wf(['      - "packages/real/**"']) },
    dirs: ['packages/real'],
    files: { 'packages/real/thing.dart': 'x' },
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /0 broken/);
});

test('an existing but empty directory is still an inert filter', () => {
  // `packages/real/**` over a directory with no tracked files never
  // triggers, so the prefix existing is not enough to call it live.
  const { code, stderr } = runGuard({
    workflows: { 'empty.yml': wf(['      - "packages/real/**"']) },
    dirs: ['packages/real'],
  });
  assert.equal(code, 1);
  assert.match(stderr, /matches no tracked file/);
});

test('fails on a globbed path whose directory does not exist', () => {
  // The exact bug class: 23 workflows filtered on packages/** while the
  // code lived at flutter/packages/**, so none ever triggered.
  const { code, stderr } = runGuard({
    workflows: { 'dead.yml': wf(['      - "packages/ghost/**"']) },
  });
  assert.equal(code, 1);
  assert.match(stderr, /packages\/ghost/);
});

test('fails on a literal path that does not exist', () => {
  const { code, stderr } = runGuard({
    workflows: { 'dead.yml': wf(['      - ".github/workflows/gone.yaml"']) },
  });
  assert.equal(code, 1);
  assert.match(stderr, /gone\.yaml/);
});

test('handles unquoted and inline-flow sequence forms', () => {
  const { code, stderr } = runGuard({
    workflows: {
      'unquoted.yml': wf(['      - packages/ghost/**']),
      'flow.yml': [
        'name: y',
        'on:',
        '  push:',
        "    paths: ['tools/ghost/**']",
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
      ].join('\n'),
    },
  });
  assert.equal(code, 1);
  assert.match(stderr, /packages\/ghost/);
  assert.match(stderr, /tools\/ghost/);
});

test('a leading-wildcard pattern is matched against tracked paths', () => {
  // It names no concrete directory, but it is still checkable — and must
  // be checked, or `**/*.nope` would be exempt from this guard entirely.
  const { code, stdout } = runGuard({
    workflows: { 'glob.yml': wf(['      - "**/*.dart"']) },
    files: { 'flutter/packages/app_ui/lib/a.dart': 'x' },
  });
  assert.equal(code, 0, stdout);
});

test('checks paths-ignore as well as paths', () => {
  // A stale ignore silently stops excluding what it names.
  const { code, stderr } = runGuard({
    workflows: {
      'ig.yml': [
        'name: z',
        'on:',
        '  pull_request:',
        '    paths-ignore:',
        '      - "docs-gone/**"',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
      ].join('\n'),
    },
  });
  assert.equal(code, 1);
  assert.match(stderr, /docs-gone/);
});

test('refuses to report success when there are no workflows at all', () => {
  // An empty sweep must not look like a clean sweep.
  const { code, stderr } = runGuard({ workflows: {} });
  assert.equal(code, 2);
  assert.match(stderr, /no workflow files found/i);
});

test('fails a glob whose prefix exists but which matches nothing', () => {
  // The subtlest form of the bug this guard exists to catch: the
  // directory is real, so a prefix-only check reports success while the
  // workflow never triggers.
  const { code, stderr } = runGuard({
    workflows: { 'inert.yml': wf(['      - "packages/real/**/*.does-not-exist"']) },
    dirs: ['packages/real'],
    files: { 'packages/real/thing.dart': 'x' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /matches no tracked file/);
});

test('passes a glob that matches at least one tracked file', () => {
  const { code } = runGuard({
    workflows: { 'ok.yml': wf(['      - "packages/real/**/*.dart"']) },
    dirs: ['packages/real'],
    files: { 'packages/real/thing.dart': 'x' },
  });
  assert.equal(code, 0);
});

test('single-star does not cross a directory separator', () => {
  // `packages/*.dart` must not be satisfied by `packages/nested/a.dart`.
  const { code, stderr } = runGuard({
    workflows: { 'star.yml': wf(['      - "packages/*.dart"']) },
    dirs: ['packages/nested'],
    files: { 'packages/nested/a.dart': 'x' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /matches no tracked file/);
});

test('bracket classes fall back to the prefix check', () => {
  // `[` is unmodelled syntax. Earlier rounds tried to translate classes
  // and produced two bugs (a literal-escape false positive, then a crash
  // on `[]]`), so patterns using them are now prefix-checked only.
  const { code, stdout } = runGuard({
    workflows: { 'brackets.yml': wf(['      - "web/*.[jt]s"']) },
    dirs: ['web'],
    files: { 'web/app.ts': 'x' },
  });
  assert.equal(code, 0, stdout);
});

test('a bracket class with a missing prefix is still caught', () => {
  const { code, stderr } = runGuard({
    workflows: { 'brackets.yml': wf(['      - "ghost/*.[jt]s"']) },
    files: { 'web/app.ts': 'x' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /does not exist/);
});

test('a malformed class cannot crash the guard', () => {
  // Whatever the pattern, this guard must produce a finding or a pass —
  // never a traceback. It gates every PR, and a crash is
  // indistinguishable from the guard itself being broken.
  const { code, stderr } = runGuard({
    workflows: { 'bad.yml': wf(['      - "web/[abc.ts"']) },
    dirs: ['web'],
    files: { 'web/app.ts': 'x' },
  });
  assert.doesNotMatch(stderr, /Traceback/);
  assert.ok(code === 0 || code === 1, `expected a verdict, got ${code}`);
});

test('a leading-wildcard filter that matches nothing is reported inert', () => {
  // These used to be skipped outright on the grounds that they name no
  // concrete directory — which exempted them from the only check this
  // guard performs.
  const { code, stderr } = runGuard({
    workflows: { 'lead.yml': wf(['      - "**/*.does-not-exist"']) },
    files: { 'web/app.ts': 'x' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /matches no tracked file/);
});

test('a leading-wildcard filter that does match still passes', () => {
  const { code, stdout } = runGuard({
    workflows: { 'lead.yml': wf(['      - "**/*.ts"']) },
    files: { 'web/nested/app.ts': 'x' },
  });
  assert.equal(code, 0, stdout);
});

test('a class whose first member is a closing bracket is parsed', () => {
  // `[]]` matches a literal `]`. Scanning for the terminator from the
  // first character found that member instead, emitted `[]`, and crashed
  // re.compile — aborting a required check with a traceback.
  const { code, stdout } = runGuard({
    workflows: { 'rb.yml': wf(['      - "assets/[]].json"']) },
    dirs: ['assets'],
    files: { 'assets/].json': 'x' },
  });
  assert.equal(code, 0, stdout);
});

test('a literal directory filter is inert and reported', () => {
  // GitHub matches filters against changed *file* paths, so `docs` never
  // matches `docs/readme.md`. An exists() check on the directory called
  // this live.
  const { code, stderr } = runGuard({
    workflows: { 'lit.yml': wf(['      - "docs"']) },
    dirs: ['docs'],
    files: { 'docs/readme.md': 'x' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /matching no tracked file/);
});

test('a literal file filter that exists passes', () => {
  const { code, stdout } = runGuard({
    workflows: { 'lit.yml': wf(['      - ".github/workflows/lit.yml"']) },
  });
  assert.equal(code, 0, stdout);
});

test('unmodelled quantifier syntax falls back to the prefix check', () => {
  // GitHub reads `+` as "one or more of the preceding character". Rather
  // than model that grammar, patterns using it are checked by prefix only
  // — a false rejection in a required check costs more than a miss.
  const { code, stdout } = runGuard({
    workflows: { 'quant.yml': wf(['      - "web/file+.js"']) },
    dirs: ['web'],
    files: { 'web/app.ts': 'x' },
  });
  assert.equal(code, 0, stdout);
});

test('unmodelled syntax with a missing prefix is still caught', () => {
  // The fallback is prefix-only, not check-nothing.
  const { code, stderr } = runGuard({
    workflows: { 'quant.yml': wf(['      - "ghost/file+.js"']) },
    files: { 'web/app.ts': 'x' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /does not exist/);
});

test('a pattern that cannot be verified is reported, not counted as checked', () => {
  // `**/file+.js` has a leading wildcard (no prefix) AND unmodelled
  // quantifier syntax, so there is nothing this guard can assert. Silently
  // counting it as checked would overstate coverage — the one thing a
  // guard must never do.
  const { code, stdout, stderr } = runGuard({
    workflows: { 'u.yml': wf(['      - "**/file+.js"']) },
    files: { 'web/app.ts': 'x' },
  });
  assert.equal(code, 0, 'unverifiable is not the same as broken');
  assert.match(stderr, /NOT VERIFIED/);
  assert.match(stdout, /checked 0 filter/);
  assert.match(stdout, /1 not verifiable/);
});

test('verifiable patterns are still counted normally', () => {
  const { stdout } = runGuard({
    workflows: { 'ok.yml': wf(['      - "**/*.ts"']) },
    files: { 'web/app.ts': 'x' },
  });
  assert.match(stdout, /checked 1 filter/);
  assert.doesNotMatch(stdout, /not verifiable/);
});
