import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runParallelLimited } from './lib/parallel.mjs';
import { verifyHooksWiring } from './lib/git-hooks-wiring.mjs';
import * as prepushTasks from './lib/prepush-tasks.mjs';
import {
  PHASE_PREPUSH,
  serializePushGateTask,
} from './lib/push-gate-tasks.mjs';
import { getRepoRoot } from './lib/pr-review-lib.mjs';
import { checkGatePassToken } from './lib/gate-pass-token.mjs';

const isWindows = process.platform === 'win32';

/** Kill hung concurrent pre-pushes after this long (ms). */
const PREPUSH_LOCK_STALE_MS = 45 * 60 * 1000;

const repoRoot = getRepoRoot();

function parseArgs(argv) {
  return argv.includes('--list-tasks');
}

function acquirePrepushLock() {
  const gitPath = spawnSync(
    'git',
    ['rev-parse', '--git-path', 'sea-trials-prepush.lock'],
    { encoding: 'utf8', shell: isWindows, cwd: repoRoot },
  );
  const lockPath =
    gitPath.status === 0 && (gitPath.stdout ?? '').trim()
      ? path.resolve(repoRoot, (gitPath.stdout ?? '').trim())
      : path.join(repoRoot, '.git', 'sea-trials-prepush.lock');
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > PREPUSH_LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // no lock yet
  }

  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let holder = '(unknown)';
      try {
        holder = fs.readFileSync(lockPath, 'utf8').trim() || holder;
      } catch {
        // ignore
      }
      process.stderr.write(
        `❌ Another pre-push is already running (${holder}).\n` +
          '   Wait for it to finish, or remove ' +
          `${lockPath} if it is stale.\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  const release = () => {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        release();
        process.exit(130);
      });
    } catch {
      // Windows may not support every signal
    }
  }
  return release;
}

{
  const wiring = verifyHooksWiring(repoRoot);
  if (!wiring.ok) {
    process.stderr.write(
      '\n❌ Git hooks wiring is broken — a worktree would push unchecked.\n'
        + wiring.problems.map((problem) => `   • ${problem}`).join('\n')
        + '\n   Fix: sh .husky/st-plugin-run.sh install-git-hooks\n',
    );
    process.exit(1);
  }
}

acquirePrepushLock();

async function main() {
  const listTasks = parseArgs(process.argv.slice(2));

  // `pnpm pr-review-push` already ran this exact gate on this exact
  // tree seconds ago and then invoked `git push`, which fired this hook.
  // Re-running `dart analyze` here doubled every push's wall clock.
  if (!listTasks) {
    const pass = checkGatePassToken(repoRoot, {
      requiredPhase: PHASE_PREPUSH,
    });
    if (pass.ok) {
      const ageSec = Math.round((pass.ageMs ?? 0) / 1000);
      process.stdout.write(
        `✅ Pre-push: ${pass.reason} (${ageSec}s ago via pr-review-push). ` +
          'Skipping duplicate gate. ST_PREPUSH_FORCE=1 to re-run.\n',
      );
      process.exit(0);
    }
  }

  const prep = prepushTasks.preparePrepushGate(repoRoot);
  if (!prep.ok) {
    process.stderr.write(`❌ ${prep.message}\n`);
    process.exit(2);
  }

  const ctx = prep.ctx;
  if (ctx.changed.length === 0) {
    process.stdout.write(
      '✅ No changed files detected. Proceeding with push...\n',
    );
    process.exit(0);
  }

  process.stdout.write(
    `🔎 Pre-push checks: ${ctx.changed.length} changed file(s) vs `
      + `${ctx.baseRef.slice(0, 12)}${
        ctx.hasFlutterWorkspaceLevelChange
          ? ' (workspace-level → full analyze)'
          : ctx.workspacePathHit
            ? ' (root tooling-only → scoped analyze)'
            : ''
      }\n`,
  );

  const tasks = prepushTasks.buildPrepushTasks(repoRoot, ctx);

  if (tasks.length === 0) {
    process.stdout.write('✅ No checks needed. Proceeding with push...\n');
    process.exit(0);
  }

  if (listTasks) {
    let index = 0;
    for (const task of tasks) {
      index += 1;
      process.stdout.write(
        `${JSON.stringify(
          serializePushGateTask({
            phase: PHASE_PREPUSH,
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
      '\n🛠️  Most issues are auto-fixable. Run:\n' +
        '  pnpm precommit\n' +
        '  git add -u && git commit --amend --no-edit\n\n',
    );
    process.exit(1);
  }

  process.stdout.write('✅ All checks passed. Proceeding with push...\n');
}

main().catch((err) => {
  process.stderr.write(`Pre-push error: ${err.message}\n`);
  process.exit(2);
});
