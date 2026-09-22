import assert from 'node:assert/strict';
import test from 'node:test';

import {
  argvWithoutPnpmSeparator,
  bodyCitesSha,
  closeThread,
  ensureReplyCitesSha,
  fetchThread,
  fetchThreads,
  formatBotReviewReply,
  hasMatchingReply,
  mapThread,
  mapWithConcurrency,
  resolveRepo,
} from '../pr-review-threads.mjs';

test('resolveRepo parses --repo owner/name', () => {
  assert.deepEqual(resolveRepo('acme/widgets'), {
    owner: 'acme',
    name: 'widgets',
  });
});

test('resolveRepo falls back to the checkout lookup, then errors', () => {
  const prev = process.env.GH_REPO;
  delete process.env.GH_REPO;
  assert.deepEqual(
    resolveRepo(undefined, { lookup: () => ({ owner: 'o', name: 'r' }) }),
    { owner: 'o', name: 'r' },
  );
  assert.throws(
    () =>
      resolveRepo(undefined, {
        lookup: () => {
          throw new Error('no remote');
        },
      }),
    /target repository required.*no remote/,
  );
  if (prev) process.env.GH_REPO = prev;
});

test('resolveRepo honours GH_REPO before the lookup', () => {
  const prev = process.env.GH_REPO;
  process.env.GH_REPO = 'env/repo';
  assert.deepEqual(
    resolveRepo(undefined, {
      lookup: () => {
        throw new Error('should not be called');
      },
    }),
    { owner: 'env', name: 'repo' },
  );
  if (prev) process.env.GH_REPO = prev;
  else delete process.env.GH_REPO;
});

test('resolveRepo rejects malformed slug', () => {
  assert.throws(
    () => resolveRepo('not-a-slug'),
    /owner\/name/,
  );
});

test('hasMatchingReply detects an existing follow-up body', () => {
  const comments = [
    { body: 'original finding' },
    { body: 'Fixed in abc123.' },
  ];
  assert.equal(hasMatchingReply(comments, 'Fixed in abc123.'), true);
  assert.equal(hasMatchingReply(comments, 'Different reply.'), false);
});

test('hasMatchingReply ignores the head comment', () => {
  const comments = [{ body: 'same text' }];
  assert.equal(hasMatchingReply(comments, 'same text'), false);
});

test('formatBotReviewReply prefixes VALID with sha', () => {
  const body = formatBotReviewReply({
    verdict: 'valid',
    sha: '197c8d91ef',
    summary: 'Nested slot removed.',
  });
  assert.match(body, /^\*\*Adversarial vet: VALID — applied in `197c8d91ef`\.\*\*/);
  assert.match(body, /Nested slot removed\./);
});

test('formatBotReviewReply prefixes REJECT for incorrect findings', () => {
  const body = formatBotReviewReply({
    verdict: 'reject',
    summary: 'Wrong boot phase — hasSynced was false in production stall.',
  });
  assert.match(body, /^\*\*Adversarial vet: REJECT\.\*\*/);
  assert.equal(bodyCitesSha(body), false);
});

test('formatBotReviewReply cites the reviewed head for non-VALID verdicts', () => {
  const body = formatBotReviewReply({
    verdict: 'reject',
    sha: 'abc1234',
    summary: 'Intentional contract.',
  });
  assert.match(body, /\(reviewed at `abc1234`\)$/);
  assert.equal(bodyCitesSha(body), true);
});

test('formatBotReviewReply prefixes STALE when already shipped', () => {
  const body = formatBotReviewReply({
    verdict: 'stale',
    summary: 'Migration `20260827184106_…` already on branch.',
  });
  assert.match(body, /STALE — no code change/);
});

test('formatBotReviewReply supports bounded VALID', () => {
  const body = formatBotReviewReply({
    verdict: 'valid',
    sha: '704b836312',
    bounded: true,
    summary: 'Retry on orchestrator reset only.',
  });
  assert.match(body, /VALID \(bounded\)/);
});

test('bodyCitesSha finds 7–40 hex shas and ignores short numbers', () => {
  assert.equal(bodyCitesSha('applied in `197c8d91ef`'), true);
  assert.equal(bodyCitesSha('see 1234567'), true);
  assert.equal(bodyCitesSha('PR #1657 fixed'), false);
  assert.equal(bodyCitesSha(''), false);
});

test('ensureReplyCitesSha appends Head line or throws', () => {
  assert.equal(ensureReplyCitesSha('done in abc1234', undefined), 'done in abc1234');
  assert.equal(
    ensureReplyCitesSha('Rejected: intentional.', 'deadbee'),
    'Rejected: intentional.\n\nHead: `deadbee`',
  );
  assert.throws(() => ensureReplyCitesSha('no sha here', undefined), /must cite/);
  assert.throws(() => ensureReplyCitesSha('no sha here', 'zzz'), /must cite/);
});

test('argvWithoutPnpmSeparator drops leading pnpm --', () => {
  assert.deepEqual(
    argvWithoutPnpmSeparator(['--', 'format', '--verdict', 'valid']),
    ['format', '--verdict', 'valid'],
  );
  assert.deepEqual(
    argvWithoutPnpmSeparator(['list', '--pr', '1']),
    ['list', '--pr', '1'],
  );
});

test('mapWithConcurrency preserves order and caps in-flight work', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
});

test('mapThread prefers fullDatabaseId and falls back to originalLine', () => {
  const t = mapThread(
    { id: 'PRRT_1', isResolved: false, isOutdated: true, path: 'a.dart', line: null, originalLine: 12 },
    [
      { fullDatabaseId: '99', author: { login: 'chatgpt-codex-connector' }, body: 'finding', createdAt: '2026-01-01T00:00:00Z' },
      { databaseId: 100, author: { login: 'me' }, body: 'reply', createdAt: '2026-01-01T00:01:00Z' },
    ],
  );
  assert.equal(t.commentId, 99);
  assert.equal(t.line, 12);
  assert.equal(t.author, 'chatgpt-codex-connector');
  assert.deepEqual(t.comments.map((c) => c.id), [99, 100]);
});

// --------------------------------------------------------------------------
// Fake gh runners (no network)
// --------------------------------------------------------------------------

function graphqlVar(args, name) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function threadNode(id, { resolved = false, comments, moreComments = false } = {}) {
  return {
    id,
    isResolved: resolved,
    isOutdated: false,
    path: `lib/${id}.dart`,
    line: 3,
    originalLine: 3,
    subjectType: 'LINE',
    comments: {
      pageInfo: { hasNextPage: moreComments, endCursor: moreComments ? `c-${id}` : null },
      nodes: comments ?? [
        { fullDatabaseId: `${id.length}01`, author: { login: 'cursor[bot]' }, body: 'bug', createdAt: '2026-01-01T00:00:00Z' },
      ],
    },
  };
}

test('fetchThreads pages threads and parallelises per-thread comment pages', async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    const query = graphqlVar(args, 'query');
    if (query.includes('reviewThreads(')) {
      const cursor = graphqlVar(args, 'cursor');
      if (!cursor) {
        return JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: 'p2' },
            nodes: [threadNode('PRRT_a', { moreComments: true }), threadNode('PRRT_b')],
          } } } },
        });
      }
      return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [threadNode('PRRT_c', { moreComments: true })],
        } } } },
      });
    }
    // comment pagination for one thread
    const threadId = graphqlVar(args, 'threadId');
    return JSON.stringify({
      data: { node: { comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { fullDatabaseId: '5000', author: { login: 'me' }, body: `reply-${threadId}`, createdAt: '2026-01-01T00:05:00Z' },
        ],
      } } },
    });
  };
  const threads = await fetchThreads(7, { owner: 'o', name: 'r' }, { runner });
  assert.deepEqual(threads.map((t) => t.id), ['PRRT_a', 'PRRT_b', 'PRRT_c']);
  assert.equal(threads[0].comments.length, 2);
  assert.equal(threads[1].comments.length, 1);
  assert.equal(threads[2].comments.at(-1).body, 'reply-PRRT_c');
  const commentCalls = calls.filter((a) => graphqlVar(a, 'threadId'));
  assert.equal(commentCalls.length, 2);
});

test('fetchThreads surfaces RATE_LIMITED instead of returning zero threads', async () => {
  const runner = async () =>
    JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] });
  await assert.rejects(
    fetchThreads(7, { owner: 'o', name: 'r' }, { runner }),
    /rate limited/i,
  );
});

test('fetchThread reads one thread via node(id:)', async () => {
  const runner = async (args) => {
    assert.ok(graphqlVar(args, 'query').includes('node(id:$threadId)'));
    assert.equal(graphqlVar(args, 'threadId'), 'PRRT_x');
    return JSON.stringify({ data: { node: threadNode('PRRT_x', { resolved: true }) } });
  };
  const t = await fetchThread('PRRT_x', { runner });
  assert.equal(t.isResolved, true);
  assert.equal(t.commentId, 601);
  const missing = await fetchThread('PRRT_none', {
    runner: async () => JSON.stringify({ data: { node: null } }),
  });
  assert.equal(missing, null);
});

test('closeThread replies to the top-level comment, resolves, verifies once', async () => {
  let resolved = false;
  const reads = [];
  const runner = async (args) => {
    reads.push(graphqlVar(args, 'query').includes('reviewThreads(') ? 'all' : 'one');
    return JSON.stringify({
      data: { node: threadNode('PRRT_x', { resolved }) },
    });
  };
  const writes = [];
  const run = (args) => {
    writes.push(args);
    if (args.includes('graphql')) {
      resolved = true;
      return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
    }
    return '{}';
  };
  const result = await closeThread(
    9,
    'PRRT_x',
    'Adversarial vet: VALID — applied in `abc1234`.',
    { owner: 'o', name: 'r' },
    { runner, run },
  );
  assert.equal(result.skipped, false);
  assert.equal(result.replySkipped, false);
  assert.deepEqual(reads, ['one', 'one'], 'single-thread reads only, never the full PR');
  assert.equal(writes[0][2], 'POST');
  assert.equal(writes[0][3], 'repos/o/r/pulls/9/comments/601/replies');
  assert.ok(writes[1].includes('graphql'));
});

test('closeThread refuses a reply without a commit and skips resolved threads', async () => {
  await assert.rejects(
    closeThread(9, 'PRRT_x', 'no commit cited', { owner: 'o', name: 'r' }, {
      runner: async () => '{}',
      run: () => '{}',
    }),
    /must cite/,
  );
  const result = await closeThread(
    9,
    'PRRT_x',
    'already handled',
    { owner: 'o', name: 'r' },
    {
      sha: 'abc1234',
      runner: async () => JSON.stringify({ data: { node: threadNode('PRRT_x', { resolved: true }) } }),
      run: () => {
        throw new Error('must not mutate');
      },
    },
  );
  assert.deepEqual(result, { skipped: true, reason: 'already resolved' });
});

test('closeThread fails loudly when resolve did not stick', async () => {
  await assert.rejects(
    closeThread(9, 'PRRT_x', 'fixed in abc1234', { owner: 'o', name: 'r' }, {
      runner: async () => JSON.stringify({ data: { node: threadNode('PRRT_x') } }),
      run: () => JSON.stringify({ data: {} }),
    }),
    /still unresolved/,
  );
});
