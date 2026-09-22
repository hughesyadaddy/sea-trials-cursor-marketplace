/**
 * Whole-tree dart analyze for Main Guardrails — merged chunks, not
 * one analysis-server cold start per package (88 spawns ≈ 346s in CI).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildMergedAnalyzeChunks,
  getDartAnalyzeTargetsForPackage,
} from '../hooks/lib/flutter-packages.mjs';
import { runAsync, runParallelLimited } from '../hooks/lib/parallel.mjs';

/**
 * Fewer, fatter chunks than the PR lanes — this is the whole tree, so
 * there is no changed-file scope to keep them small.
 *
 * Measured against the workspace: 88 packages expand to 171 Dart
 * subdir targets, which this budget packs into 5 chunks (3 waves at
 * weight 2 on a 4-vCPU runner) with at most 40 targets per analysis
 * server. Raising it to 300 saves one wave but doubles the peak
 * per-server context load, which is the OOM surface on a 4-vCPU box.
 */
export const GUARDRAILS_ANALYZE_CHUNK_SIZE = 200;

/** Same as run-lane.mjs — two analyzers on a 4-vCPU runner. */
export const GUARDRAILS_ANALYZE_WEIGHT = 2;

/**
 * Analysis servers to keep in flight, set explicitly rather than
 * derived from `os.cpus()`.
 *
 * The private-repo runner reports 2 vCPUs, so the usual
 * `budget = max(os.cpus().length, 2)` against `weight = 2` admitted
 * exactly one task and the chunks ran strictly sequentially — measured
 * at 124s + 48s + 32s + 40s + 11s = 255s of wall time on run
 * 33027001586, with no overlap at all. An analysis server spends much
 * of its startup reading and parsing files, so two of them still
 * overlap usefully on two cores.
 */
export const GUARDRAILS_ANALYZE_CONCURRENCY = 2;

export const AUDIT_FAILURE_LOG = '/tmp/audit_failures.txt';

/**
 * Node child_process.spawn does not always inherit Flutter's PATH on
 * GitHub Actions; FLUTTER_ROOT/bin/dart is set after flutter-action.
 *
 * @returns {string}
 */
export function resolveDartExecutable() {
  const flutterRoot = process.env.FLUTTER_ROOT?.trim();
  if (flutterRoot) {
    const dart = path.join(flutterRoot, 'bin', 'dart');
    if (fs.existsSync(dart)) {
      return dart;
    }
  }
  return 'dart';
}

/**
 * @param {string[]} args
 * @returns {string[]}
 */
function gitLines(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every Dart subdir of a package — lib, test, tool, bin,
 * integration_test — not just `lib/`.
 *
 * The audit is the whole-tree backstop, so narrowing to `lib/` (which
 * the PR lanes do) would silently stop auditing every `test/` and
 * `tool/` file in the workspace. Naming the subdirs explicitly still
 * avoids handing the analysis server a bare package root.
 *
 * @param {string} flutterRoot
 * @param {string} pkgDir
 * @returns {string[]}
 */
export function guardrailsAnalyzeTargets(flutterRoot, pkgDir) {
  return getDartAnalyzeTargetsForPackage(flutterRoot, pkgDir);
}

/**
 * Strip the Dart subdir back to the owning package dir, so the audit
 * report names `packages/foo`, not `packages/foo/test`.
 *
 * @param {string} target
 * @returns {string}
 */
export function packageDirOfTarget(target) {
  return target.replace(
    /\/(lib|test|tool|bin|integration_test)$/,
    '',
  );
}

/**
 * Round-robin slice of `items` for a 1-based shard.
 *
 * Round-robin, not contiguous blocks: the package list is alphabetical,
 * so contiguous blocks would put every `apps/` package in one shard and
 * leave that shard the long pole for the whole audit.
 *
 * @template T
 * @param {T[]} items
 * @param {number} shard 1-based
 * @param {number} shardTotal
 * @returns {T[]}
 */
export function shardSlice(items, shard, shardTotal) {
  if (!Number.isInteger(shard) || !Number.isInteger(shardTotal)) {
    throw new Error('shard and shardTotal must be integers');
  }
  if (shardTotal < 1 || shard < 1 || shard > shardTotal) {
    throw new Error(
      `invalid shard ${shard}/${shardTotal}: expected 1..${shardTotal}`,
    );
  }
  return items.filter((_, i) => i % shardTotal === shard - 1);
}

/**
 * Absolute path to the Flutter workspace root, verified.
 *
 * The audit step already runs with `working-directory: flutter`, so the
 * default is the process cwd. Getting this wrong is not a loud failure:
 * `spawn` reports ENOENT for a nonexistent **cwd** (which reads as a
 * missing `dart`), and every `existsSync` subdir probe silently misses,
 * collapsing 171 analyze targets down to 88 bare package roots.
 *
 * @param {string} [flutterCwd]
 * @returns {string}
 */
export function resolveFlutterRoot(flutterCwd = '.') {
  const root = path.resolve(flutterCwd);
  if (!fs.existsSync(path.join(root, 'pubspec.yaml'))) {
    throw new Error(
      `${root} is not the Flutter workspace root (no pubspec.yaml). ` +
        'Run this from flutter/ or pass --flutter-root.',
    );
  }
  return root;
}

/**
 * @param {string} [flutterCwd]
 * @returns {string[]}
 */
export function listGuardrailsPackageDirs(flutterCwd = '.') {
  return gitLines([
    'ls-files',
    '--',
    ':(glob)apps/**/pubspec.yaml',
    ':(glob)packages/**/pubspec.yaml',
  ]).map((pubspec) => pubspec.replace(/\/pubspec\.yaml$/, ''));
}

/**
 * @param {{ flutterCwd?: string, chunkSize?: number,
 *   analyzeWeight?: number, failureLog?: string, shard?: number,
 *   shardTotal?: number, packageDirsOverride?: string[] }} [opts]
 * @returns {Promise<{ packageCount: number, chunkCount: number }>}
 */
export async function runGuardrailsAnalyzePackages({
  flutterCwd = '.',
  chunkSize = GUARDRAILS_ANALYZE_CHUNK_SIZE,
  analyzeWeight = GUARDRAILS_ANALYZE_WEIGHT,
  failureLog = AUDIT_FAILURE_LOG,
  shard = 1,
  shardTotal = 1,
  packageDirsOverride,
} = {}) {
  const flutterRoot = resolveFlutterRoot(flutterCwd);
  const allPkgDirs =
    packageDirsOverride ?? listGuardrailsPackageDirs(flutterCwd);
  if (allPkgDirs.length === 0) {
    throw new Error('No Flutter workspace packages found to analyze.');
  }
  const pkgDirs = shardSlice(allPkgDirs, shard, shardTotal);
  if (pkgDirs.length === 0) {
    process.stderr.write(
      `guardrails-analyze: shard ${shard}/${shardTotal}; ` +
        'no packages in this shard\n',
    );
    return { packageCount: 0, chunkCount: 0 };
  }

  const analyzePaths = pkgDirs.flatMap((dir) =>
    guardrailsAnalyzeTargets(flutterRoot, dir),
  );

  if (analyzePaths.length === 0) {
    return { packageCount: 0, chunkCount: 0 };
  }

  // A silent collapse to bare package roots is the failure mode this
  // guards: it still analyzes something, so it reports green while
  // having stopped auditing test/ and tool/ across the workspace.
  // PR-scoped --packages overrides may legitimately have one lib/ target
  // per package; the whole-tree invariant does not apply there.
  if (
    !packageDirsOverride
    && analyzePaths.length <= pkgDirs.length
  ) {
    throw new Error(
      `Expected more analyze targets than packages (got ` +
        `${analyzePaths.length} for ${pkgDirs.length} packages); ` +
        `subdir probing under ${flutterRoot} resolved nothing.`,
    );
  }
  const chunks = buildMergedAnalyzeChunks({
    dirPaths: analyzePaths,
    chunkSize,
  });

  const dartCmd = resolveDartExecutable();
  const tasks = chunks.map((chunk, i) => ({
    label:
      `dart analyze --fatal-infos (chunk ${i + 1}/${chunks.length}: ` +
      `${chunk.dirCount} target(s))`,
    paths: chunk.paths,
    weight: analyzeWeight,
    cmd: dartCmd,
    args: ['analyze', '--fatal-infos', ...chunk.paths],
    options: { cwd: flutterRoot },
  }));

  const budget = analyzeWeight * GUARDRAILS_ANALYZE_CONCURRENCY;
  process.stderr.write(
    `guardrails-analyze: shard ${shard}/${shardTotal}; ` +
      `${pkgDirs.length}/${allPkgDirs.length} packages, ` +
      `${analyzePaths.length} targets → ${chunks.length} chunk(s); ` +
      `weight=${analyzeWeight} budget=${budget} ` +
      `(${GUARDRAILS_ANALYZE_CONCURRENCY} concurrent, ` +
      `os.cpus=${os.cpus().length})\n`,
  );

  const { failures } = await runParallelLimited(tasks, budget);

  if (failures.length === 0) {
    return { packageCount: pkgDirs.length, chunkCount: chunks.length };
  }

  for (const failure of failures) {
    const task = tasks.find((t) => t.label === failure.label);
    if (!task) continue;
    await recordChunkFailures({
      paths: task.paths,
      flutterRoot,
      failureLog,
    });
  }

  process.exitCode = 1;
  return { packageCount: pkgDirs.length, chunkCount: chunks.length };
}

/**
 * Pin exact failing targets when a merged chunk fails.
 *
 * @param {{ paths: string[], flutterRoot: string, failureLog: string }} opts
 */
async function recordChunkFailures({ paths, flutterRoot, failureLog }) {
  const dartCmd = resolveDartExecutable();
  for (const target of paths) {
    const result = await runAsync(
      dartCmd,
      ['analyze', '--fatal-infos', target],
      { cwd: flutterRoot },
    );
    if (result.code !== 0) {
      fs.appendFileSync(failureLog, `${packageDirOfTarget(target)}\n`);
    }
  }
}

/**
 * @param {string[]} argv
 * @returns {{ shard: number, shardTotal: number, packageDirs?: string[] }}
 */
export function parseShardArgs(argv) {
  const read = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const shard = Number(read('--shard') ?? 1);
  const shardTotal = Number(read('--shard-total') ?? 1);
  if (!Number.isInteger(shard) || !Number.isInteger(shardTotal)) {
    throw new Error(
      `--shard/--shard-total must be integers (got ${shard}/${shardTotal})`,
    );
  }
  const packagesRaw = read('--packages');
  const packageDirs = packagesRaw
    ? packagesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  return { shard, shardTotal, packageDirs };
}

/* c8 ignore start */
if (process.argv[1]?.endsWith('guardrails-analyze-packages.mjs')) {
  const { shard, shardTotal, packageDirs } = parseShardArgs(
    process.argv.slice(2),
  );
  runGuardrailsAnalyzePackages({
    shard,
    shardTotal,
    packageDirsOverride: packageDirs,
  }).catch((err) => {
    process.stderr.write(`guardrails-analyze-packages: ${err.message}\n`);
    process.exit(2);
  });
}
/* c8 ignore stop */
