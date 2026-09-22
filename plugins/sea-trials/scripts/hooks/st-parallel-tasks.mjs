#!/usr/bin/env node
/**
 * Emit JSON lines for maximum parallel Task fan-out.
 *
 * Delegates push-gate tasks to pr-review-push --list-tasks (canonical).
 * Review adversarial tasks remain a separate phase.
 *
 *   pnpm st-parallel-tasks -- --pr 1657
 *   pnpm st-parallel-tasks -- --pr 1657 --phases review
 *   pnpm st-parallel-tasks -- --pr 1657 --granularity fine
 *
 * Every field the upstream emitters put on a task line — including
 * `subagent_type`, `model`, `claudeModel` — is forwarded untouched; this
 * script only prepends `source`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepoRoot } from './lib/pr-review-lib.mjs';

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = getRepoRoot();

const GRANULARITIES = new Set(['fine', 'coarse']);

function parseArgs(argv) {
  const out = {
    pr: null,
    repo: 'hughesyadaddy/sea_trials_universal',
    phases: new Set(['prepush', 'ci', 'review']),
    granularity: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pr') out.pr = Number(argv[++i]);
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--phases') {
      out.phases = new Set(argv[++i].split(',').map((p) => p.trim()));
    } else if (arg === '--granularity') {
      const value = String(argv[++i] ?? '').trim();
      if (!GRANULARITIES.has(value)) {
        throw new Error('--granularity must be fine or coarse');
      }
      out.granularity = value;
    }
  }
  return out;
}

/**
 * Extra args for `pr-review-push --list-tasks` given a granularity.
 * Omitted → pr-review-push's own default (fine).
 *
 * @param {string|null} granularity
 * @returns {string[]}
 */
function granularityArgs(granularity) {
  return granularity ? ['--granularity', granularity] : [];
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

/**
 * Prepend `source` without touching any upstream field (model tiering,
 * subagent_type, prompts, paths all pass through as-is).
 *
 * @param {string} source
 * @param {object} task
 */
function tagSource(source, task) {
  return { source, ...task };
}

function emitGatePhase(pr, phaseName, gatePhase, granularity) {
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
    ...granularityArgs(granularity),
  ]);
  for (const line of lines) {
    const task = JSON.parse(line);
    process.stdout.write(`${JSON.stringify(tagSource(phaseName, task))}\n`);
  }
}

function main() {
  const { pr, repo, phases, granularity } = parseArgs(
    process.argv.slice(2),
  );

  if (phases.has('prepush') || phases.has('ci')) {
    const gatePhases = [];
    if (phases.has('prepush')) {
      gatePhases.push('dirty', 'prepush');
    }
    if (phases.has('ci')) {
      gatePhases.push('ci');
    }
    emitGatePhase(
      pr,
      'push-gate',
      [...new Set(gatePhases)].join(','),
      granularity,
    );
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
      process.stdout.write(`${JSON.stringify(tagSource('review', task))}\n`);
    }
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`st-parallel-tasks: ${err.message}\n`);
  process.exit(1);
}
