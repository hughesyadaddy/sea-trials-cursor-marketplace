import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BOTS,
  STATES,
  SETTLED_DEFAULTS,
  applyRateLimitBackoff,
  botKeyForLogin,
  createGhAdapter,
  createMachine,
  createSettledPoller,
  createWakeableSleep,
  deriveSignals,
  enabledBotsOf,
  isBotLogin,
  isGraphqlRateLimited,
  machineSnapshot,
  mergeSignals,
  normalizeLogin,
  normalizeRestComment,
  parseGhHttpResponse,
  pollEndpoints,
  sameSha,
  selectNewBotComments,
  spawnWebhookForwarder,
  startWebhookReceiver,
  stepMachine,
  threadsAreFresh,
  webhookForwardArgs,
} from './bot-review-settled.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD_HEAD = '1111111111111111111111111111111111111111';
const T0 = Date.parse('2026-09-22T12:00:00.000Z');
const MIN = 60_000;

// ==========================================================================
// LOGINS
// ==========================================================================

test('normalizeLogin strips [bot] suffix and case', () => {
  assert.equal(normalizeLogin('chatgpt-codex-connector[bot]'), 'chatgpt-codex-connector');
  assert.equal(normalizeLogin('Cursor'), 'cursor');
  assert.equal(normalizeLogin(null), '');
});

test('botKeyForLogin matches GraphQL and REST spellings', () => {
  assert.equal(botKeyForLogin('chatgpt-codex-connector'), 'codex');
  assert.equal(botKeyForLogin('chatgpt-codex-connector[bot]'), 'codex');
  assert.equal(botKeyForLogin('coderabbitai[bot]'), 'coderabbit');
  assert.equal(botKeyForLogin('copilot-pull-request-reviewer[bot]'), 'copilot');
  assert.equal(botKeyForLogin('alexhughes'), null);
});

test('isBotLogin accepts unknown GitHub apps by suffix', () => {
  assert.equal(isBotLogin('some-new-reviewer[bot]'), true);
  assert.equal(isBotLogin('cursor[bot]'), true);
  assert.equal(isBotLogin('alexhughes'), false);
});

test('sameSha compares short and full shas', () => {
  assert.equal(sameSha('abcdef1', HEAD), true);
  assert.equal(sameSha(HEAD, 'abcdef1234'), true);
  assert.equal(sameSha('abc', HEAD), false);
  assert.equal(sameSha(OLD_HEAD, HEAD), false);
});

// ==========================================================================
// COMMENTS
// ==========================================================================

test('normalizeRestComment unifies review comments and reviews', () => {
  const c = normalizeRestComment(
    {
      id: 7,
      user: { login: 'cursor[bot]' },
      created_at: '2026-09-22T12:01:00Z',
      commit_id: HEAD,
      body: 'finding',
    },
    'review-comment',
  );
  assert.equal(c.id, 'review-comment:7');
  assert.equal(c.login, 'cursor[bot]');
  assert.equal(c.createdAt, Date.parse('2026-09-22T12:01:00Z'));
  const r = normalizeRestComment(
    { id: 9, user: { login: 'x' }, submitted_at: '2026-09-22T12:02:00Z' },
    'review',
  );
  assert.equal(r.id, 'review:9');
  assert.equal(r.createdAt, Date.parse('2026-09-22T12:02:00Z'));
});

test('selectNewBotComments drops humans, stale heads, and seen ids', () => {
  const comments = [
    { id: 'a', login: 'chatgpt-codex-connector[bot]', createdAt: T0 + 5_000, commitId: HEAD },
    { id: 'b', login: 'alexhughes', createdAt: T0 + 5_000, commitId: HEAD },
    { id: 'c', login: 'cursor[bot]', createdAt: T0 - 5_000, commitId: OLD_HEAD },
    { id: 'd', login: 'cursor[bot]', createdAt: T0 - 5_000, commitId: HEAD },
    { id: 'e', login: 'cursor[bot]', createdAt: T0 + 9_000, commitId: null },
  ];
  const fresh = selectNewBotComments(comments, ['e'], { t0: T0, head: HEAD });
  assert.deepEqual(fresh.map((c) => c.id), ['a', 'd']);
});

// ==========================================================================
// SIGNALS
// ==========================================================================

test('deriveSignals: codex 👀 after t0 is ack, not complete', () => {
  const s = deriveSignals({
    head: HEAD,
    t0: T0,
    reactions: [
      { content: 'eyes', user: { login: 'chatgpt-codex-connector[bot]' }, created_at: '2026-09-22T12:00:30Z' },
    ],
  });
  assert.equal(s.ack.codex, true);
  assert.equal(s.complete.codex, false);
  assert.equal(s.present.codex, true);
});

test('deriveSignals: codex 👀 from before t0 does not count', () => {
  const s = deriveSignals({
    head: HEAD,
    t0: T0,
    reactions: [
      { content: 'eyes', user: { login: 'chatgpt-codex-connector[bot]' }, created_at: '2026-09-22T11:00:00Z' },
    ],
  });
  assert.equal(s.ack.codex, false);
  assert.equal(s.present.codex, true);
});

test('deriveSignals: codex review on head or "Reviewed commit" completes', () => {
  const byReview = deriveSignals({
    head: HEAD,
    t0: T0,
    reviews: [
      { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: HEAD, submitted_at: '2026-09-22T12:05:00Z', state: 'COMMENTED' },
    ],
  });
  assert.equal(byReview.complete.codex, true);
  assert.equal(byReview.ack.codex, true);

  const byComment = deriveSignals({
    head: HEAD,
    t0: T0,
    issueComments: [
      { user: { login: 'chatgpt-codex-connector[bot]' }, created_at: '2026-09-22T12:05:00Z', body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** ${HEAD}` },
    ],
  });
  assert.equal(byComment.complete.codex, true);

  const stale = deriveSignals({
    head: HEAD,
    t0: T0,
    reviews: [
      { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: OLD_HEAD, submitted_at: '2026-09-22T11:00:00Z' },
    ],
    issueComments: [
      { user: { login: 'chatgpt-codex-connector[bot]' }, created_at: '2026-09-22T11:00:00Z', body: `**Reviewed commit:** ${OLD_HEAD}` },
    ],
  });
  assert.equal(stale.complete.codex, false);
  assert.equal(stale.present.codex, true);
});

test('deriveSignals: Bugbot check run maps queued→ack, completed→complete', () => {
  const queued = deriveSignals({
    head: HEAD,
    t0: T0,
    checkRuns: [{ name: 'Cursor Bugbot', status: 'in_progress', head_sha: HEAD }],
  });
  assert.equal(queued.ack.bugbot, true);
  assert.equal(queued.complete.bugbot, false);

  const done = deriveSignals({
    head: HEAD,
    t0: T0,
    checkRuns: [{ name: 'Cursor Bugbot', status: 'completed', conclusion: 'neutral', head_sha: HEAD }],
  });
  assert.equal(done.complete.bugbot, true);

  const otherHead = deriveSignals({
    head: HEAD,
    t0: T0,
    checkRuns: [{ name: 'Cursor Bugbot', status: 'completed', head_sha: OLD_HEAD }],
  });
  assert.equal(otherHead.ack.bugbot, false);
  assert.equal(otherHead.present.bugbot, true);
});

test('deriveSignals: CodeRabbit check run by name substring', () => {
  const s = deriveSignals({
    head: HEAD,
    t0: T0,
    checkRuns: [{ name: 'CodeRabbit', status: 'queued', head_sha: HEAD }],
  });
  assert.equal(s.ack.coderabbit, true);
});

test('deriveSignals: Copilot completes when it leaves requested_reviewers', () => {
  const requested = deriveSignals({
    head: HEAD,
    t0: T0,
    requestedReviewers: [{ login: 'copilot-pull-request-reviewer[bot]' }],
  });
  assert.equal(requested.ack.copilot, true);
  assert.equal(requested.complete.copilot, false);

  const dropped = deriveSignals({
    head: HEAD,
    t0: T0,
    requestedReviewers: [],
    copilotWasRequested: true,
  });
  assert.equal(dropped.complete.copilot, true);

  const never = deriveSignals({ head: HEAD, t0: T0 });
  assert.equal(never.present.copilot, false);
});

test('mergeSignals ORs and never forgets', () => {
  const a = deriveSignals({
    head: HEAD,
    t0: T0,
    reactions: [{ content: 'eyes', user: { login: 'chatgpt-codex-connector' }, created_at: T0 + 1 }],
  });
  const merged = mergeSignals(a, { complete: { bugbot: true } });
  assert.equal(merged.ack.codex, true);
  assert.equal(merged.complete.bugbot, true);
  assert.equal(merged.complete.codex, false);
});

// ==========================================================================
// RATE LIMIT
// ==========================================================================

test('isGraphqlRateLimited detects typed error on HTTP 200', () => {
  assert.equal(isGraphqlRateLimited({ errors: [{ type: 'RATE_LIMITED' }] }), true);
  assert.equal(isGraphqlRateLimited({ data: {} }), false);
  assert.equal(isGraphqlRateLimited(null), false);
});

test('applyRateLimitBackoff waits for reset and doubles under the floor', () => {
  const cfg = SETTLED_DEFAULTS;
  const resetAt = new Date(T0 + 90_000).toISOString();
  assert.equal(
    applyRateLimitBackoff({ rateLimited: true, rateLimit: { resetAt } }, 30_000, T0, cfg),
    90_000,
  );
  assert.equal(
    applyRateLimitBackoff({ rateLimit: { remaining: 100 } }, 30_000, T0, cfg),
    60_000,
  );
  assert.equal(
    applyRateLimitBackoff({ rateLimit: { remaining: 4000 } }, 30_000, T0, cfg),
    30_000,
  );
});

// ==========================================================================
// MACHINE
// ==========================================================================

function codexReview(at) {
  return {
    id: `review:${at}`,
    login: 'chatgpt-codex-connector[bot]',
    createdAt: at,
    commitId: HEAD,
    body: 'Codex Review: found things',
    kind: 'review',
  };
}

function codexAck() {
  return { ack: { codex: true }, present: { codex: true } };
}

function codexDone() {
  return {
    ack: { codex: true },
    complete: { codex: true },
    present: { codex: true },
  };
}

test('machine: PUSHED waits 20s then AWAITING_ACK', () => {
  let m = createMachine({ head: HEAD, t0: T0 });
  let step = stepMachine(m, { now: T0 + 5_000 });
  assert.equal(step.machine.state, STATES.PUSHED);
  assert.equal(step.nextPollMs, 15_000);
  step = stepMachine(step.machine, { now: T0 + 20_000 });
  assert.equal(step.machine.state, STATES.AWAITING_ACK);
  assert.equal(step.nextPollMs, SETTLED_DEFAULTS.ackPollMs);
});

test('machine: ack moves to REVIEWING; timeout retriggers Codex once', () => {
  let m = createMachine({ head: HEAD, t0: T0 });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  const acked = stepMachine(m, { now: T0 + 35_000, signals: codexAck() });
  assert.equal(acked.machine.state, STATES.REVIEWING);

  let quiet = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  quiet = stepMachine(quiet, { now: T0 + 20_000 }).machine;
  const timedOut = stepMachine(quiet, { now: T0 + 20_000 + 3 * MIN });
  assert.equal(timedOut.machine.state, STATES.REVIEWING);
  assert.deepEqual(timedOut.actions, ['post-codex-retrigger']);
  assert.equal(timedOut.machine.codexRetriggered, true);
});

test('machine: ack timeout without Codex enabled posts nothing', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['bugbot'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  const timedOut = stepMachine(m, { now: T0 + 20_000 + 3 * MIN });
  assert.equal(timedOut.machine.state, STATES.REVIEWING);
  assert.deepEqual(timedOut.actions, []);
});

test('machine: REVIEWING debounces two quiet polls before SETTLED_CHECK', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  m = stepMachine(m, { now: T0 + 35_000, signals: codexAck() }).machine;
  assert.equal(m.state, STATES.REVIEWING);

  // Bot posts a review: activity resets the quiet counter.
  let s = stepMachine(m, {
    now: T0 + 65_000,
    botComments: [codexReview(T0 + 60_000)],
    signals: codexDone(),
    unresolvedThreads: 0,
    unresolvedBotThreads: 0,
  });
  // Codex is complete with zero threads → nothing to act on, settle.
  assert.equal(s.machine.state, STATES.SETTLED_CHECK);
  assert.equal(s.machine.quietPolls, 0);
});

test('machine: quiet polls with a bot still in flight keep REVIEWING', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['bugbot'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  const ack = { ack: { bugbot: true }, present: { bugbot: true } };
  m = stepMachine(m, { now: T0 + 35_000, signals: ack }).machine;
  m = stepMachine(m, { now: T0 + 65_000 }).machine;
  m = stepMachine(m, { now: T0 + 95_000 }).machine;
  m = stepMachine(m, { now: T0 + 125_000 }).machine;
  assert.equal(m.state, STATES.REVIEWING);
  assert.equal(m.quietPolls, 3);
});

test('machine: all bots complete with unresolved threads → ACTING fast', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  m = stepMachine(m, { now: T0 + 35_000, signals: codexAck() }).machine;
  const s = stepMachine(m, {
    now: T0 + 65_000,
    botComments: [codexReview(T0 + 60_000)],
    signals: codexDone(),
    unresolvedThreads: 3,
    unresolvedBotThreads: 3,
  });
  assert.equal(s.machine.state, STATES.ACTING);
  assert.equal(s.nextPollMs, 0);
});

test('machine: complete but stale thread count asks for refresh first', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  m = stepMachine(m, { now: T0 + 35_000, signals: codexAck() }).machine;
  const s = stepMachine(m, {
    now: T0 + 65_000,
    botComments: [codexReview(T0 + 60_000)],
    signals: codexDone(),
  });
  assert.equal(s.machine.state, STATES.REVIEWING);
  assert.deepEqual(s.actions, ['refresh-threads']);
  const s2 = stepMachine(s.machine, {
    now: T0 + 66_000,
    unresolvedThreads: 2,
    unresolvedBotThreads: 2,
  });
  assert.equal(s2.machine.state, STATES.ACTING);
});

test('machine: SETTLED_CHECK needs 2 polls + 3 min then SETTLED → DONE', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  m = stepMachine(m, { now: T0 + 35_000, signals: codexAck() }).machine;
  m = stepMachine(m, {
    now: T0 + 65_000,
    botComments: [codexReview(T0 + 60_000)],
    signals: codexDone(),
    unresolvedThreads: 0,
    unresolvedBotThreads: 0,
  }).machine;
  assert.equal(m.state, STATES.SETTLED_CHECK);
  const entered = m.enteredAt;

  let s = stepMachine(m, { now: entered + MIN });
  assert.equal(s.machine.state, STATES.SETTLED_CHECK);
  assert.equal(s.nextPollMs, SETTLED_DEFAULTS.settledCheckPollMs);
  s = stepMachine(s.machine, { now: entered + 2 * MIN });
  assert.equal(s.machine.state, STATES.SETTLED_CHECK);
  s = stepMachine(s.machine, { now: entered + 3 * MIN, unresolvedThreads: 0, unresolvedBotThreads: 0 });
  assert.equal(s.machine.state, STATES.DONE);
  assert.equal(s.nextPollMs, 0);
});

test('machine: bot activity during SETTLED_CHECK drops back to REVIEWING', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  m = stepMachine(m, { now: T0 + 35_000, signals: codexAck() }).machine;
  m = stepMachine(m, {
    now: T0 + 65_000,
    botComments: [codexReview(T0 + 60_000)],
    signals: codexDone(),
    unresolvedThreads: 0,
    unresolvedBotThreads: 0,
  }).machine;
  assert.equal(m.state, STATES.SETTLED_CHECK);
  const s = stepMachine(m, {
    now: m.enteredAt + MIN,
    botComments: [
      { id: 'late', login: 'cursor[bot]', createdAt: m.enteredAt + 50_000, commitId: HEAD, body: '', kind: 'review-comment' },
    ],
  });
  assert.equal(s.machine.state, STATES.REVIEWING);
  assert.equal(s.machine.quietPolls, 0);
});

test('machine: SETTLED with CI pending waits instead of DONE', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  m = stepMachine(m, { now: T0 + 35_000, signals: codexAck() }).machine;
  m = stepMachine(m, {
    now: T0 + 65_000,
    botComments: [codexReview(T0 + 60_000)],
    signals: codexDone(),
    unresolvedThreads: 0,
    unresolvedBotThreads: 0,
    ciPending: true,
  }).machine;
  const entered = m.enteredAt;
  m = stepMachine(m, { now: entered + MIN }).machine;
  m = stepMachine(m, { now: entered + 2 * MIN }).machine;
  const s = stepMachine(m, { now: entered + 3 * MIN, unresolvedThreads: 0, unresolvedBotThreads: 0, ciPending: true });
  assert.equal(s.machine.state, STATES.SETTLED);
  assert.deepEqual(s.actions, ['await-ci']);
  assert.equal(s.nextPollMs, SETTLED_DEFAULTS.ciPendingPollMs);
  const green = stepMachine(s.machine, { now: entered + 4 * MIN, unresolvedThreads: 0, unresolvedBotThreads: 0, ciPending: false });
  assert.equal(green.machine.state, STATES.DONE);
});

test('machine: 25-minute review cap forces SETTLED_CHECK', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['bugbot'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  const ack = { ack: { bugbot: true }, present: { bugbot: true } };
  m = stepMachine(m, { now: T0 + 35_000, signals: ack }).machine;
  const s = stepMachine(m, { now: T0 + 25 * MIN });
  assert.equal(s.machine.state, STATES.SETTLED_CHECK);
});

test('machine: --silence cap forces SETTLED regardless of state', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['bugbot'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  const s = stepMachine(m, {
    now: T0 + 30 * MIN,
    unresolvedThreads: 0,
    unresolvedBotThreads: 0,
    ciPending: true,
  });
  // Capped: CI pending no longer holds DONE back; the loop exits 8.
  assert.equal(s.machine.state, STATES.DONE);
});

test('machine: new head restarts at PUSHED with fresh t0 and no signals', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  m = stepMachine(m, { now: T0 + 35_000, signals: codexAck() }).machine;
  const s = stepMachine(m, { now: T0 + 40_000, head: OLD_HEAD });
  assert.equal(s.machine.state, STATES.PUSHED);
  assert.equal(s.machine.head, OLD_HEAD);
  assert.equal(s.machine.t0, T0 + 40_000);
  assert.equal(s.machine.signals.ack.codex, false);
  assert.deepEqual(s.machine.enabledBots, ['codex']);
  assert.deepEqual(s.actions, ['head-changed']);
});

test('machine: CI pending stretches the REVIEWING poll to 60s', () => {
  let m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  m = stepMachine(m, { now: T0 + 20_000 }).machine;
  const s = stepMachine(m, { now: T0 + 35_000, signals: codexAck(), ciPending: true });
  assert.equal(s.machine.state, STATES.REVIEWING);
  assert.equal(s.nextPollMs, SETTLED_DEFAULTS.ciPendingPollMs);
});

test('enabledBotsOf falls back to bots present on the PR', () => {
  const m = createMachine({ head: HEAD, t0: T0 });
  m.signals.present.codex = true;
  m.signals.present.bugbot = true;
  assert.deepEqual(enabledBotsOf(m), ['codex', 'bugbot']);
  const explicit = createMachine({ head: HEAD, t0: T0, enabledBots: ['copilot'] });
  assert.deepEqual(enabledBotsOf(explicit), ['copilot']);
});

test('threadsAreFresh requires a read after the last bot comment', () => {
  const m = createMachine({ head: HEAD, t0: T0 });
  assert.equal(threadsAreFresh(m), false);
  m.unresolvedThreads = 0;
  m.threadsAt = T0 + 10;
  assert.equal(threadsAreFresh(m), true);
  m.lastBotActivityAt = T0 + 20;
  assert.equal(threadsAreFresh(m), false);
  m.threadsAt = T0 + 20;
  assert.equal(threadsAreFresh(m), true);
});

test('machineSnapshot exposes state, head, threads, signals, nextPollMs', () => {
  const m = createMachine({ head: HEAD, t0: T0, enabledBots: ['codex'] });
  const snap = machineSnapshot(m, 1234);
  assert.equal(snap.state, STATES.PUSHED);
  assert.equal(snap.head, HEAD);
  assert.equal(snap.unresolvedBotThreads, null);
  assert.equal(snap.nextPollMs, 1234);
  assert.deepEqual(snap.signals.enabled, ['codex']);
  assert.equal(snap.signals.ack.codex, false);
});

// ==========================================================================
// gh api -i PARSING
// ==========================================================================

test('parseGhHttpResponse reads status, etag and JSON body', () => {
  const raw = [
    'HTTP/2.0 200 OK',
    'Content-Type: application/json; charset=utf-8',
    'Etag: W/"abc123"',
    'X-Ratelimit-Remaining: 4999',
    '',
    '[{"id":1}]',
    '',
  ].join('\r\n');
  const parsed = parseGhHttpResponse(raw);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.etag, 'W/"abc123"');
  assert.deepEqual(parsed.body, [{ id: 1 }]);
  assert.equal(parsed.headers['x-ratelimit-remaining'], '4999');
});

test('parseGhHttpResponse handles 304 with no body', () => {
  const parsed = parseGhHttpResponse('HTTP/2.0 304 Not Modified\nEtag: W/"abc"\n\n');
  assert.equal(parsed.status, 304);
  assert.equal(parsed.body, null);
  assert.equal(parseGhHttpResponse('not http'), null);
});

test('createGhAdapter.get sends If-None-Match and accepts 304 exit 1', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(args);
    if (args.includes('If-None-Match: W/"e1"')) {
      return { status: 1, stdout: 'HTTP/2.0 304 Not Modified\nEtag: W/"e1"\n\n', stderr: '' };
    }
    return { status: 0, stdout: 'HTTP/2.0 200 OK\nEtag: W/"e1"\n\n[]\n', stderr: '' };
  };
  const adapter = createGhAdapter('/tmp', { spawn });
  const first = adapter.get('repos/o/r/pulls/1/comments');
  assert.equal(first.status, 200);
  assert.equal(first.etag, 'W/"e1"');
  const second = adapter.get('repos/o/r/pulls/1/comments', { etag: first.etag });
  assert.equal(second.status, 304);
  assert.equal(calls[0][0], 'api');
  assert.equal(calls[0][1], '-i');
  assert.ok(calls[1].includes('If-None-Match: W/"e1"'));
});

test('createGhAdapter.get throws on HTTP errors and garbage', () => {
  const adapter = createGhAdapter('/tmp', {
    spawn: () => ({ status: 1, stdout: 'HTTP/2.0 403 Forbidden\n\n{"message":"no"}', stderr: '' }),
  });
  assert.throws(() => adapter.get('x'), /HTTP 403/);
  const broken = createGhAdapter('/tmp', {
    spawn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
  });
  assert.throws(() => broken.get('x'), /boom/);
});

test('createGhAdapter.post and graphql shape their gh args', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: '{"data":{}}', stderr: '' };
  };
  const adapter = createGhAdapter('/tmp', { spawn });
  adapter.post('repos/o/r/issues/1/comments', { body: '@codex review' });
  assert.deepEqual(calls[0].slice(0, 3), ['api', '--method', 'POST']);
  assert.ok(calls[0].includes('body=@codex review'));
  adapter.graphql('query($id:ID!){node(id:$id){id}}', { id: 'PRRT_1' });
  assert.equal(calls[1][1], 'graphql');
  assert.ok(calls[1].includes('id=PRRT_1'));
});

test('pollEndpoints uses owner/name from the resolved repo, never a hardcode', () => {
  const eps = pollEndpoints({ owner: 'acme', name: 'widgets' }, 12, HEAD, T0);
  for (const value of Object.values(eps)) {
    assert.ok(value.startsWith('repos/acme/widgets/'), value);
  }
  assert.ok(eps.reviewComments.includes(`since=${new Date(T0).toISOString()}`));
  assert.ok(eps.checkRuns.includes(`commits/${HEAD}/check-runs`));
});

// ==========================================================================
// POLLER (fake adapter — no network)
// ==========================================================================

/**
 * Scripted GitHub: bodies per endpoint key, ETag = JSON hash so a
 * repeated identical body yields 304.
 */
function fakeGithub() {
  const world = {
    reviewComments: [],
    reviews: [],
    issueComments: [],
    reactions: [],
    checkRuns: { check_runs: [] },
    pull: { head: { sha: HEAD }, requested_reviewers: [] },
    posts: [],
    graphqlCalls: 0,
    getCalls: 0,
  };
  const keyFor = (path) => {
    if (path.includes('/pulls/') && path.includes('/comments')) return 'reviewComments';
    if (path.includes('/reviews')) return 'reviews';
    if (path.includes('/issues/') && path.includes('/comments')) return 'issueComments';
    if (path.includes('/reactions')) return 'reactions';
    if (path.includes('/check-runs')) return 'checkRuns';
    return 'pull';
  };
  const adapter = {
    get(path, { etag } = {}) {
      world.getCalls += 1;
      const body = world[keyFor(path)];
      const tag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
      if (etag && etag === tag) return { status: 304, etag: tag, body: null };
      return { status: 200, etag: tag, body: JSON.parse(JSON.stringify(body)) };
    },
    post(path, fields) {
      world.posts.push({ path, fields });
      return { id: 1 };
    },
    graphql() {
      world.graphqlCalls += 1;
      return { data: {} };
    },
  };
  return { world, adapter };
}

test('poller: Codex round trip — ack, review, ACTING with threads', () => {
  const { world, adapter } = fakeGithub();
  let clock = T0;
  let threads = { unresolvedThreads: 0, unresolvedBotThreads: 0 };
  let refreshes = 0;
  const logs = [];
  const poller = createSettledPoller({
    repo: { owner: 'acme', name: 'widgets' },
    prNumber: 5,
    head: HEAD,
    t0: T0,
    adapter,
    enabledBots: ['codex'],
    now: () => clock,
    log: (line) => logs.push(line),
    refreshThreads: () => {
      refreshes += 1;
      return { ...threads, ciPending: false, ciFailed: false };
    },
  });

  // PUSHED: no network at all.
  let r = poller.poll();
  assert.equal(r.machine.state, STATES.PUSHED);
  assert.equal(world.getCalls, 0);

  clock = T0 + 20_000;
  r = poller.poll();
  assert.equal(r.machine.state, STATES.AWAITING_ACK);
  const callsAfterFirstRest = world.getCalls;
  assert.ok(callsAfterFirstRest > 0);
  assert.equal(refreshes, 1, 'first REST round seeds the thread count');

  // Unchanged world → every endpoint 304, no thread refresh.
  clock = T0 + 35_000;
  r = poller.poll();
  assert.equal(r.machine.state, STATES.AWAITING_ACK);
  assert.equal(refreshes, 1);

  // Codex 👀 → ack.
  world.reactions.push({
    content: 'eyes',
    user: { login: 'chatgpt-codex-connector[bot]' },
    created_at: new Date(T0 + 40_000).toISOString(),
  });
  clock = T0 + 50_000;
  r = poller.poll();
  assert.equal(r.machine.state, STATES.REVIEWING);
  assert.equal(refreshes, 1, 'reactions alone do not trigger GraphQL');

  // Codex posts its review with inline threads.
  world.reviews.push({
    id: 900,
    user: { login: 'chatgpt-codex-connector[bot]' },
    commit_id: HEAD,
    submitted_at: new Date(T0 + 70_000).toISOString(),
    state: 'COMMENTED',
    body: 'Codex Review: 2 findings',
  });
  world.reviewComments.push({
    id: 901,
    user: { login: 'chatgpt-codex-connector[bot]' },
    commit_id: HEAD,
    created_at: new Date(T0 + 70_000).toISOString(),
    body: '[P1] bug',
  });
  threads = { unresolvedThreads: 2, unresolvedBotThreads: 2 };
  clock = T0 + 80_000;
  r = poller.poll();
  assert.equal(r.machine.state, STATES.ACTING);
  assert.equal(refreshes, 2, 'REST 200 triggered exactly one thread refresh');
  assert.equal(r.nextPollMs, 0);
  assert.equal(world.posts.length, 0);
  assert.ok(logs.some((l) => l.includes('→ ACTING')));

  const snap = poller.snapshot();
  assert.equal(snap.state, STATES.ACTING);
  assert.equal(snap.unresolvedBotThreads, 2);
  assert.equal(snap.signals.complete.codex, true);
});

test('poller: no ack in 3 min posts "@codex review" exactly once', () => {
  const { world, adapter } = fakeGithub();
  let clock = T0;
  const poller = createSettledPoller({
    repo: { owner: 'acme', name: 'widgets' },
    prNumber: 5,
    head: HEAD,
    t0: T0,
    adapter,
    enabledBots: ['codex'],
    now: () => clock,
    refreshThreads: () => ({ unresolvedThreads: 0, unresolvedBotThreads: 0 }),
  });
  clock = T0 + 20_000;
  poller.poll();
  clock = T0 + 20_000 + 3 * MIN;
  const r = poller.poll();
  assert.equal(r.machine.state, STATES.REVIEWING);
  assert.equal(world.posts.length, 1);
  assert.equal(world.posts[0].fields.body, BOTS.codex.retrigger);
  assert.equal(world.posts[0].path, 'repos/acme/widgets/issues/5/comments');
  clock += 30_000;
  poller.poll();
  assert.equal(world.posts.length, 1);
});

test('poller: remote head change restarts and clears ETags', () => {
  const { world, adapter } = fakeGithub();
  let clock = T0;
  const poller = createSettledPoller({
    repo: { owner: 'acme', name: 'widgets' },
    prNumber: 5,
    head: HEAD,
    t0: T0,
    adapter,
    enabledBots: ['codex'],
    now: () => clock,
    refreshThreads: () => ({ unresolvedThreads: 0, unresolvedBotThreads: 0 }),
  });
  clock = T0 + 20_000;
  poller.poll();
  world.pull = { head: { sha: OLD_HEAD }, requested_reviewers: [] };
  clock = T0 + 35_000;
  const r = poller.poll();
  assert.equal(r.machine.state, STATES.PUSHED);
  assert.equal(r.machine.head, OLD_HEAD);
  assert.equal(r.machine.t0, T0 + 35_000);
  assert.deepEqual(r.actions, ['head-changed']);
});

test('poller: quiet PR with zero threads settles to DONE via SETTLED_CHECK', () => {
  const { adapter } = fakeGithub();
  let clock = T0;
  const poller = createSettledPoller({
    repo: { owner: 'acme', name: 'widgets' },
    prNumber: 5,
    head: HEAD,
    t0: T0,
    adapter,
    enabledBots: [],
    now: () => clock,
    refreshThreads: () => ({ unresolvedThreads: 0, unresolvedBotThreads: 0 }),
  });
  const states = [];
  for (let i = 0; i < 40 && !poller.machine.state.match(/DONE|ACTING/); i += 1) {
    const r = poller.poll();
    states.push(r.machine.state);
    clock += Math.max(r.nextPollMs, 1000);
  }
  assert.equal(poller.machine.state, STATES.DONE);
  assert.ok(states.includes(STATES.SETTLED_CHECK));
  assert.ok(clock - T0 < 12 * MIN, `settled in ${(clock - T0) / MIN} min`);
});

// ==========================================================================
// WEBHOOK
// ==========================================================================

test('webhookForwardArgs targets 127.0.0.1 receiver with the review events', () => {
  const args = webhookForwardArgs(
    { owner: 'acme', name: 'widgets' },
    'http://127.0.0.1:4321/webhook',
  );
  assert.deepEqual(args.slice(0, 2), ['webhook', 'forward']);
  assert.ok(args.includes('--repo=acme/widgets'));
  assert.ok(args.some((a) => a.startsWith('--events=') && a.includes('check_run')));
  assert.ok(args.includes('--url=http://127.0.0.1:4321/webhook'));
});

test('startWebhookReceiver wakes on POST and rejects other methods', async () => {
  const events = [];
  const receiver = await startWebhookReceiver({
    onEvent: (e) => events.push(e),
  });
  try {
    const res = await fetch(receiver.url, {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request_review' },
      body: '{}',
    });
    assert.equal(res.status, 204);
    const bad = await fetch(receiver.url);
    assert.equal(bad.status, 405);
    assert.deepEqual(events, ['pull_request_review']);
    assert.ok(receiver.url.startsWith('http://127.0.0.1:'));
  } finally {
    await receiver.close();
  }
});

test('spawnWebhookForwarder degrades silently when gh lacks the extension', async () => {
  const { EventEmitter } = await import('node:events');
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {};
    setTimeout(() => {
      child.stderr.emit('data', 'unknown command "webhook" for "gh"');
      child.exitCode = 1;
      child.emit('exit', 1);
    }, 1);
    return child;
  };
  const result = await spawnWebhookForwarder({
    repo: { owner: 'o', name: 'r' },
    url: 'http://127.0.0.1:1/webhook',
    spawnFn,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown command/);
});

// ==========================================================================
// WAKEABLE SLEEP
// ==========================================================================

test('createWakeableSleep resolves early on wake and remembers early wakes', async () => {
  const sleeper = createWakeableSleep();
  const pending = sleeper.sleep(10_000);
  sleeper.wake();
  assert.equal(await pending, 'woken');

  sleeper.wake();
  assert.equal(await sleeper.sleep(10_000), 'woken');
  assert.equal(await sleeper.sleep(1), 'timeout');
});
