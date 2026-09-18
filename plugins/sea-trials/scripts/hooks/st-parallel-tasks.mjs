#!/usr/bin/env node
/**
 * Emit JSON lines for maximum parallel Task fan-out across st-* workflows.
 *
 * Aggregates list-tasks from agent-prepush, pr-local-ci, and
 * pr-review-adversarial-tasks so the parent launches ONE Task per line
 * in a SINGLE turn.
 *
 *   pnpm st-parallel-tasks -- --pr 1657
 *   pnpm st-parallel-tasks -- --pr 1657 --phases prepush,ci,review
 *   pnpm st-parallel-tasks -- --phases prepush
 *
 * Each line includes `source` (prepush|ci|review) plus the child fields.
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

function emit(source, lines) {
  for (const line of lines) {
    const task = JSON.parse(line);
    process.stdout.write(`${JSON.stringify({ source, ...task })}\n`);
  }
}

function main() {
  const { pr, repo, phases } = parseArgs(process.argv.slice(2));

  if (phases.has('prepush')) {
    emit(
      'prepush',
      runJsonLines('pnpm', ['agent-prepush', '--', '--list-tasks']),
    );
  }

  if (phases.has('ci')) {
    if (!pr || Number.isNaN(pr)) {
      throw new Error('ci phase requires --pr <n>');
    }
    emit(
      'ci',
      runJsonLines('pnpm', [
        'pr-local-ci',
        '--',
        '--pr',
        String(pr),
        '--list-tasks',
      ]),
    );
  }

  if (phases.has('review')) {
    if (!pr || Number.isNaN(pr)) {
      throw new Error('review phase requires --pr <n>');
    }
    emit(
      'review',
      runJsonLines('node', [
        path.join(hooksDir, 'pr-review-adversarial-tasks.mjs'),
        '--pr',
        String(pr),
        '--repo',
        repo,
      ]),
    );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`st-parallel-tasks: ${err.message}\n`);
  process.exit(1);
}
