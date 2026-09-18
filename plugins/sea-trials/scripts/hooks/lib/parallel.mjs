import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
export async function runParallelLimited(
  tasks,
  budget = Math.max(os.cpus().length, 2),
) {
  const results = [];
  const executing = new Set();
  let inFlight = 0;
  let doneCount = 0;

  for (const task of tasks) {
    // A single over-budget task must still run (alone).
    const weight = Math.min(task.weight ?? 1, budget);

    while (inFlight + weight > budget && executing.size > 0) {
      await Promise.race(executing);
    }

    inFlight += weight;
    // Emit start so a long `dart analyze` never looks like a hung
    // `dart format --check` that already finished above it.
    process.stderr.write(
      `▶  …/${tasks.length} ${task.label}\n`,
    );
    const p = (async () => {
      const result = await runAsync(task.cmd, task.args, {
        ...task.options,
        timeoutMs: task.timeoutMs,
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
        process.stderr.write(
          `${r.code === 0 ? '✅' : '❌'} [${doneCount}/${tasks.length}] ${r.label}\n`,
        );
        return r;
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
  // only dumps failure output.
  for (const { label, code, stdout, stderr } of settled) {
    if (code !== 0) {
      failures.push({ label, code, stdout, stderr });
      process.stderr.write(`\n❌ ${label} (exit ${code})\n`);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
  }

  return { failures, results: settled };
}
