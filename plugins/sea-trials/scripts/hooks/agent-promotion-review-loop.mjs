#!/usr/bin/env node
/**
 * Autonomous promotion review loop: dev→stg→main.
 *
 *   sh .husky/st-plugin-run.sh agent-promotion-review-loop -- [stg_pr]
 *
 * Runs until Codex quiet + CI green, merges, waits for merge completion,
 * then advances to the next promotion phase.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepoRoot } from './lib/pr-review-lib.mjs';

const isWindows = process.platform === 'win32';
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const repoRoot = getRepoRoot();
const silenceMin = Number(process.env.ST_REVIEW_SILENCE_MIN ?? 60);
const pollSec = Number(process.env.ST_REVIEW_POLL_SEC ?? 30);

/**
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
  const result = spawnSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `gh ${args.join(' ')}`).trim(),
    );
  }
  return (result.stdout ?? '').trim();
}

/**
 * @param {string} logPath
 * @param {string} line
 */
function logLine(logPath, line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFileSync(logPath, msg);
  process.stderr.write(msg);
}

/**
 * @param {number} pr
 * @param {string} logPath
 * @returns {boolean}
 */
function waitForMergeQueue(pr, logPath) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    let state = 'UNKNOWN';
    try {
      state = runGh([
        'pr',
        'view',
        String(pr),
        '--json',
        'mergeStateStatus',
        '-q',
        '.mergeStateStatus',
      ]);
    } catch {
      // keep polling
    }
    if (state !== 'BLOCKED' && state !== 'BEHIND') {
      return true;
    }
    logLine(logPath, `PR #${pr} mergeState=${state} — waiting for queue`);
    spawnSync(isWindows ? 'powershell' : 'sleep', isWindows ? ['-Command', 'Start-Sleep', '-Seconds', '15'] : ['15'], {
      stdio: 'ignore',
    });
  }
  return false;
}

/**
 * Wait until GitHub reports the PR as merged (merge queue / async merge).
 *
 * @param {number} pr
 * @param {string} logPath
 * @returns {boolean}
 */
function waitForPrMerged(pr, logPath) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    let state = 'UNKNOWN';
    try {
      state = runGh([
        'pr',
        'view',
        String(pr),
        '--json',
        'state',
        '-q',
        '.state',
      ]);
    } catch {
      // keep polling
    }
    if (state === 'MERGED') {
      return true;
    }
    logLine(
      logPath,
      `PR #${pr} state=${state} — waiting for merge to complete`,
    );
    spawnSync(isWindows ? 'powershell' : 'sleep', isWindows ? ['-Command', 'Start-Sleep', '-Seconds', '15'] : ['15'], {
      stdio: 'ignore',
    });
  }
  return false;
}

/**
 * @param {string} logPath
 * @param {string[]} pnpmArgs
 * @returns {number}
 */
function runPnpmLogged(logPath, pnpmArgs) {
  const result = spawnSync('pnpm', pnpmArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (out.trim()) {
    fs.appendFileSync(logPath, `${out}\n`);
    process.stderr.write(out);
  }
  return result.status ?? 1;
}

/**
 * @param {string} phase
 * @param {number} pr
 * @param {string} base
 * @param {string} head
 * @param {string} nextPhase
 * @returns {boolean}
 */
function runPhase(phase, pr, base, head, nextPhase) {
  const scopeDir = path.join(repoRoot, 'docs/code-review', phase);
  fs.mkdirSync(scopeDir, { recursive: true });
  const log = path.join(scopeDir, `pr-${pr}-promotion-loop.log`);
  const signal = path.join(scopeDir, `pr-${pr}-acting.signal`);

  logLine(
    log,
    `=== PHASE ${phase}: PR #${pr} (${head}→${base}) ===`,
  );

  while (true) {
    fs.appendFileSync(log, '\n');
    logLine(
      log,
      `pr-review-loop start pr=${pr} silence=${silenceMin}m`,
    );
    const ec = runPnpmLogged(log, [
      'pr-review-loop',
      '--',
      '--pr',
      String(pr),
      '--silence',
      String(silenceMin),
      '--bots',
      'codex',
    ]);

    let status = '';
    const statusResult = spawnSync(
      'pnpm',
      ['pr-review-status', '--', '--pr', String(pr)],
      { cwd: repoRoot, encoding: 'utf8', shell: true },
    );
    status = `${statusResult.stdout ?? ''}${statusResult.stderr ?? ''}`;
    fs.appendFileSync(log, `${status}\n`);
    process.stderr.write(status);

    if (ec === 0) {
      logLine(
        log,
        `DONE: quiet window + green CI — merging PR #${pr}`,
      );
      fs.writeFileSync(
        signal,
        `MERGE_READY ${new Date().toISOString()}\n`,
      );
      waitForMergeQueue(pr, log);
      const mergeResult = spawnSync(
        'gh',
        ['pr', 'merge', String(pr), '--merge'],
        { cwd: repoRoot, encoding: 'utf8', shell: isWindows },
      );
      const mergeOut = `${mergeResult.stdout ?? ''}${mergeResult.stderr ?? ''}`;
      if (mergeOut.trim()) {
        fs.appendFileSync(log, `${mergeOut}\n`);
        process.stderr.write(mergeOut);
      }
      if (mergeResult.status === 0 && waitForPrMerged(pr, log)) {
        logLine(log, `MERGED PR #${pr}`);
        if (nextPhase === 'done') {
          fs.writeFileSync(
            signal,
            `ALL_PHASES_COMPLETE ${new Date().toISOString()}\n`,
          );
        }
        return true;
      }
    }

    const unresolved = /unresolved=[1-9]/.test(status);
    if (ec === 2 || unresolved) {
      fs.writeFileSync(
        signal,
        `ACTING_THREADS ${new Date().toISOString()} ec=${ec}\n`,
      );
      logLine(log, '>>> Agent action: unresolved Codex threads');
    } else if (ec === 3 || /fail=1|failed ci:/.test(status)) {
      fs.writeFileSync(
        signal,
        `ACTING_CI ${new Date().toISOString()} ec=${ec}\n`,
      );
      logLine(log, '>>> Agent action: CI failure');
    } else if (ec === 8) {
      fs.writeFileSync(
        signal,
        `PENDING_CI ${new Date().toISOString()}\n`,
      );
      logLine(log, 'CI still pending at cap — continuing watch');
    } else {
      fs.writeFileSync(
        signal,
        `LOOP_CONTINUE ${new Date().toISOString()} ec=${ec}\n`,
      );
    }

    spawnSync(isWindows ? 'powershell' : 'sleep', isWindows ? ['-Command', 'Start-Sleep', '-Seconds', String(pollSec)] : [String(pollSec)], {
      stdio: 'ignore',
    });
  }
}

function main() {
  const tokens = process.argv.slice(2);
  const prStg = tokens[0] && !tokens[0].startsWith('-') ? tokens[0] : '1702';

  if (!runPhase('stg', Number(prStg), 'stg', 'dev', 'prod')) {
    process.exit(1);
  }

  const prodDir = path.join(repoRoot, 'docs/code-review/prod');
  fs.mkdirSync(prodDir, { recursive: true });

  const ensureScript = path.join(
    pluginRoot,
    'scripts/hooks/pr-promotion-ensure.mjs',
  );
  const ensureResult = spawnSync(
    process.execPath,
    [
      ensureScript,
      '--',
      '--base',
      'main',
      '--head',
      'stg',
      '--title',
      'PROD <- STG',
      '--body',
      `Promotion stg→main after ${silenceMin}m Codex quiet window on #${prStg}.`,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (ensureResult.status !== 0) {
    throw new Error(
      (ensureResult.stderr || ensureResult.stdout || 'pr-promotion-ensure failed').trim(),
    );
  }
  const prMain = (ensureResult.stdout ?? '').trim();
  const prodLog = path.join(prodDir, `pr-${prMain}-promotion-loop.log`);
  logLine(prodLog, `Created/found PROD PR #${prMain}`);

  if (!runPhase('prod', Number(prMain), 'main', 'stg', 'done')) {
    process.exit(1);
  }

  const completeLog = path.join(prodDir, 'pipeline-complete.log');
  logLine(completeLog, 'PIPELINE COMPLETE dev→stg→main');
}

main();
