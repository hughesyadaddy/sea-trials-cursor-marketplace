#!/usr/bin/env node
/**
 * Run one push-gate task from JSON (subagent fan-out contract).
 *
 *   node scripts/hooks/run-gate-task.mjs '{"cmd":"dart","args":[...],"cwd":"..."}'
 *   echo '{"cmd":"dart",...}' | node scripts/hooks/run-gate-task.mjs
 *   node scripts/hooks/run-gate-task.mjs --no-cache '<json>'
 *
 * Tasks with `weight > 1` (every `dart analyze`) take machine-wide slots
 * first, so many workers launched in one wave cannot each spawn an
 * analysis server at the same moment. `ST_GATE_NO_SLOTS=1` disables it.
 *
 * format / lint / analyze tasks are looked up in the content-hash gate
 * cache first (lib/gate-cache.mjs; `ST_GATE_CACHE=0` or `--no-cache`
 * disables) and recorded on success. Every run lands in the telemetry
 * ledger (lib/gate-telemetry.mjs; `ST_GATE_TELEMETRY=0` disables).
 */
import { spawn } from 'node:child_process';
import {
  cacheKeyForTask,
  describeSkip,
  findRepoRoot,
  isCacheableTask,
  lookup,
  record,
} from './lib/gate-cache.mjs';
import { recordRun } from './lib/gate-telemetry.mjs';
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
  const argv = process.argv.slice(2);
  const noCache = argv.includes('--no-cache');
  const raw =
    argv.find((arg) => !arg.startsWith('--')) ?? (await readStdin());
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
  const repoRoot = process.env.ST_REPO_ROOT || findRepoRoot(cwd) || cwd;
  const startedAt = Date.now();

  const tell = (fields) => {
    recordRun({
      kind: 'gate',
      task: label,
      phase: task.phase,
      taskKind: task.kind,
      weight,
      pr: task.pr,
      repoRoot,
      taskJson: task,
      ...fields,
    });
  };

  let cacheKey = null;
  if (!noCache && isCacheableTask(task)) {
    try {
      cacheKey = cacheKeyForTask({ ...task, cwd }, { repoRoot });
    } catch {
      cacheKey = null;
    }
    if (cacheKey && lookup(cacheKey).hit) {
      process.stdout.write(`${describeSkip(task)}\n`);
      tell({ ms: 0, ok: true, cacheHit: true, exitCode: 0 });
      process.exit(0);
    }
  }

  let release = () => {};
  const useSlots =
    weight > 1 && (process.env.ST_GATE_NO_SLOTS ?? '').trim() !== '1';
  if (useSlots) {
    const slots = await acquireSlots({
      repoRoot,
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
        tell({ ms: Date.now() - startedAt, ok: false, killed: true });
        process.exit(130);
      });
    }
  }

  process.stderr.write(`▶ ${label}\n`);
  const runStartedAt = Date.now();
  let status;
  try {
    status = await run(cmd, args, cwd);
  } finally {
    release();
  }
  const ms = Date.now() - runStartedAt;

  if (status !== 0) {
    tell({ ms, ok: false, exitCode: status });
    process.stderr.write(`❌ ${label} (exit ${status})\n`);
    process.exit(status || 1);
  }

  // Success only — a red verdict is never remembered.
  if (cacheKey) record(cacheKey, { kind: task.kind, label, ms });
  tell({ ms, ok: true, exitCode: 0 });
  process.stdout.write(`✅ ${label}\n`);
}

main().catch((err) => {
  process.stderr.write(`run-gate-task: ${err.message}\n`);
  process.exit(2);
});
