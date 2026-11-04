#!/usr/bin/env node
/**
 * Fast validation for agent sessions — changed Dart files only.
 *
 * Use during /build, /hotfix, and iteration. Full-package gates stay on
 * prepush (format, analyze, custom lint) and CI (tests).
 *
 * Built to stay light on the machine, because many agents (shard
 * fan-outs, iteration loops) run it at once on one laptop:
 *   - ONE merged `dart analyze --fatal-infos` per flutter root, taking
 *     the whole budget — so a dirty tree spawns a single analysis server
 *     instead of one per file.
 *   - A machine-wide single-flight lock serialises concurrent runs; a
 *     waiter whose change set the holder just validated coalesces onto
 *     that verdict instead of re-running.
 *   - `machine-slots` caps analysers across every process; macOS runs
 *     every spawn at background QoS (`taskpolicy -b`).
 * Correctness is unchanged: the same `--fatal-infos` diagnostics and the
 * same `flutter test` failures still fail the run.
 *
 * Usage:
 *   node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs
 *   node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs flutter/packages/foo/lib/a.dart
 *   node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs --analyze-only
 *   node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs --tests-only
 *
 * Explicit paths may be repo-relative (flutter/...) or absolute — including
 * git worktrees outside the current checkout.
 *
 * Env:
 *   ST_AGENT_VALIDATE_BUDGET             weighted concurrency cap (default 4)
 *   ST_AGENT_VALIDATE_ANALYZE_TIMEOUT_MS analyze timeout    (default 180000)
 *   ST_AGENT_VALIDATE_TEST_TIMEOUT_MS    test timeout       (default 300000)
 *   ST_AGENT_VALIDATE_LOCK=0             disable the single-flight lock
 *   ST_AGENT_VALIDATE_LOCK_WAIT_MS       lock wait cap      (default 30 min)
 *   ST_GATE_NO_SLOTS=1                   disable machine-wide analyzer slots
 *   ST_GATE_BACKGROUND_QOS=0             disable macOS background QoS
 *   ST_GATE_FAIL_FAST=0                  run every phase, report all failures
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  failFastDefault,
  runAsync,
  runParallelLimited,
} from './lib/parallel.mjs';
import { findNearestPubspecYaml, getFlutterWorkspaceMembers } from './lib/flutter-packages.mjs';
import { assertL10nGenerated } from './lib/check-l10n-generated.mjs';
import { isLintableDartPath } from './lib/artifact-paths.mjs';
import { acquireSlots } from './lib/machine-slots.mjs';
import {
  buildAgentValidatePlan,
  groupTasksByRepoRoot,
} from './lib/agent-validate-plan.mjs';
import {
  acquireLock,
  canCoalesce,
  computeFingerprint,
  LOCK_TIMEOUT_EXIT,
  lockWaitMs,
  readLastResult,
  singleFlightEnabled,
  writeLastResult,
} from './lib/single-flight.mjs';
import { stateDir } from '../lib/st-state-dir.mjs';

const isWindows = process.platform === 'win32';

const repoRoot = (() => {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (top.status === 0) return (top.stdout ?? '').trim();
  return process.cwd();
})();

const flutterRoot = path.join(repoRoot, 'flutter');

function capture(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

function parseArgs(argv) {
  const flags = new Set();
  const paths = [];
  for (const arg of argv) {
    if (arg === '--analyze-only') flags.add('analyze-only');
    else if (arg === '--tests-only') flags.add('tests-only');
    else if (arg === '--help' || arg === '-h') flags.add('help');
    else if (arg === '--') continue;
    else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      process.exit(2);
    } else {
      paths.push(arg);
    }
  }
  return { flags, paths };
}

function gitChangedDartPaths() {
  const unstaged =
    capture('git', ['diff', '--name-only', '--diff-filter=ACMR']) ?? '';
  const staged =
    capture('git', ['diff', '--name-only', '--cached', '--diff-filter=ACMR']) ??
    '';
  const untracked =
    capture('git', ['ls-files', '--others', '--exclude-standard']) ?? '';

  const merged = new Set(
    [...unstaged.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => isLintableDartPath(p)),
  );
  return [...merged];
}

/**
 * Resolve a Dart file under flutter/ in any git checkout (main or worktree).
 *
 * @returns {{ repoRoot: string, repoRel: string, flutterRoot: string } | null}
 */
function resolveFlutterDartFile(inputPath) {
  const abs = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.normalize(path.join(repoRoot, inputPath));

  if (!abs.endsWith('.dart') || !fs.existsSync(abs)) {
    return null;
  }

  const gitRoot = capture('git', [
    '-C',
    path.dirname(abs),
    'rev-parse',
    '--show-toplevel',
  ]);
  if (!gitRoot) {
    return null;
  }

  const repoRel = path.relative(gitRoot, abs).replace(/\\/g, '/');
  if (!isLintableDartPath(repoRel)) {
    return null;
  }

  return {
    repoRoot: gitRoot,
    repoRel,
    flutterRoot: path.join(gitRoot, 'flutter'),
  };
}

function packageRelFromResolved(resolved) {
  const abs = path.join(resolved.repoRoot, resolved.repoRel);
  const pubspecPath = findNearestPubspecYaml(abs);
  if (!pubspecPath) return null;
  const pkgDirAbs = path.dirname(pubspecPath);
  const pkgDirRel = path
    .relative(resolved.flutterRoot, pkgDirAbs)
    .replace(/\\/g, '/');
  return pkgDirRel === '' ? '.' : pkgDirRel;
}

function pathRelToPackage(repoRel, pkgRel) {
  const prefix = pkgRel === '.' ? 'flutter/' : `flutter/${pkgRel}/`;
  if (!repoRel.startsWith(prefix)) return null;
  return repoRel.slice(prefix.length);
}

function packageGroupKey(resolved, pkgRel) {
  return `${resolved.flutterRoot}::${pkgRel}`;
}

/** @type {Set<string>} */
const firstPartyNonWorkspacePackages = new Set([
  '.',
  'packages/test_utils',
]);

function isAgentValidatablePackage(pkgRel, workspaceMembers) {
  return (
    workspaceMembers.has(pkgRel) ||
    firstPartyNonWorkspacePackages.has(pkgRel)
  );
}

function groupByPackage(resolvedFiles) {
  /** @type {Map<string, { resolved: { repoRoot: string, flutterRoot: string }, pkgRel: string, lib: string[], test: string[], pubspecChanged: boolean }>} */
  const groups = new Map();
  /** @type {Map<string, Set<string>>} */
  const workspaceMembersByFlutterRoot = new Map();

  for (const resolved of resolvedFiles) {
    const pkgRel = packageRelFromResolved(resolved);
    if (!pkgRel) continue;

    let workspaceMembers = workspaceMembersByFlutterRoot.get(
      resolved.flutterRoot,
    );
    if (!workspaceMembers) {
      workspaceMembers = getFlutterWorkspaceMembers(resolved.flutterRoot);
      workspaceMembersByFlutterRoot.set(
        resolved.flutterRoot,
        workspaceMembers,
      );
    }
    // Only declared workspace members are ours to validate, plus a
    // small set of first-party packages outside the workspace list.
    if (!isAgentValidatablePackage(pkgRel, workspaceMembers)) continue;

    const key = packageGroupKey(resolved, pkgRel);
    if (!groups.has(key)) {
      groups.set(key, {
        resolved,
        pkgRel,
        lib: [],
        test: [],
        pubspecChanged: false,
      });
    }
    const entry = groups.get(key);

    const inPkg = pathRelToPackage(resolved.repoRel, pkgRel);
    if (!inPkg) continue;

    if (inPkg.startsWith('test/')) {
      // Only runnable test files: shared fixtures/helpers under
      // test/ (e.g. test/helpers/mock_*.dart) have no main() and
      // make `flutter test` fail if passed directly.
      if (inPkg.endsWith('_test.dart')) entry.test.push(inPkg);
    } else if (
      inPkg.startsWith('lib/') ||
      inPkg.startsWith('scripts/') ||
      inPkg.startsWith('bin/') ||
      inPkg.startsWith('tool/')
    ) {
      entry.lib.push(inPkg);
    }
  }

  return groups;
}

function resolveExplicitPaths(explicitPaths) {
  /** @type {{ repoRoot: string, repoRel: string, flutterRoot: string }[]} */
  const resolved = [];
  const rejected = [];

  for (const inputPath of explicitPaths) {
    const file = resolveFlutterDartFile(inputPath);
    if (file) {
      resolved.push(file);
    } else {
      rejected.push(inputPath);
    }
  }

  if (rejected.length > 0) {
    process.stderr.write(
      `⚠️  Skipped ${rejected.length} path(s) — not flutter/*.dart ` +
        `in a git checkout:\n`,
    );
    for (const p of rejected) {
      process.stderr.write(`   ${p}\n`);
    }
  }

  return resolved;
}

function printHelp() {
  process.stdout.write(`\
Fast agent validation (changed Dart files only).

  node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs
  node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs flutter/packages/foo/lib/a.dart
  node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs --analyze-only
  node $ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs --tests-only

Absolute paths from git worktrees are supported.

Runs in phases (pub get → analyze → test). Analyze is ONE merged
\`dart analyze --fatal-infos\` per flutter root, and a machine-wide lock
serialises concurrent runs so parallel agents queue instead of each
spawning an analysis server. Set ST_AGENT_VALIDATE_LOCK=0 to opt out,
ST_AGENT_VALIDATE_BUDGET to change the concurrency cap (default 4).

Full gates: prepush hook + CI. Do not run whole-package MCP test during
iteration unless the user explicitly asks before merge.
`);
}

/**
 * Resolve the current change set and group it by package.
 *
 * Re-runnable: called once up front and again after the single-flight
 * lock is acquired (files may have changed while a waiter blocked).
 *
 * @param {string[]} explicitPaths
 * @returns {{ resolvedFiles: { repoRoot: string, repoRel: string,
 *   flutterRoot: string }[], groups: Map<string, object> }}
 */
function collectChangeSet(explicitPaths) {
  /** @type {{ repoRoot: string, repoRel: string, flutterRoot: string }[]} */
  let resolvedFiles = [];

  if (explicitPaths.length > 0) {
    resolvedFiles = resolveExplicitPaths(explicitPaths);
  } else {
    const repoPaths = gitChangedDartPaths();
    resolvedFiles = repoPaths.map((repoRel) => ({
      repoRoot,
      repoRel,
      flutterRoot,
    }));

    // Include pubspec.yaml changes that sit beside changed dart files.
    for (const repoRel of repoPaths) {
      const pkgRel = packageRelFromResolved({ repoRoot, repoRel, flutterRoot });
      if (!pkgRel) continue;
      const pubspecRepoPath =
        pkgRel === '.'
          ? 'flutter/pubspec.yaml'
          : `flutter/${pkgRel}/pubspec.yaml`;
      if (!fs.existsSync(path.join(repoRoot, pubspecRepoPath))) continue;
      const pubspecChanged =
        capture('git', ['diff', '--name-only', pubspecRepoPath]) ||
        capture('git', ['diff', '--name-only', '--cached', pubspecRepoPath]) ||
        capture('git', [
          'ls-files',
          '--others',
          '--exclude-standard',
          pubspecRepoPath,
        ]);
      if (pubspecChanged) {
        resolvedFiles.push({ repoRoot, repoRel: pubspecRepoPath, flutterRoot });
      }
    }
  }

  resolvedFiles = [
    ...new Map(
      resolvedFiles.map((file) => [
        path.join(file.repoRoot, file.repoRel),
        file,
      ]),
    ).values(),
  ];

  return { resolvedFiles, groups: groupByPackage(resolvedFiles) };
}

/**
 * Flatten the `groupByPackage` map into the plan builder's input shape:
 * analyze paths made flutter-root-relative, tests left package-relative
 * (their cwd is the package), and the per-package pubspec-changed flag.
 *
 * @param {Map<string, { resolved: { repoRoot: string, flutterRoot: string },
 *   pkgRel: string, lib: string[], test: string[] }>} groups
 */
function normalizeGroups(groups) {
  const out = [];
  for (const [, { resolved, pkgRel, lib, test }] of groups) {
    const pkgCwd =
      pkgRel === '.'
        ? resolved.flutterRoot
        : path.join(resolved.flutterRoot, pkgRel);
    const libFlutterRel = lib.map((p) =>
      pkgRel === '.' ? p : `${pkgRel}/${p}`,
    );
    const pubspecRepoPath =
      pkgRel === '.'
        ? 'flutter/pubspec.yaml'
        : `flutter/${pkgRel}/pubspec.yaml`;
    // Pubspec-change detection is git-based, so it only applies to the
    // main checkout; explicit worktree groups skip `pub get`.
    const pubspecChanged =
      resolved.repoRoot === repoRoot &&
      Boolean(
        capture('git', ['diff', '--name-only', pubspecRepoPath]) ||
          capture('git', [
            'diff',
            '--name-only',
            '--cached',
            pubspecRepoPath,
          ]) ||
          capture('git', [
            'ls-files',
            '--others',
            '--exclude-standard',
            pubspecRepoPath,
          ]),
      );
    out.push({
      flutterRoot: resolved.flutterRoot,
      repoRoot: resolved.repoRoot,
      pkgRel,
      pkgCwd,
      lib: libFlutterRel,
      test,
      pubspecChanged,
    });
  }
  return out;
}

/**
 * Wrap `runAsync` so every spawn first takes machine-wide analyzer slots
 * keyed by its owning repo — the same key `run-gate-task` uses, so
 * prepush / run-gate-task / agent-validate all contend for one slot dir.
 * The weight and repo travel in `options` because `runParallelLimited`'s
 * runner seam only forwards `(cmd, args, options)`.
 *
 * @param {{ budget: number, env: NodeJS.ProcessEnv, activeReleases: Set<Function> }} opts
 */
function makeSlotRunner({ budget, env, activeReleases }) {
  const noSlots = (env.ST_GATE_NO_SLOTS ?? '').trim() === '1';
  return async function slotRunner(cmd, args, options = {}) {
    const weight = options.slotWeight ?? 1;
    const slotRepoRoot = options.slotRepoRoot;
    if (noSlots || !slotRepoRoot) {
      return runAsync(cmd, args, options);
    }
    const slots = await acquireSlots({ repoRoot: slotRepoRoot, weight, budget });
    activeReleases.add(slots.release);
    try {
      return await runAsync(cmd, args, options);
    } finally {
      slots.release();
      activeReleases.delete(slots.release);
    }
  };
}

/**
 * Run the plan phase by phase, each awaited before the next. On fail-fast
 * (the default) a failing phase short-circuits the rest; with
 * ST_GATE_FAIL_FAST=0 every phase runs and all failures are reported.
 *
 * @returns {Promise<{ failed: boolean }>}
 */
async function runPhases(plan, { failFast, env, activeReleases }) {
  const runner = makeSlotRunner({ budget: plan.budget, env, activeReleases });
  let failed = false;
  for (const phase of plan.phases) {
    if (phase.tasks.length === 0) continue;
    // Partition by owning repo so each task's gate-cache key is computed
    // against its own git root (worktree / explicit-path tasks have a cwd
    // under a different root than the main checkout).
    for (const [taskRepoRoot, tasks] of groupTasksByRepoRoot(phase.tasks)) {
      const { failures } = await runParallelLimited(tasks, plan.budget, {
        failFast,
        repoRoot: taskRepoRoot || repoRoot,
        runner,
      });
      if (failures.length > 0) {
        failed = true;
        // Fail-fast stops not just the rest of this phase but every later
        // phase too.
        if (failFast) return { failed };
      }
    }
  }
  return { failed };
}

/** Absolute paths of every file in the change set, for fingerprinting. */
function changeSetFiles(resolvedFiles) {
  return resolvedFiles.map((f) => path.join(f.repoRoot, f.repoRel));
}

/**
 * Fingerprint inputs for the current change set. Analyze/test verdicts
 * depend on files OUTSIDE the listed set (imports, a moved HEAD, an edit
 * to a non-listed file when explicit paths are passed), so for every repo
 * the change set touches we fold in that repo's HEAD and every dirty file
 * (unstaged + staged + untracked, all file types; deleted files hash as
 * 'missing' via the content reader).
 *
 * @param {{ repoRoot: string, repoRel: string }[]} resolvedFiles
 * @returns {{ files: string[], heads: string[] }}
 */
function collectFingerprintInputs(resolvedFiles) {
  const repoRoots = [
    ...new Set(resolvedFiles.map((f) => f.repoRoot)),
  ].sort();
  const heads = [];
  const dirty = new Set();
  for (const root of repoRoots) {
    const head = capture('git', ['-C', root, 'rev-parse', 'HEAD']) ?? '';
    heads.push(`${root}=${head}`);
    const listings = [
      capture('git', ['-C', root, 'diff', '--name-only']) ?? '',
      capture('git', ['-C', root, 'diff', '--name-only', '--cached']) ?? '',
      capture('git', [
        '-C',
        root,
        'ls-files',
        '--others',
        '--exclude-standard',
      ]) ?? '',
    ];
    for (const out of listings) {
      for (const rel of out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)) {
        dirty.add(path.join(root, rel));
      }
    }
  }
  const files = [...new Set([...changeSetFiles(resolvedFiles), ...dirty])];
  return { files, heads };
}

async function main() {
  const { flags, paths: explicitPaths } = parseArgs(process.argv.slice(2));

  if (flags.has('help')) {
    printHelp();
    process.exit(0);
  }

  const analyzeOnly = flags.has('analyze-only');
  const testsOnly = flags.has('tests-only');
  const planFlags = { analyzeOnly, testsOnly };
  /** Flags that change the verdict, so they belong in the fingerprint. */
  const fingerprintFlags = [
    ...(analyzeOnly ? ['analyze-only'] : []),
    ...(testsOnly ? ['tests-only'] : []),
  ];

  // ---- cheap collection + l10n + early exits (all before the lock) ---
  const initial = collectChangeSet(explicitPaths);
  if (explicitPaths.length > 0 && initial.resolvedFiles.length === 0) {
    process.stderr.write(
      '❌ No valid flutter/*.dart paths in explicit file list.\n',
    );
    process.exit(2);
  }
  if (initial.resolvedFiles.length === 0) {
    process.stdout.write('✅ No changed Flutter Dart files to validate.\n');
    process.exit(0);
  }
  if (initial.groups.size === 0) {
    process.stdout.write('✅ No analyzable Flutter packages in changed set.\n');
    process.exit(0);
  }
  if (!testsOnly) {
    const repoRoots = [
      ...new Set(
        [...initial.groups.values()].map(({ resolved }) => resolved.repoRoot),
      ),
    ];
    for (const root of repoRoots) {
      const l10n = assertL10nGenerated(root);
      if (!l10n.ok) {
        process.stderr.write(`❌ ${l10n.message}\n`);
        process.exit(2);
      }
    }
  }

  // ---- machine-wide single-flight lock + coalescing ------------------
  const locksDir = stateDir('locks');
  const lockPath = path.join(locksDir, 'agent-validate.lock');
  const lastPath = path.join(locksDir, 'agent-validate-last.json');
  const env = process.env;

  /** @type {Set<Function>} */
  const activeReleases = new Set();
  let releaseLock = () => {};
  const cleanup = () => {
    for (const release of activeReleases) release();
    activeReleases.clear();
    releaseLock();
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        cleanup();
        process.exit(130);
      });
    } catch {
      // Windows may not support every signal.
    }
  }

  let current = initial;
  if (singleFlightEnabled(env)) {
    const lock = await acquireLock({
      lockPath,
      cwd: process.cwd(),
      waitMs: lockWaitMs(env),
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    if (!lock.acquired) {
      process.stderr.write(
        `❌ Timed out after ${Math.round(lockWaitMs(env) / 60000)} min ` +
          'waiting for another agent-validate to finish. Not running ' +
          'unlocked — retry, or ST_AGENT_VALIDATE_LOCK=0 to bypass.\n',
      );
      process.exit(LOCK_TIMEOUT_EXIT);
    }
    releaseLock = lock.release;

    if (lock.waited) {
      // Files may have changed while we blocked: re-collect so both the
      // coalesce check and the run reflect the current tree.
      current = collectChangeSet(explicitPaths);
      if (current.resolvedFiles.length === 0 || current.groups.size === 0) {
        process.stdout.write(
          '✅ No changed Flutter Dart files to validate (change set ' +
            'cleared while waiting).\n',
        );
        releaseLock();
        process.exit(0);
      }
      const fpInputs = collectFingerprintInputs(current.resolvedFiles);
      const fingerprint = computeFingerprint({
        files: fpInputs.files,
        heads: fpInputs.heads,
        flags: fingerprintFlags,
      });
      const last = readLastResult(lastPath);
      if (canCoalesce(last, { fingerprint, waitStartedAt: lock.waitStartedAt })) {
        process.stdout.write(
          `♻️  coalesced: identical change set just validated by pid ` +
            `${last.pid ?? '?'} — ${last.ok ? 'passed' : 'FAILED'}.\n`,
        );
        releaseLock();
        process.exit(last.ok ? 0 : 1);
      }
    }
  }

  const fpInputs = collectFingerprintInputs(current.resolvedFiles);
  const fingerprint = computeFingerprint({
    files: fpInputs.files,
    heads: fpInputs.heads,
    flags: fingerprintFlags,
  });

  process.stdout.write(
    `🔎 Agent validate (${current.resolvedFiles.length} file(s), ` +
      `${current.groups.size} package(s))...\n`,
  );

  const plan = buildAgentValidatePlan({
    groups: normalizeGroups(current.groups),
    flags: planFlags,
    env,
  });

  const hasWork = plan.phases.some((phase) => phase.tasks.length > 0);
  if (!hasWork) {
    process.stdout.write(
      '✅ Nothing to run (lib-only change with no test files — analyze ' +
        'skipped with --tests-only, or no lib with --analyze-only).\n',
    );
    writeLastResult(lastPath, {
      fingerprint,
      ok: true,
      finishedAt: Date.now(),
      pid: process.pid,
      summary: 'nothing to run',
    });
    releaseLock();
    process.exit(0);
  }

  const failFast = failFastDefault(env);
  const { failed } = await runPhases(plan, { failFast, env, activeReleases });

  const summary = failed
    ? 'agent validation failed'
    : 'agent validation passed';
  writeLastResult(lastPath, {
    fingerprint,
    ok: !failed,
    finishedAt: Date.now(),
    pid: process.pid,
    summary,
  });

  if (failed) {
    process.stderr.write(
      '\n❌ Agent validation failed. Fix issues above.\n' +
        'Full gates still run on push via prepush + CI.\n',
    );
    releaseLock();
    process.exit(1);
  }

  process.stdout.write(
    '✅ Agent validation passed (changed files only).\n' +
      'Run full package tests locally before merge if you changed shared code.\n',
  );
  releaseLock();
}

main().catch((err) => {
  process.stderr.write(`Agent validate error: ${err.message}\n`);
  process.exit(2);
});
