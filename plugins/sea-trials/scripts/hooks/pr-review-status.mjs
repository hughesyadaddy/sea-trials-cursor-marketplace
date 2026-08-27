#!/usr/bin/env node
/**
 * Instant PR gate: review threads + CI checks (+ optional local agent-prepush).
 *
 *   pnpm pr-review-status
 *   pnpm pr-review-status -- --json
 *   pnpm pr-review-status -- --local   # also run agent-prepush
 */
import path from 'node:path';
import {
  buildReviewSnapshot,
  evaluateSnapshot,
  getRepoRoot,
  parsePrArgs,
  reviewPaths,
  runLocalPrepush,
  writeJson,
  writeReviewState,
} from './lib/pr-review-lib.mjs';

const repoRoot = getRepoRoot();
const args = parsePrArgs(process.argv.slice(2));
const withLocal = process.argv.includes('--local');

if (!Number.isFinite(args.prNumber) || args.prNumber <= 0) {
  process.stderr.write('Invalid --pr number\n');
  process.exit(1);
}

let local = null;
if (withLocal) {
  process.stderr.write('Running local agent-prepush…\n');
  local = runLocalPrepush(repoRoot);
  if (!local.ok) {
    process.stderr.write(local.stderr || local.stdout);
    process.exit(4);
  }
}

const artifactPaths = reviewPaths(repoRoot, args.prNumber);

const snapshot = buildReviewSnapshot(repoRoot, args.prNumber);
if (local) {
  snapshot.local = { agentPrepush: 'pass' };
}
const verdict = evaluateSnapshot(snapshot);
snapshot.verdict = verdict;

writeReviewState(path.join(repoRoot, artifactPaths.state), snapshot);

if (args.json) {
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  const { pr, threads, ci } = snapshot;
  console.log(`PR #${pr.number}: ${pr.title}`);
  console.log(pr.url);
  console.log(
    `head=${pr.headRefOid.slice(0, 7)} mergeable=${pr.mergeable} `
      + `mergeState=${pr.mergeStateStatus}`,
  );
  console.log(
    `threads=${threads.total} unresolved=${threads.unresolvedCount}`,
  );
  console.log(
    `ci total=${ci.total} pass=${ci.total - ci.pending.length - ci.failed.length} `
      + `pending=${ci.pending.length} fail=${ci.failed.length}`,
  );

  if (ci.light.length > 0) {
    console.log('light ci:');
    for (const row of ci.light) {
      console.log(`  • ${row.name}: ${row.bucket}`);
    }
  }

  if (threads.unresolvedCount > 0) {
    for (const row of threads.unresolved) {
      console.log(`  THREAD ${row.path}:${row.line} (${row.author})`);
      console.log(`    ${row.preview}`);
    }
  }

  if (ci.failed.length > 0) {
    console.log('failed ci:');
    for (const row of ci.failed) {
      console.log(`  • ${row.name}`);
      console.log(`    ${row.link}`);
    }
  }

  if (ci.pending.length > 0) {
    console.log(`pending ci (${ci.pending.length}): ${ci.pending.join(', ')}`);
  }

  if (snapshot.ci.excludedCount > 0) {
    console.log(
      `ignored post-merge/aux checks (${snapshot.ci.excludedCount}) `
        + '(Main Guardrails, etc.)',
    );
  }

  if (verdict.ok) {
    console.log('OK — threads clear and CI green');
  } else if (verdict.reason === 'threads') {
    console.log('BLOCKED — open review threads');
  } else if (verdict.reason === 'ci-fail') {
    console.log('BLOCKED — CI failures');
  } else {
    console.log('WAIT — CI still running');
  }
}

if (snapshot.threads.unresolvedCount > 0) {
  writeJson(path.join(repoRoot, artifactPaths.queue), {
    pr: args.prNumber,
    at: snapshot.at,
    kind: 'threads',
    threads: snapshot.threads.unresolved,
  });
}

process.exit(verdict.exitCode);