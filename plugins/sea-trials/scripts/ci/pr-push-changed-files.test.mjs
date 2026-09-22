import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ZERO_SHA,
  changedFilesForCiPush,
  changedFilesForCumulativePr,
  changedFilesForPathGate,
  changedFilesInHeadCommit,
  changedFilesInPushRange,
} from './pr-push-changed-files.mjs';

test('push range uses before..after when before is not zero', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    return 'scripts/ci/foo.mjs\n';
  };
  assert.deepEqual(
    changedFilesInPushRange('abc', 'def', git),
    ['scripts/ci/foo.mjs'],
  );
  assert.deepEqual(calls[0], [
    'diff',
    '--name-only',
    '--no-renames',
    'abc',
    'def',
  ]);
});

test('zero before falls back to head commit', () => {
  const git = (args) => {
    if (args[0] === 'rev-list') {
      return 'deadbeef\n';
    }
    if (args[0] === 'diff-tree') {
      return 'docs/plan/foo.md\n';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.deepEqual(
    changedFilesInPushRange(ZERO_SHA, 'def', git),
    ['docs/plan/foo.md'],
  );
});

test('changedFilesForCiPush reads github event env', () => {
  const git = (args) => {
    assert.deepEqual(args.slice(0, 4), [
      'diff',
      '--name-only',
      '--no-renames',
      'before123',
    ]);
    return 'package.json\n';
  };
  assert.deepEqual(
    changedFilesForCiPush({
      git,
      env: {
        GITHUB_EVENT_BEFORE: 'before123',
        GITHUB_EVENT_AFTER: 'after456',
      },
    }),
    ['package.json'],
  );
});

test('changedFilesForCumulativePr diffs base sha to HEAD', () => {
  const git = (args) => {
    assert.deepEqual(args, [
      'diff',
      '--name-only',
      '--no-renames',
      'baseabc',
      'HEAD',
    ]);
    return 'flutter/packages/app_ui/lib/a.dart\n';
  };
  assert.deepEqual(
    changedFilesForCumulativePr({ baseSha: 'baseabc', git }),
    ['flutter/packages/app_ui/lib/a.dart'],
  );
});

test('changedFilesForPathGate uses push range on stg', () => {
  const git = (args) => {
    if (args[0] === 'diff') {
      return 'docs/plan/foo.md\n';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.deepEqual(
    changedFilesForPathGate({
      git,
      env: {
        GITHUB_BASE_REF: 'stg',
        GITHUB_EVENT_BEFORE: 'before123',
        GITHUB_EVENT_AFTER: 'after456',
      },
    }),
    ['docs/plan/foo.md'],
  );
});

test('changedFilesForPathGate uses cumulative diff on dev', () => {
  const git = (args) => {
    assert.deepEqual(args, [
      'diff',
      '--name-only',
      '--no-renames',
      'baseabc',
      'HEAD',
    ]);
    return 'flutter/packages/app_ui/lib/a.dart\n';
  };
  assert.deepEqual(
    changedFilesForPathGate({
      git,
      env: { GITHUB_BASE_REF: 'dev', PR_BASE_SHA: 'baseabc' },
    }),
    ['flutter/packages/app_ui/lib/a.dart'],
  );
});

test('changedFilesInHeadCommit reads merge parent on PR merge commits', () => {
  const git = (args) => {
    if (args[0] === 'rev-list' && args.includes('HEAD')) {
      return '1111111111111111111111111111111111111111 parent1 parent2\n';
    }
    if (args[0] === 'rev-list' && args.includes('parent2')) {
      return '2222222222222222222222222222222222222222 parent1\n';
    }
    if (args[0] === 'diff') {
      return 'scripts/flutter/pnpm-flutter.mjs\n';
    }
    if (args[0] === 'diff-tree') {
      return 'scripts/flutter/pnpm-flutter.mjs\n';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.deepEqual(changedFilesInHeadCommit(git), [
    'scripts/flutter/pnpm-flutter.mjs',
  ]);
});

test('push range falls back to head commit when before is missing locally', () => {
  let diffAttempts = 0;
  const git = (args) => {
    if (args[0] === 'diff') {
      diffAttempts += 1;
      throw new Error(
        'git diff --name-only --no-renames da964fa f3ba4be failed: fatal: bad object da964fa',
      );
    }
    if (args[0] === 'rev-list' && args.includes('HEAD')) {
      return '1111111111111111111111111111111111111111 parent1\n';
    }
    if (args[0] === 'diff-tree') {
      return '.github/workflows/spell_checker.yaml\n';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.deepEqual(
    changedFilesInPushRange('da964fa', 'f3ba4be', git),
    ['.github/workflows/spell_checker.yaml'],
  );
  assert.equal(diffAttempts, 1);
});

test('promotion path gate ignores cumulative flutter when push is docs-only', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'diff') {
      return 'docs/code-review/dev/pr-review-queue.json\n';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.deepEqual(
    changedFilesForPathGate({
      git,
      env: {
        GITHUB_BASE_REF: 'stg',
        GITHUB_EVENT_BEFORE: 'before123',
        GITHUB_EVENT_AFTER: 'after456',
      },
    }),
    ['docs/code-review/dev/pr-review-queue.json'],
  );
  assert.ok(calls.every((args) => args[0] !== 'merge-base'));
});
