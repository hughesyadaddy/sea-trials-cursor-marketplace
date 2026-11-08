import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyHooksWiring } from './lib/git-hooks-wiring.mjs';
import * as prepushTasks from './lib/prepush-tasks.mjs';
import { PHASE_SCOPED } from './lib/push-gate-tasks.mjs';
import { runScopedPerCommitValidate } from './lib/scoped-per-commit-validate.mjs';
import {
  commitValidateIsTrusted,
  commitValidateRecordPath,
} from './lib/commit-validate-record.mjs';
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

  if (!listTasks) {
    const pass = checkGatePassToken(repoRoot, {
      requiredPhase: PHASE_SCOPED,
    });
    if (pass.ok) {
      const ageSec = Math.round((pass.ageMs ?? 0) / 1000);
      process.stdout.write(
        `✅ Pre-push: ${pass.reason} (${ageSec}s ago via pr-review-push). ` +
          'Skipping duplicate scoped run. ST_PREPUSH_FORCE=1 to re-run.\n',
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
    `🔎 Pre-push (scoped): ${ctx.changed.length} changed file(s) vs `
      + `${ctx.baseRef.slice(0, 12)} — agent-validate-changed only\n`,
  );

  if (listTasks) {
    process.stdout.write(
      `${JSON.stringify({
        phase: PHASE_SCOPED,
        kind: 'scoped-validate',
        command: `node agent-validate-changed.mjs ${ctx.changed.length} path(s)`,
        paths: ctx.changed,
        subagent_type: 'generalPurpose',
      })}\n`,
    );
    process.exit(0);
  }

  let recordFp = '';
  try {
    const raw = fs.readFileSync(commitValidateRecordPath(repoRoot), 'utf8');
    recordFp = JSON.parse(raw).validateFingerprint ?? '';
  } catch {
    // no record
  }
  const trust = commitValidateIsTrusted(repoRoot, {
    scopePaths: ctx.changed,
    validateFingerprint: recordFp,
    requireMode: 'full',
  });
  if (trust.ok) {
    process.stdout.write(
      `✅ Pre-push: reusing commit validation on unchanged tree.\n`,
    );
    process.exit(0);
  }

  const result = runScopedPerCommitValidate(repoRoot, ctx.changed, {
    reuseCommitRecord: false,
    writeRecord: false,
  });
  if (!result.ok) {
    process.stderr.write(
      '\n🛠️  Fix failures on the changed paths, commit, retry.\n',
    );
    for (const step of result.steps) {
      if (!step.ok && step.stderr) process.stderr.write(`${step.stderr}\n`);
    }
    process.exit(1);
  }

  process.stdout.write('✅ Scoped pre-push passed. Proceeding with push...\n');
}

main().catch((err) => {
  process.stderr.write(`Pre-push error: ${err.message}\n`);
  process.exit(2);
});
