#!/usr/bin/env node
/**
 * Canonical push path — scoped validation + push (remote CI is the broad gate).
 *
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-push.mjs --pr <n>
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-push.mjs --pr <n> --check-only
 *
 * Legacy CI-parity fan-out (humans / explicit opt-in only):
 *   --phases dirty,prepush,ci --list-tasks
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReviewSnapshot,
  evaluateSnapshot,
  fetchPrMeta,
  getRepoRoot,
  parsePrArgs,
  pruneClosedReviewArtifacts,
  reviewPaths,
  runGitPush,
  runLocalPushGate,
  waitForPrHeadPropagation,
  writeJson,
} from './lib/pr-review-lib.mjs';
import {
  buildPushGatePlan,
  emitPushGateTaskLines,
  PHASE_CI,
  PHASE_DIRTY,
  PHASE_PREPUSH,
  PHASE_SCOPED,
} from './lib/push-gate-tasks.mjs';
import * as dirtyTree from './lib/dirty-tree-tasks.mjs';
import * as prepushTasks from './lib/prepush-tasks.mjs';
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
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const base = parsePrArgs(argv);
  const phases = new Set([PHASE_SCOPED]);
  let listTasks = false;
  let checkOnly = false;
  // Fan-out defaults to fine: each worker owns a few files or one package.
  let granularity = GRANULARITY.FINE;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list-tasks') listTasks = true;
    else if (arg === '--check-only') checkOnly = true;
    else if (arg === '--granularity') {
      const value = (argv[++i] ?? '').trim();
      if (!Object.values(GRANULARITY).includes(value)) {
        process.stderr.write(
          `❌ --granularity must be one of: ${Object.values(GRANULARITY).join(', ')}\n`,
        );
        process.exit(2);
      }
      granularity = value;
    } else if (arg === '--phases') {
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

  return { ...base, listTasks, checkOnly, phases, granularity };
}

function printHelp() {
  process.stdout.write(`\
Canonical push path (scoped validation + git push; PR Checks on GitHub).

  node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-push.mjs --pr <n>
  node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-push.mjs --pr <n> --check-only

Legacy local CI-parity fan-out (opt-in):
  --phases dirty,prepush,ci [--list-tasks] [--granularity fine|coarse]

Agents: run agent-validate-changed before every commit; never bare git push.
`);
}

const validateScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'agent-validate-changed.mjs',
);

/**
 * Permanent scoped gate — explicit changed paths only (dart analyze + covering tests).
 *
 * @param {string} repoRoot
 */
function runScopedPushValidation(repoRoot) {
  /** @type {Set<string>} */
  const paths = new Set(dirtyTree.gitChangedRepoPaths(repoRoot));
  const prep = prepushTasks.preparePrepushGate(repoRoot);
  if (!prep.ok) {
    if (paths.size === 0) {
      return {
        ok: false,
        error: prep.message,
        steps: [{ name: 'scoped-validate', ok: false, stderr: prep.message }],
      };
    }
  } else {
    for (const p of prep.ctx.changed) paths.add(p);
  }

  if (paths.size === 0) {
    return {
      ok: true,
      steps: [{ name: 'scoped-validate', ok: true, stdout: 'No paths to validate' }],
    };
  }

  process.stdout.write(
    `🔎 Scoped validation (${paths.size} path(s)) via agent-validate-changed…\n`,
  );
  const result = spawnSync(
    process.execPath,
    [validateScript, ...paths],
    {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: isWindows,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    const err = [result.stderr, result.stdout].filter(Boolean).join('\n');
    return {
      ok: false,
      error: 'scoped validation failed',
      steps: [{ name: 'scoped-validate', ok: false, stderr: err }],
    };
  }
  const out = (result.stdout ?? '').trim();
  return {
    ok: true,
    steps: [{ name: 'scoped-validate', ok: true, stdout: out || 'OK' }],
  };
}

/** @param {Set<string>} phases */
function isLegacyPushGate(phases) {
  return (
    phases.has(PHASE_PREPUSH)
    || phases.has(PHASE_CI)
    || (phases.has(PHASE_DIRTY) && !phases.has(PHASE_SCOPED))
  );
}

async function main() {
  const repoRoot = getRepoRoot();
  const { prNumber, listTasks, checkOnly, phases, granularity } =
    parsePushArgs(process.argv.slice(2));
  const pr = fetchPrMeta(repoRoot, prNumber);
  const artifactPaths = reviewPaths(repoRoot, prNumber);
  const pruned = pruneClosedReviewArtifacts(repoRoot, {
    activePrNumbers: [prNumber],
  });
  if (pruned.pruned.length > 0) {
    process.stdout.write(
      `🧹 pruned stale review artifacts for PR(s): `
        + `${pruned.pruned.join(', ')}\n`,
    );
  }

  if (listTasks) {
    if (!isLegacyPushGate(phases)) {
      process.stderr.write(
        'ℹ️  Scoped push path: run agent-validate-changed before each commit;\n'
          + '    no gate fan-out. Legacy: --phases dirty,prepush,ci --list-tasks\n',
      );
      process.exit(0);
    }
    const plan = await buildPushGatePlan({
      repoRoot,
      prNumber,
      phases,
      granularity,
    });
    if (!plan.ok) {
      process.stderr.write(`❌ ${plan.error}\n`);
      process.exit(2);
    }
    emitPushGateTaskLines(plan, repoRoot);
    process.exit(0);
  }

  const headBeforePush = readHeadOid(repoRoot);
  process.stdout.write(`PR #${prNumber} push (${pr.headRefName})\n`);

  // A stale token from an earlier run must never vouch for this tree.
  clearGatePassToken(repoRoot);

  const local = isLegacyPushGate(phases)
    ? await runLocalPushGate(repoRoot, { prNumber, phases })
    : runScopedPushValidation(repoRoot);

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

  writeGatePassToken(repoRoot, {
    headOid: headBeforePush,
    phases: isLegacyPushGate(phases) ? phases : new Set([PHASE_SCOPED]),
    prNumber,
  });

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

  waitForPrHeadPropagation(repoRoot, prNumber, headBeforePush);
  const snapshot = buildReviewSnapshot(repoRoot, prNumber);
  const headPropagated = snapshot.pr.headRefOid === headBeforePush;
  const verdict = evaluateSnapshot(snapshot);
  writeJson(path.join(repoRoot, artifactPaths.state), {
    ...snapshot,
    lastPush: { at: new Date().toISOString(), headRefOid: headBeforePush },
  });

  if (!headPropagated) {
    process.stdout.write(
      '⏳ PR head not yet propagated after retries; '
        + 'run node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs\n',
    );
    process.exit(8);
  }

  if (snapshot.ci.hasPending) {
    process.stdout.write(
      `⏳ CI pending (${snapshot.ci.pending.length}); `
        + 'run node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs\n',
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
