import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateSnapshot,
  filterPrGateChecks,
  mergeRecordedLastPush,
  parseGhPaginatedGraphql,
  parsePrArgs,
  PR_CI_WORKFLOW,
  readRecordedPushIso,
  reviewArtifactPaths,
} from './pr-review-lib.mjs';

test('evaluateSnapshot clean when threads and ci ok', () => {
  const snapshot = {
    threads: { unresolvedCount: 0 },
    ci: { hasFailure: false, hasPending: false },
  };
  assert.deepEqual(evaluateSnapshot(snapshot), {
    ok: true,
    reason: 'clean',
    exitCode: 0,
  });
});

test('evaluateSnapshot blocks on threads', () => {
  const snapshot = {
    threads: { unresolvedCount: 1 },
    ci: { hasFailure: false, hasPending: false },
  };
  assert.equal(evaluateSnapshot(snapshot).exitCode, 2);
});

test('evaluateSnapshot blocks on ci failure', () => {
  const snapshot = {
    threads: { unresolvedCount: 0 },
    ci: { hasFailure: true, hasPending: false },
  };
  assert.equal(evaluateSnapshot(snapshot).exitCode, 3);
});

test('evaluateSnapshot waits when ci not reported yet', () => {
  const snapshot = {
    threads: { unresolvedCount: 0 },
    ci: { hasFailure: false, hasPending: true },
  };
  assert.equal(evaluateSnapshot(snapshot).exitCode, 8);
});

test('parseGhPaginatedGraphql merges review thread pages', () => {
  const stdout = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: 'RT_1', isResolved: false }],
            },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: 'RT_2', isResolved: true }],
            },
          },
        },
      },
    }),
  ].join('\n');
  const nodes = parseGhPaginatedGraphql(stdout);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].id, 'RT_1');
});

test('parseGhPaginatedGraphql splits concatenated JSON on one line', () => {
  const pageOne = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ id: 'RT_a', isResolved: false }],
          },
        },
      },
    },
  });
  const pageTwo = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ id: 'RT_b', isResolved: true }],
          },
        },
      },
    },
  });
  const nodes = parseGhPaginatedGraphql(`${pageOne}${pageTwo}`);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].id, 'RT_b');
});

test('parsePrArgs uses explicit --pr flag', () => {
  const parsed = parsePrArgs(['--pr', '42', '--once']);
  assert.equal(parsed.prNumber, 42);
  assert.equal(parsed.once, true);
  assert.equal(parsed.intervalSec, 15);
});

test('parsePrArgs honors defaults.pr when --pr omitted', () => {
  const parsed = parsePrArgs(['--interval', '30'], { pr: 99 });
  assert.equal(parsed.prNumber, 99);
  assert.equal(parsed.intervalSec, 30);
});

test('mergeRecordedLastPush preserves lastPush across snapshot writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-'));
  const statePath = path.join(dir, 'pr-review-state.json');
  const snapshot = {
    at: '2026-08-26T07:00:00.000Z',
    pr: { headRefOid: 'abc123' },
  };
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      lastPush: {
        at: '2026-08-26T00:00:00.000Z',
        headRefOid: 'abc123',
      },
    }),
  );
  const merged = mergeRecordedLastPush(statePath, snapshot);
  assert.deepEqual(merged.lastPush, {
    at: '2026-08-26T00:00:00.000Z',
    headRefOid: 'abc123',
  });
  assert.equal(merged.at, snapshot.at);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readRecordedPushIso returns push time for matching head', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-'));
  const stateRel = path.join(
    'docs',
    'code-review',
    'fix-ai-assistant-online-path-and-loading-ux',
    'pr-review-state.json',
  );
  const scopedState = path.join(dir, stateRel);
  fs.mkdirSync(path.dirname(scopedState), { recursive: true });
  fs.writeFileSync(
    scopedState,
    JSON.stringify({
      lastPush: {
        at: '2026-08-26T00:00:00.000Z',
        headRefOid: 'abc123',
      },
    }),
  );
  assert.equal(
    readRecordedPushIso(dir, 'abc123', stateRel),
    '2026-08-26T00:00:00.000Z',
  );
  assert.equal(readRecordedPushIso(dir, 'other', stateRel), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reviewArtifactPaths derives artifact dir from PR head branch', () => {
  const paths = reviewArtifactPaths(
    'fix/ai-assistant-online-path-and-loading-ux',
    1553,
  );
  assert.equal(
    paths.artifactDir,
    path.join('docs', 'code-review', 'fix-ai-assistant-online-path-and-loading-ux'),
  );
  assert.equal(paths.loopLog, path.join(paths.artifactDir, 'pr-1553-loop-log.txt'));
});

test('reviewArtifactPaths falls back to pr-N when head ref is missing', () => {
  const paths = reviewArtifactPaths(null, 99);
  assert.equal(paths.artifactDir, path.join('docs', 'code-review', 'pr-99'));
});

test('filterPrGateChecks keeps only PR Checks workflow', () => {
  const checks = [
    { name: 'dart-static', workflow: PR_CI_WORKFLOW, bucket: 'pass' },
    { name: 'dart-full-audit', workflow: 'Main Guardrails', bucket: 'pending' },
    { name: 'test', workflow: 'spell_checker', bucket: 'pass' },
  ];
  const gated = filterPrGateChecks(checks);
  assert.equal(gated.length, 1);
  assert.equal(gated[0].name, 'dart-static');
});
