import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as gateCache from './gate-cache.mjs';
import * as gateTelemetry from './gate-telemetry.mjs';
import { ensureFlutterFormatReady } from './formatter-config.mjs';

const isWindows = process.platform === 'win32';

function scoopFlutterBinDir() {
  return path.join(
    process.env.USERPROFILE ?? '',
    'scoop',
    'apps',
    'flutter',
    'current',
    'bin',
  );
}

function resolveDartExecutable() {
  if (!isWindows) return 'dart';

  const scoopDartExe = path.join(
    scoopFlutterBinDir(),
    'cache',
    'dart-sdk',
    'bin',
    'dart.exe',
  );
  if (existsSync(scoopDartExe)) return scoopDartExe;

  return 'dart';
}

function resolveFlutterExecutable() {
  if (!isWindows) return 'flutter';

  const scoopFlutterBat = path.join(scoopFlutterBinDir(), 'flutter.bat');
  if (existsSync(scoopFlutterBat)) return scoopFlutterBat;

  return 'flutter';
}

function resolvePnpmScript() {
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'pnpm',
      'bin',
      'pnpm.cjs',
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * On Windows, `shell: true` mangles staged paths like `(home)` and
 * spawning `pnpm.cmd` without a shell throws EINVAL. Invoke pnpm via
 * node + pnpm.cjs with argv instead.
 */
function resolveSpawn(cmd, args) {
  if (isWindows && cmd === 'dart') {
    return { cmd: resolveDartExecutable(), args, shell: false };
  }

  // `flutter` on Windows is flutter.bat; spawning the bare name with
  // shell:false throws ENOENT/EINVAL. Resolve to the .bat and run it
  // through the shell (batch files require it) with args that are
  // repo paths only (no user-controlled input). Quote the resolved
  // path — shell:true concatenates, so an unquoted USERPROFILE with
  // spaces would split the command.
  if (isWindows && cmd === 'flutter') {
    const bat = resolveFlutterExecutable();
    const quote = (s) => (s.includes(' ') ? `"${s}"` : s);
    // shell:true concatenates cmd + args — quote both so a checkout
    // or profile path containing spaces cannot split tokens.
    return { cmd: quote(bat), args: args.map(quote), shell: true };
  }

  if (!isWindows || cmd !== 'pnpm') {
    return { cmd, args, shell: false };
  }

  const pnpmScript = resolvePnpmScript();
  if (!pnpmScript) {
    return { cmd, args, shell: true };
  }

  return {
    cmd: process.execPath,
    args: [pnpmScript, ...args],
    shell: false,
  };
}

/**
 * Drop a spawned child to below-normal OS priority so heavy gate
 * runs (dozens of dart analyze servers) never starve the user's
 * foreground work. Children inherit the priority class on Windows,
 * so the analysis server spawned by dart.exe is covered too.
 * Best-effort: the child may already have exited.
 */
function lowerPriority(child) {
  try {
    if (child.pid) os.setPriority(child.pid, 10);
  } catch {
    // Process already gone or priority not permitted — ignore.
  }
}

/**
 * Kill a spawned process and its descendants. Needed because
 * `dart analyze` launches an analysis_server child that otherwise
 * survives a kill of the parent and keeps locking analyzer state.
 */
function killProcessTree(pid) {
  if (!pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return;
  }
  try {
    const kids = spawnSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
    });
    if (kids.status === 0) {
      for (const line of (kids.stdout ?? '').split('\n')) {
        const childPid = Number(line.trim());
        if (Number.isFinite(childPid) && childPid > 0) {
          killProcessTree(childPid);
        }
      }
    }
  } catch {
    // pgrep unavailable — fall through to parent kill
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export function runAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const { cmd: executable, args: spawnArgs, shell } = resolveSpawn(cmd, args);
    const child = spawn(executable, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell ?? shell,
      cwd: options.cwd,
      env: options.env,
    });
    lowerPriority(child);
    if (typeof options.onSpawn === 'function') options.onSpawn(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = options.timeoutMs;
    let timer;
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
      }, timeoutMs);
    }

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({
          code: 124,
          stdout,
          stderr:
            stderr +
            `\n⏱ timed out after ${timeoutMs}ms — killed analysis ` +
            'server (often a competing IDE `dart analyze` or a stuck ' +
            'full-package analyze). Retry after closing other analyzers.\n',
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Weighted concurrency limiter. `budget` approximates available
 * cores; each task consumes `task.weight` (default 1) of it while
 * running. Heavy tasks — `dart analyze` spawns a multi-threaded
 * analysis server using several cores and 0.5–2 GB RAM — must
 * declare a weight > 1 so a 20-core machine runs ~5 analyzers
 * concurrently instead of 20 (which saturates CPU AND memory and
 * freezes the desktop; observed 2026-07-08 with a 722-file diff).
 */
/**
 * Fail-fast is the default: the gate exists to answer "may I push?",
 * and the first red answer is final. Killing the remaining analyzers
 * the moment one task fails saves minutes on every failed attempt
 * (the fixer re-runs anyway). `ST_GATE_FAIL_FAST=0` restores
 * report-everything mode for humans who want the full list.
 */
export function failFastDefault(env = process.env) {
  const raw = (env.ST_GATE_FAIL_FAST ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

/**
 * Cache + telemetry seams. Tasks that carry a check-plan `kind`
 * (`format` / `lint` / `analyze`) are looked up in the content-hash
 * cache before spawning and recorded on success; every task — cache
 * hits and fail-fast kills included — lands in the telemetry ledger.
 *
 * @param {Array<{ label: string, cmd: string, args: string[],
 *   weight?: number, timeoutMs?: number, options?: object,
 *   kind?: string, phase?: string }>} tasks
 * @param {number} [budget]
 * @param {{
 *   failFast?: boolean,
 *   repoRoot?: string,
 *   noCache?: boolean,
 *   cache?: typeof gateCache | null,
 *   telemetry?: { recordRun: typeof gateTelemetry.recordRun } | null,
 *   runner?: typeof runAsync,
 * }} [opts]
 */
export async function runParallelLimited(
  tasks,
  budget = Math.max(os.cpus().length, 2),
  opts = {},
) {
  const failFast = opts.failFast ?? failFastDefault();
  const cache =
    opts.noCache || opts.cache === null ? null : (opts.cache ?? gateCache);
  const telemetry =
    opts.telemetry === null ? null : (opts.telemetry ?? gateTelemetry);
  const runner = opts.runner ?? runAsync;
  const repoRoot = opts.repoRoot;
  const repo = gateTelemetry.repoBasename(repoRoot);
  if (tasks.some((task) => task.kind === 'format')) {
    const root =
      repoRoot ??
      gateCache.findRepoRoot(
        path.resolve(tasks[0]?.options?.cwd ?? process.cwd()),
      );
    if (root) {
      ensureFlutterFormatReady({ repoRoot: root });
    }
  }
  const results = [];
  const executing = new Set();
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  let inFlight = 0;
  let doneCount = 0;
  let aborted = false;
  let skipped = 0;
  let cacheHits = 0;

  const abortRemaining = () => {
    if (aborted) return;
    aborted = true;
    for (const child of children) {
      if (child.pid && child.exitCode === null) killProcessTree(child.pid);
    }
  };

  const tell = (task, r) => {
    if (!telemetry) return;
    try {
      telemetry.recordRun({
        kind: 'gate',
        task: task.label,
        phase: task.phase,
        taskKind: task.kind,
        ms: r.durationMs,
        ok: r.code === 0,
        cacheHit: r.cacheHit === true,
        killed: r.killed === true,
        exitCode: r.code,
        weight: task.weight,
        files: Array.isArray(task.files) ? task.files.length : undefined,
        repo,
        repoRoot: repoRoot ?? task.options?.cwd,
        taskJson: task,
      });
    } catch {
      // telemetry never fails a gate
    }
  };

  const cacheKeyFor = (task) => {
    if (!cache || !cache.isCacheableTask(task)) return null;
    try {
      return cache.cacheKeyForTask(task, { repoRoot });
    } catch {
      return null;
    }
  };

  for (const task of tasks) {
    if (aborted) {
      skipped += 1;
      continue;
    }

    // Content-hash cache: an identical input set already verified
    // green (any branch, any worktree) is not re-run. Checked before
    // the budget wait so a hit never queues behind a live analyzer.
    const cacheKey = cacheKeyFor(task);
    if (cacheKey && cache.lookup(cacheKey).hit) {
      doneCount += 1;
      cacheHits += 1;
      process.stderr.write(
        `${cache.describeSkip(task)} [${doneCount}/${tasks.length}]\n`,
      );
      const hit = {
        label: task.label,
        code: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        killed: false,
        cacheHit: true,
        skipped: 'cache',
      };
      tell(task, hit);
      results.push(Promise.resolve(hit));
      continue;
    }

    // A single over-budget task must still run (alone).
    const weight = Math.min(task.weight ?? 1, budget);

    while (inFlight + weight > budget && executing.size > 0) {
      await Promise.race(executing);
    }
    if (aborted) {
      skipped += 1;
      continue;
    }

    inFlight += weight;
    // Emit start so a long `dart analyze` never looks like a hung
    // `dart format --check` that already finished above it.
    process.stderr.write(
      `▶  …/${tasks.length} ${task.label}\n`,
    );
    const p = (async () => {
      const result = await runner(task.cmd, task.args, {
        ...task.options,
        timeoutMs: task.timeoutMs,
        onSpawn: (child) => {
          children.add(child);
          child.on('close', () => children.delete(child));
        },
      });
      return { label: task.label, ...result };
    })();

    const wrapped = p.then(
      (r) => {
        executing.delete(wrapped);
        inFlight -= weight;
        // Incremental progress: long gates (dozens of analyze tasks)
        // previously produced ZERO output until every task settled,
        // which is indistinguishable from a hang.
        doneCount += 1;
        const killed = aborted && r.code !== 0;
        process.stderr.write(
          `${r.code === 0 ? '✅' : killed ? '⏹' : '❌'} ` +
            `[${doneCount}/${tasks.length}] ${r.label}\n`,
        );
        if (r.code !== 0 && failFast) abortRemaining();
        const settledResult = { ...r, killed };
        // Success only — a red verdict is never remembered.
        if (r.code === 0 && cacheKey && cache) {
          cache.record(cacheKey, {
            kind: task.kind,
            label: task.label,
            ms: r.durationMs,
          });
        }
        tell(task, settledResult);
        return settledResult;
      },
      (err) => {
        executing.delete(wrapped);
        inFlight -= weight;
        doneCount += 1;
        throw err;
      },
    );

    executing.add(wrapped);
    results.push(wrapped);
  }

  const settled = await Promise.all(results);
  const failures = [];

  // Per-task status already streamed incrementally above; this pass
  // only dumps failure output. Tasks killed by fail-fast are not
  // failures of their own — their output is noise from a SIGTERM.
  for (const { label, code, stdout, stderr, killed } of settled) {
    if (code !== 0 && !killed) {
      failures.push({ label, code, stdout, stderr });
      process.stderr.write(`\n❌ ${label} (exit ${code})\n`);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
  }

  if (aborted) {
    const killedCount = settled.filter((r) => r.killed).length;
    process.stderr.write(
      `⏹ fail-fast: stopped ${killedCount} running and skipped ${skipped} ` +
        'queued task(s) after the first failure ' +
        '(ST_GATE_FAIL_FAST=0 to run everything)\n',
    );
  }

  return { failures, results: settled, aborted, skipped, cacheHits };
}
