import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBaseRef } from './resolve-base-ref.mjs';

test('prefers configured PR base before origin/main', () => {
  const base = resolveBaseRef({
    getMergeBase: (a, b) => {
      if (b === 'origin/dev') return 'DEV_MERGE_BASE';
      if (b === 'origin/main') return 'MAIN_MERGE_BASE';
      return null;
    },
    getUpstreamRef: () => 'origin/hotfix/my-branch',
    getPreferredBaseRefs: () => ['origin/dev', 'dev'],
    revParse: () => 'HEAD~1_SHA',
  });

  assert.equal(base, 'DEV_MERGE_BASE');
});

// Regression: pre-push must diff against origin/main (the PR base, like
// CI), NOT the branch's own upstream. Basing on the branch upstream only
// checks the incremental diff since the last push, so a file committed in
// an earlier push (e.g. an unformatted comment_methods.dart) is never
// re-checked locally and only fails in CI.
test('prefers origin/main merge-base over the branch upstream', () => {
  const calls = [];
  const base = resolveBaseRef({
    getMergeBase: (a, b) => {
      calls.push(b);
      if (b === 'origin/main') return 'MAIN_MERGE_BASE';
      if (b === 'origin/hotfix/my-branch') return 'UPSTREAM_MERGE_BASE';
      return null;
    },
    // Would be chosen by the old logic and hide earlier-pushed drift.
    getUpstreamRef: () => 'origin/hotfix/my-branch',
    revParse: () => 'HEAD~1_SHA',
  });

  assert.equal(base, 'MAIN_MERGE_BASE');
  // origin/main is consulted first; upstream is never even needed.
  assert.equal(calls[0], 'origin/main');
});

test('falls back to local main when origin/main is absent', () => {
  const base = resolveBaseRef({
    getMergeBase: (a, b) => (b === 'main' ? 'LOCAL_MAIN_BASE' : null),
    getUpstreamRef: () => 'origin/some-branch',
    revParse: () => 'HEAD~1_SHA',
  });

  assert.equal(base, 'LOCAL_MAIN_BASE');
});

test('falls back to upstream when no main ref exists', () => {
  const base = resolveBaseRef({
    getMergeBase: (a, b) =>
      b === 'origin/feature' ? 'UPSTREAM_BASE' : null,
    getUpstreamRef: () => 'origin/feature',
    revParse: () => 'HEAD~1_SHA',
  });

  assert.equal(base, 'UPSTREAM_BASE');
});

test('incremental mode prefers the branch upstream (only the commits '
  + 'being pushed are validated)', () => {
  const base = resolveBaseRef({
    getMergeBase: (a, b) => {
      if (b === 'origin/hotfix/my-branch') return 'UPSTREAM_MERGE_BASE';
      if (b === 'origin/main') return 'MAIN_MERGE_BASE';
      return null;
    },
    getUpstreamRef: () => 'origin/hotfix/my-branch',
    getPreferredBaseRefs: () => ['origin/main'],
    revParse: () => 'HEAD~1_SHA',
    preferUpstreamIncremental: true,
  });

  assert.equal(base, 'UPSTREAM_MERGE_BASE');
});

test('incremental mode falls back to the full-branch chain when the '
  + 'branch has no upstream (first push)', () => {
  const base = resolveBaseRef({
    getMergeBase: (a, b) => (b === 'origin/main' ? 'MAIN_MERGE_BASE' : null),
    getUpstreamRef: () => null,
    revParse: () => 'HEAD~1_SHA',
    preferUpstreamIncremental: true,
  });

  assert.equal(base, 'MAIN_MERGE_BASE');
});

test('falls back to HEAD~1 when nothing else resolves', () => {
  const base = resolveBaseRef({
    getMergeBase: () => null,
    getUpstreamRef: () => null,
    revParse: (ref) => (ref === 'HEAD~1' ? 'HEAD~1_SHA' : null),
  });

  assert.equal(base, 'HEAD~1_SHA');
});

test('uses literal HEAD~1 when even rev-parse fails', () => {
  const base = resolveBaseRef({
    getMergeBase: () => null,
    getUpstreamRef: () => null,
    revParse: () => null,
  });

  assert.equal(base, 'HEAD~1');
});
