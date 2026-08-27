#!/usr/bin/env node
/**
 * Review-loop push gate: local agent-prepush, then git push (prepush hook).
 *
 *   pnpm pr-review-push
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  buildReviewSnapshot,
  evaluateSnapshot,
  fetchPrMeta,
  getRepoRoot,
  parsePrArgs,
  reviewPaths,
  runGitPush,
  runLocalPrepush,
  writeJson,
} from './lib/pr-review-lib.mjs';

const isWindows = process.platform === 'win32';

function readHeadOid(repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    cwd: repoRoot,
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git rev-parse HEAD failed');
  }
  return (result.stdout ?? '').trim();
}

const repoRoot = getRepoRoot();
const { prNumber } = parsePrArgs(process.argv.slice(2));
const pr = fetchPrMeta(repoRoot, prNumber);
const artifactPaths = reviewPaths(repoRoot, prNumber);
const headBeforePush = readHeadOid(repoRoot);

process.stdout.write(`PR #${prNumber} push gate (${pr.headRefName})\n`);

const local = runLocalPrepush(repoRoot);
if (!local.ok) {
  process.stderr.write(local.stderr || local.stdout);
  process.exit(4);
}
process.stdout.write('✅ agent-prepush\n');

const push = runGitPush(repoRoot, pr.headRefName);
if (!push.ok) {
  process.stderr.write(push.stderr || push.stdout);
  process.exit(push.status || 1);
}
process.stdout.write('✅ git push (prepush hook)\n');

const snapshot = buildReviewSnapshot(repoRoot, prNumber);
const headPropagated = snapshot.pr.headRefOid === headBeforePush;
const verdict = evaluateSnapshot(snapshot);
writeJson(path.join(repoRoot, artifactPaths.state), {
  ...snapshot,
  lastPush: { at: new Date().toISOString(), headRefOid: headBeforePush },
});

if (!headPropagated) {
  process.stdout.write(
    '⏳ PR head not yet propagated; run pnpm pr-review-loop\n',
  );
  process.exit(8);
}

if (snapshot.ci.hasPending) {
  process.stdout.write(
    `⏳ CI pending (${snapshot.ci.pending.length}); `
      + 'run pnpm pr-review-loop\n',
  );
  process.exit(8);
}

if (!verdict.ok) {
  process.stderr.write(`Post-push gate: ${verdict.reason}\n`);
  process.exit(verdict.exitCode);
}

process.stdout.write('✅ post-push gate clean\n');
process.exit(0);
