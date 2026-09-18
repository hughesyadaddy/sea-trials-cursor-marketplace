import assert from 'node:assert/strict';
import test from 'node:test';

import {
  argvWithoutPnpmSeparator,
  formatBotReviewReply,
  hasMatchingReply,
  resolveRepo,
} from '../pr-review-threads.mjs';

test('resolveRepo parses --repo owner/name', () => {
  assert.deepEqual(resolveRepo('acme/widgets'), {
    owner: 'acme',
    name: 'widgets',
  });
});

test('resolveRepo rejects missing slug', () => {
  const prev = process.env.GH_REPO;
  delete process.env.GH_REPO;
  assert.throws(
    () => resolveRepo(undefined),
    /target repository required/,
  );
  if (prev) process.env.GH_REPO = prev;
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
