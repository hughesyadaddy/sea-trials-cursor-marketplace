#!/usr/bin/env node
/**
 * Canonical push gate — one entry point for checks + push.
 *
 *   pnpm pr-review-push -- --pr <n>           # full gate + push
 *   pnpm pr-review-push -- --pr <n> --list-tasks  # subagent fan-out
 *   pnpm pr-review-push -- --pr <n> --check-only  # gate without push
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
  runLocalPushGate,
  writeJson,
} from './lib/pr-review-lib.mjs';
import {
  buildPushGatePlan,
  emitPushGateTaskLines,
  PHASE_CI,
  PHASE_DIRTY,
  PHASE_PREPUSH,
} from './lib/push-gate-tasks.mjs';
import { GRANULARITY } from './lib/check-plan.mjs';
import {
  clearGatePassToken,
  writeGatePassToken,
} from './lib/gate-pass-token.mjs';

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

function parsePushArgs(argv) {
  const base = parsePrArgs(argv);
  const phases = new Set([PHASE_DIRTY, PHASE_PREPUSH, PHASE_CI]);
  let listTasks = false;
  let checkOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list-tasks') listTasks = true;
    else if (arg === '--check-only') checkOnly = true;
    else if (arg === '--phases') {
      phases.clear();
      for (const part of (argv[++i] ?? '').split(',')) {
        const trimmed = part.trim();
        if (trimmed) phases.add(trimmed);
      }
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { ...base, listTasks, checkOnly, phases };
}

function printHelp() {
  process.stdout.write(`\
Canonical push gate (one entry point).

  pnpm pr-review-push -- --pr <n>
  pnpm pr-review-push -- --pr <n> --list-tasks
  pnpm pr-review-push -- --pr <n> --check-only
  pnpm pr-review-push -- --pr <n> --phases dirty,prepush,ci

Subagents: one Task per JSON line from --list-tasks; run via
  pnpm run-gate-task -- '<json>'
Parent re-runs pr-review-push after fixes (never bare git push).
`);
}

async function main() {
  const repoRoot = getRepoRoot();
  const { prNumber, listTasks, checkOnly, phases } = parsePushArgs(
    process.argv.slice(2),
  );
  const pr = fetchPrMeta(repoRoot, prNumber);
  const artifactPaths = reviewPaths(repoRoot, prNumber);

  if (listTasks) {
    // Fan-out wants many small tasks: each worker owns a few files or
    // one package and can fix what it finds without stepping on others.
    const plan = await buildPushGatePlan({
      repoRoot,
      prNumber,
      phases,
      granularity: GRANULARITY.FINE,
    });
    if (!plan.ok) {
      process.stderr.write(`❌ ${plan.error}\n`);
      process.exit(2);
    }
    emitPushGateTaskLines(plan, repoRoot);
    process.exit(0);
  }

  const headBeforePush = readHeadOid(repoRoot);
  process.stdout.write(`PR #${prNumber} push gate (${pr.headRefName})\n`);

  // A stale token from an earlier run must never vouch for this tree.
  clearGatePassToken(repoRoot);
  const local = await runLocalPushGate(repoRoot, {
    prNumber,
    phases,
  });
  if (!local.ok) {
    for (const step of local.steps) {
      if (!step.ok) {
        process.stderr.write(
          step.stderr || step.stdout || `❌ ${step.name} failed\n`,
        );
        break;
      }
    }
    if (local.error) {
      process.stderr.write(`❌ ${local.error}\n`);
    }
    process.exit(4);
  }
  for (const step of local.steps) {
    const captured = (step.stdout ?? '').trim();
    if (captured) {
      process.stdout.write(`${captured}\n`);
    }
    process.stdout.write(`✅ ${step.name}\n`);
  }

  // Record the pass so the pre-push hook fired by `git push` below does
  // not re-run the committed-diff gate on the identical tree. The hook
  // re-validates HEAD + tree fingerprint + ST_REVIEW_PUSH before trusting
  // it (see lib/gate-pass-token.mjs). `--check-only` records it too so a
  // READY verdict followed by an immediate push is still a single run.
  if (phases.has(PHASE_PREPUSH)) {
    writeGatePassToken(repoRoot, {
      headOid: headBeforePush,
      phases,
      prNumber,
    });
  }

  if (checkOnly) {
    process.stdout.write('✅ push gate passed (--check-only)\n');
    process.exit(0);
  }

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
}

main().catch((err) => {
  process.stderr.write(`pr-review-push: ${err.message}\n`);
  process.exit(2);
});
