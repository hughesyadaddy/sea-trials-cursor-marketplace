import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  EXECUTABLE_MODE,
  HOOKS_DIR,
  REQUIRED_HOOKS,
  assessHooksWiring,
  invokesHuskyCli,
  listHeadEntries,
  scriptSegments,
} from './git-hooks-wiring.mjs';

const isWindows = process.platform === 'win32';
const repoRoot = (() => {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (top.status !== 0) {
    throw new Error('git-hooks-wiring tests require a git checkout cwd');
  }
  return (top.stdout ?? '').trim();
})();

const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

// Unit fixtures deliberately hardcode the production layout instead of
// reading HOOKS_DIR. Reusing the constant would make them follow a
// mutation of it and stay green, hiding the regression behind the very
// value under test.
const FIXTURE_HOOKS_DIR = '.husky';
const FIXTURE_SHIM_DIR = '.husky/_';

function headEntriesFor(
  hooks,
  { mode = EXECUTABLE_MODE, dir = FIXTURE_HOOKS_DIR } = {},
) {
  return hooks.map((hook) => ({ mode, path: `${dir}/${hook}` }));
}

// ===========================================================================
// THE GUARD — worktree parity
// ===========================================================================
//
// `git worktree add` materializes HEAD. So "the hooks directory git is
// configured to use contains every required hook as a tracked HEAD
// entry" is not a proxy for worktree safety — it is the property
// itself. Mutate HOOKS_DIR back to husky's `.husky/_` and this fails,
// because that directory has no tracked contents.

test('every required hook is tracked at HEAD under the configured hooks dir', () => {
  const headEntries = listHeadEntries(repoRoot, HOOKS_DIR);
  assert.ok(
    headEntries.length > 0,
    `git ls-tree HEAD -- ${HOOKS_DIR} returned nothing; a hooks directory `
      + 'with no tracked contents does not exist in a fresh worktree.',
  );

  const { ok, problems } = assessHooksWiring({
    hooksDir: HOOKS_DIR,
    headEntries,
  });
  assert.ok(ok, problems.join('\n'));
});

test('a fresh worktree checkout of HEAD contains each hook, executable', () => {
  const tracked = new Map(
    listHeadEntries(repoRoot, HOOKS_DIR).map((e) => [e.path, e.mode]),
  );
  for (const hook of REQUIRED_HOOKS) {
    const hookPath = `${HOOKS_DIR}/${hook}`;
    assert.equal(
      tracked.get(hookPath),
      EXECUTABLE_MODE,
      `${hookPath} must be tracked at HEAD with mode ${EXECUTABLE_MODE}; `
        + `got ${tracked.get(hookPath) ?? 'nothing'}. Git resolves `
        + 'core.hooksPath against the working tree it runs in, so anything '
        + 'untracked here is a silently gate-less worktree.',
    );
  }
});

test('the prepare script wires hooks and never invokes husky', () => {
  const prepare = packageJson.scripts?.prepare ?? '';
  assert.ok(
    prepare.includes('scripts/hooks/install-git-hooks.mjs'),
    'package.json `prepare` must run scripts/hooks/install-git-hooks.mjs so '
      + 'a fresh clone + pnpm install wires core.hooksPath with no manual '
      + `step. Got: ${prepare}`,
  );
  assert.equal(
    invokesHuskyCli(prepare),
    false,
    'package.json `prepare` must not invoke the husky CLI: husky re-points '
      + 'core.hooksPath at the generated, gitignored .husky/_, which no '
      + `worktree checks out. Got: ${prepare}`,
  );
});

test('husky is not a dependency that could re-point core.hooksPath', () => {
  for (const field of ['dependencies', 'devDependencies']) {
    assert.equal(
      packageJson[field]?.husky,
      undefined,
      `husky must not be in ${field}: its installer sets core.hooksPath to `
        + 'the gitignored .husky/_ and reopens the worktree bypass.',
    );
  }
});

// ===========================================================================
// UNIT — assessHooksWiring
// ===========================================================================

test('assessHooksWiring accepts a tracked, executable hooks dir', () => {
  const { ok, problems } = assessHooksWiring({
    hooksDir: FIXTURE_HOOKS_DIR,
    headEntries: headEntriesFor(REQUIRED_HOOKS),
  });
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
});

test('assessHooksWiring rejects husky\'s untracked .husky/_ shim dir', () => {
  // The exact production shape: hooks committed at `.husky/<hook>`,
  // core.hooksPath pointing one level deeper at the generated dir.
  const { ok, problems } = assessHooksWiring({
    hooksDir: FIXTURE_SHIM_DIR,
    headEntries: headEntriesFor(REQUIRED_HOOKS),
  });
  assert.equal(ok, false);
  assert.equal(problems.length, REQUIRED_HOOKS.length);
  assert.match(problems[0], /\.husky\/_\/pre-commit is not tracked at HEAD/);
  assert.match(problems[0], /git worktree add/);
});

test('assessHooksWiring rejects an unset core.hooksPath', () => {
  const { ok, problems } = assessHooksWiring({
    hooksDir: null,
    headEntries: headEntriesFor(REQUIRED_HOOKS),
  });
  assert.equal(ok, false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /core\.hooksPath is not set/);
});

test('assessHooksWiring rejects an absolute core.hooksPath', () => {
  const { problems } = assessHooksWiring({
    hooksDir: '/Users/someone/clone/.husky',
    headEntries: [],
  });
  assert.ok(problems.some((p) => /absolute path/.test(p)));
});

test('assessHooksWiring rejects a Windows absolute core.hooksPath', () => {
  const { problems } = assessHooksWiring({
    hooksDir: 'D:\\clone\\.husky',
    headEntries: [],
  });
  assert.ok(problems.some((p) => /absolute path/.test(p)));
});

test('assessHooksWiring rejects a single missing hook', () => {
  const { ok, problems } = assessHooksWiring({
    hooksDir: FIXTURE_HOOKS_DIR,
    headEntries: headEntriesFor(REQUIRED_HOOKS.filter((h) => h !== 'pre-push')),
  });
  assert.equal(ok, false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\.husky\/pre-push is not tracked at HEAD/);
});

test('assessHooksWiring rejects a non-executable hook', () => {
  const { ok, problems } = assessHooksWiring({
    hooksDir: FIXTURE_HOOKS_DIR,
    headEntries: [
      { mode: '100644', path: `${FIXTURE_HOOKS_DIR}/pre-push` },
      ...headEntriesFor(REQUIRED_HOOKS.filter((h) => h !== 'pre-push')),
    ],
  });
  assert.equal(ok, false);
  assert.match(problems[0], /mode 100644; git skips a hook/);
});

test('assessHooksWiring tolerates a trailing slash on the hooks dir', () => {
  const { ok } = assessHooksWiring({
    hooksDir: `${FIXTURE_HOOKS_DIR}/`,
    headEntries: headEntriesFor(REQUIRED_HOOKS),
  });
  assert.equal(ok, true);
});

// ===========================================================================
// UNIT — script parsing
// ===========================================================================

test('scriptSegments splits on shell operators', () => {
  assert.deepEqual(scriptSegments('a && b || c ; d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(scriptSegments(undefined), []);
});

test('invokesHuskyCli detects husky under every common runner', () => {
  for (const script of [
    'husky',
    'node -e "x" && husky && node other.mjs',
    'npx husky',
    'npx husky install',
    'pnpm exec husky',
    'yarn husky install',
    'node_modules/.bin/husky',
    './node_modules/husky/bin.mjs',
  ]) {
    assert.equal(invokesHuskyCli(script), true, `expected husky in: ${script}`);
  }
});

test('pre-push blocks bare push when an open PR exists without ST_REVIEW_PUSH', () => {
  const prePush = fs.readFileSync(
    path.join(repoRoot, '.husky/pre-push'),
    'utf8',
  );
  assert.match(prePush, /ST_REVIEW_PUSH/);
  assert.match(prePush, /gh pr view/);
  assert.match(prePush, /pnpm pr-review-push/);
  assert.match(prePush, /git rev-parse HEAD/);
});

test('invokesHuskyCli does not fire on .husky paths or our installer', () => {
  for (const script of [
    'node scripts/hooks/install-git-hooks.mjs',
    'git config core.hooksPath .husky',
    'chmod +x .husky/pre-push',
    'echo husky-free',
    '',
  ]) {
    assert.equal(
      invokesHuskyCli(script),
      false,
      `unexpected husky match in: ${script}`,
    );
  }
});
