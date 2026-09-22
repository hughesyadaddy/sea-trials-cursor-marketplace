#!/usr/bin/env node
/**
 * Run one push-gate task from JSON (subagent fan-out contract).
 *
 *   node scripts/hooks/run-gate-task.mjs '{"cmd":"dart","args":[...],"cwd":"..."}'
 *   echo '{"cmd":"dart",...}' | node scripts/hooks/run-gate-task.mjs
 *
 * Tasks with `weight > 1` (every `dart analyze`) take machine-wide slots
 * first, so many workers launched in one wave cannot each spawn an
 * analysis server at the same moment. `ST_GATE_NO_SLOTS=1` disables it.
 */
import { spawn } from 'node:child_process';
import { acquireSlots } from './lib/machine-slots.mjs';

const isWindows = process.platform === 'win32';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: isWindows && cmd === 'pnpm',
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function main() {
  const raw = process.argv[2] ?? (await readStdin());
  if (!raw) {
    process.stderr.write('run-gate-task: pass JSON task on argv or stdin\n');
    process.exit(2);
  }

  const task = JSON.parse(raw);
  if (task.kind === 'reminder') {
    process.stdout.write(`ℹ️  ${task.label}\n`);
    process.exit(0);
  }

  const cmd = task.cmd;
  const args = task.args ?? [];
  const cwd = task.cwd ?? process.cwd();
  const label = task.label ?? cmd;
  const weight = typeof task.weight === 'number' ? task.weight : 1;

  let release = () => {};
  const useSlots =
    weight > 1 && (process.env.ST_GATE_NO_SLOTS ?? '').trim() !== '1';
  if (useSlots) {
    const slots = await acquireSlots({
      repoRoot: process.env.ST_REPO_ROOT || cwd,
      weight,
    });
    release = slots.release;
    if (slots.waitedMs > 0) {
      process.stderr.write(
        `⏳ waited ${Math.round(slots.waitedMs / 1000)}s for ${weight} ` +
          `analyzer slot(s)${slots.timedOut ? ' (timed out, running)' : ''}\n`,
      );
    }
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => {
        release();
        process.exit(130);
      });
    }
  }

  process.stderr.write(`▶ ${label}\n`);
  let status;
  try {
    status = await run(cmd, args, cwd);
  } finally {
    release();
  }

  if (status !== 0) {
    process.stderr.write(`❌ ${label} (exit ${status})\n`);
    process.exit(status || 1);
  }

  process.stdout.write(`✅ ${label}\n`);
}

main().catch((err) => {
  process.stderr.write(`run-gate-task: ${err.message}\n`);
  process.exit(2);
});
