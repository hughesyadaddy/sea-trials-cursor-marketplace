#!/usr/bin/env node
/**
 * Dirty-tree validation — repo planners, plugin-orchestrated at runtime.
 *
 * Prefer: pnpm pr-review-push -- --pr <n> --list-tasks
 */
import { runParallelLimited } from './lib/parallel.mjs';
import * as dirtyTree from './lib/dirty-tree-tasks.mjs';
import { getRepoRoot } from './lib/pr-review-lib.mjs';
import {
  PHASE_DIRTY,
  serializePushGateTask,
} from './lib/push-gate-tasks.mjs';

function parseArgs(argv) {
  const flags = new Set();
  for (const arg of argv) {
    if (arg === '--analyze-only') flags.add('analyze-only');
    else if (arg === '--tests-only') flags.add('tests-only');
    else if (arg === '--list-tasks') flags.add('list-tasks');
    else if (arg === '--help' || arg === '-h') flags.add('help');
    else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      process.exit(2);
    }
  }
  return flags;
}

function printHelp() {
  process.stdout.write(`\
Dirty-tree validation (subset of pr-review-push).

  pnpm agent-prepush
  pnpm agent-prepush --list-tasks

Canonical gate: pnpm pr-review-push -- --pr <n>
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const repoRoot = getRepoRoot();

  if (flags.has('help')) {
    printHelp();
    process.exit(0);
  }

  const analyzeOnly = flags.has('analyze-only');
  const testsOnly = flags.has('tests-only');
  const listTasks = flags.has('list-tasks');

  const prep = dirtyTree.prepareDirtyTreeGate({ repoRoot, testsOnly });
  if (!prep.ok) {
    process.stderr.write(`❌ ${prep.message}\n`);
    process.exit(2);
  }

  const changed = prep.changed;
  if (changed.length === 0) {
    process.stdout.write('✅ No dirty files to validate.\n');
    process.exit(0);
  }

  process.stdout.write(
    `🔎 Agent pre-push (${changed.length} dirty file(s))…\n`,
  );

  const tasks = dirtyTree.buildDirtyTreeTasks({
    repoRoot,
    changed,
    analyzeOnly,
    testsOnly,
  });

  if (tasks.length === 0) {
    process.stdout.write('✅ Nothing to run for current flags.\n');
    process.exit(0);
  }

  if (listTasks) {
    let index = 0;
    for (const task of tasks) {
      index += 1;
      process.stdout.write(
        `${JSON.stringify(
          serializePushGateTask({
            phase: PHASE_DIRTY,
            group: 1,
            parallel: true,
            task,
            repoRoot,
            index,
          }),
        )}\n`,
      );
    }
    process.exit(0);
  }

  const { failures } = await runParallelLimited(tasks);

  if (failures.length > 0) {
    process.stderr.write(
      '\n❌ Agent pre-push failed. Fix issues above.\n' +
        'Use: pnpm pr-review-push -- --pr <n>\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    '✅ Agent pre-push passed (dirty tree).\n' +
      'Use: pnpm pr-review-push -- --pr <n>\n',
  );
}

main().catch((err) => {
  process.stderr.write(`Agent pre-push error: ${err.message}\n`);
  process.exit(2);
});
