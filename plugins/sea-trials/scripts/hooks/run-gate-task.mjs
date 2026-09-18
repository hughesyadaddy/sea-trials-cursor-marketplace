#!/usr/bin/env node
/**
 * Run one push-gate task from JSON (subagent fan-out contract).
 *
 *   node scripts/hooks/run-gate-task.mjs '{"cmd":"dart","args":[...],"cwd":"..."}'
 *   echo '{"cmd":"dart",...}' | node scripts/hooks/run-gate-task.mjs
 */
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
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

  process.stderr.write(`▶ ${label}\n`);
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: isWindows && cmd === 'pnpm',
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.stderr.write(`❌ ${label} (exit ${result.status ?? 1})\n`);
    process.exit(result.status ?? 1);
  }

  process.stdout.write(`✅ ${label}\n`);
}

main().catch((err) => {
  process.stderr.write(`run-gate-task: ${err.message}\n`);
  process.exit(2);
});
