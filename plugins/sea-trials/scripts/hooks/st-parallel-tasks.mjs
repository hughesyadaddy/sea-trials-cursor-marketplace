#!/usr/bin/env node
/**
 * Emit JSON lines for maximum parallel Task fan-out.
 *
 * Delegates push-gate tasks to pr-review-push --list-tasks (canonical).
 * Review adversarial tasks remain a separate phase.
 *
 *   pnpm st-parallel-tasks -- --pr 1657
 *   pnpm st-parallel-tasks -- --pr 1657 --phases review
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepoRoot } from './lib/pr-review-lib.mjs';

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = getRepoRoot();

function parseArgs(argv) {
  const out = {
    pr: null,
    repo: 'hughesyadaddy/sea_trials_universal',
    phases: new Set(['prepush', 'ci', 'review']),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pr') out.pr = Number(argv[++i]);
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--phases') {
      out.phases = new Set(argv[++i].split(',').map((p) => p.trim()));
    }
  }
  return out;
}

function runJsonLines(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (exit ${result.status}): ` +
        `${result.stderr || result.stdout || 'no output'}`,
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
}

function emitGatePhase(pr, phaseName, gatePhase) {
  if (!pr || Number.isNaN(pr)) {
    throw new Error(`${phaseName} phase requires --pr <n>`);
  }
  const lines = runJsonLines('node', [
    path.join(hooksDir, 'pr-review-push.mjs'),
    '--pr',
    String(pr),
    '--phases',
    gatePhase,
    '--list-tasks',
  ]);
  for (const line of lines) {
    const task = JSON.parse(line);
    process.stdout.write(
      `${JSON.stringify({ source: phaseName, ...task })}\n`,
    );
  }
}

function main() {
  const { pr, repo, phases } = parseArgs(process.argv.slice(2));

  if (phases.has('prepush') || phases.has('ci')) {
    const gatePhases = [];
    if (phases.has('prepush')) {
      gatePhases.push('dirty', 'prepush');
    }
    if (phases.has('ci')) {
      gatePhases.push('ci');
    }
    emitGatePhase(pr, 'push-gate', [...new Set(gatePhases)].join(','));
  }

  if (phases.has('review')) {
    if (!pr || Number.isNaN(pr)) {
      throw new Error('review phase requires --pr <n>');
    }
    const lines = runJsonLines('node', [
      path.join(hooksDir, 'pr-review-adversarial-tasks.mjs'),
      '--pr',
      String(pr),
      '--repo',
      repo,
    ]);
    for (const line of lines) {
      const task = JSON.parse(line);
      process.stdout.write(
        `${JSON.stringify({ source: 'review', ...task })}\n`,
      );
    }
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`st-parallel-tasks: ${err.message}\n`);
  process.exit(1);
}
