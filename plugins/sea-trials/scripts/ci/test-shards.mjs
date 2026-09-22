/**
 * dart-test shard planner and aggregator truth table.
 *
 * Pure: no git, no Flutter. CI calls `--plan` after it has a candidate
 * set; the aggregator calls `--aggregate` with job results.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { resolveRepoRoot } from '../hooks/lib/plugin-paths.mjs';
import {
  directDepDirs,
  emptyPassCache,
  hasPassed,
  packageInputHash,
  parseGitLsFilesS,
  parsePassCache,
  recordPassed,
} from './pass-cache.mjs';
import {
  BOOTSTRAP_RESERVE_SECONDS,
  MAX_SHARD_SECONDS,
  MAX_SHARD_TEST_SECONDS,
  TIMING_CACHE_FILE,
  FAT_PACKAGE_DIRS,
  assignTestShards,
  emptyTimingCache,
  estimatePackageSeconds,
  formatDuration,
  maxShardEstimatedSeconds,
  mergeTimingPartials,
  parseTimingCache,
} from './test-shard-timing.mjs';

export {
  FAT_PACKAGE_DIRS,
  MAX_SHARD_SECONDS,
  MAX_SHARD_TEST_SECONDS,
  MAX_SHARDS,
  SMALL_SET_LIMIT,
  assignTestShards,
} from './test-shard-timing.mjs';

/**
 * @param {string[]} dirs
 * @param {(dir: string) => boolean} hasTestDir
 * @returns {string[]}
 */
export function filterPackagesWithTests(dirs, hasTestDir) {
  return dirs.filter((dir) => hasTestDir(dir));
}

/**
 * @param {string[][]} shards
 * @param {{nameByDir?: Map<string, string>}} [opts]
 * @returns {{include: {shard: string, packages: string, scopes: string}[]}}
 */
export function githubMatrix(shards, { nameByDir } = {}) {
  if (shards.length === 0) return { include: [] };
  return {
    include: shards.map((packages, i) => ({
      shard: String(i),
      packages: packages.join(','),
      scopes: packages.map((dir) => nameByDir?.get(dir) ?? dir.split('/').pop()).join(','),
    })),
  };
}

/**
 * @param {string[]} dirs
 * @param {{hashes: Record<string, string>, cache: object}} opts
 * @returns {{toRun: string[], skipped: string[]}}
 */
export function splitCached(dirs, { hashes, cache }) {
  const toRun = [];
  const skipped = [];
  for (const dir of dirs) {
    const hash = hashes[dir];
    if (hash && hasPassed(cache, dir, hash)) skipped.push(dir);
    else toRun.push(dir);
  }
  return { toRun, skipped };
}

/**
 * @param {{
 *   candidateDirs: string[],
 *   hasTestDir: (dir: string) => boolean,
 *   hashes: Record<string, string>,
 *   cache: object,
 * }} opts
 */
export function planTestShards({
  candidateDirs,
  hasTestDir,
  hashes,
  cache,
  nameByDir,
  repoRoot,
  timingCache,
}) {
  const withTests = filterPackagesWithTests(candidateDirs, hasTestDir);
  if (withTests.length === 0) {
    return {
      hasWork: false,
      skipLog: 'nothing_to_test',
      matrix: githubMatrix([]),
      toRun: [],
      skipped: [],
      shards: [],
    };
  }

  const { toRun, skipped } = splitCached(withTests, { hashes, cache });
  if (toRun.length === 0) {
    return {
      hasWork: false,
      skipLog: 'all_cached',
      matrix: githubMatrix([]),
      toRun: [],
      skipped,
      shards: [],
    };
  }

  const { shards, estimates } = assignTestShards(toRun, {
    repoRoot,
    timingCache,
    estimateSeconds: (dir) =>
      estimatePackageSeconds(dir, {
        repoRoot,
        timingCache,
        contentHash: hashes[dir],
      }),
  });
  return {
    hasWork: true,
    skipLog: '',
    matrix: githubMatrix(shards, { nameByDir }),
    toRun,
    skipped,
    shards,
    estimates,
  };
}

/**
 * Hash each package from `git ls-files -s` output (flutter/ prefixed).
 *
 * @param {{
 *   lsFilesS: string,
 *   packageDirs: string[],
 *   graph: object,
 * }} opts
 * @returns {Record<string, string>}
 */
export function hashPackagesFromLsFiles({ lsFilesS, packageDirs, graph }) {
  const entries = parseGitLsFilesS(lsFilesS)
    .filter((e) => e.path.startsWith('flutter/'))
    .map((e) => ({ ...e, path: e.path.slice('flutter/'.length) }));
  const lockfileBlob = entries.find((e) => e.path === 'pubspec.lock')?.blob ?? '';
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const dir of packageDirs) {
    hashes[dir] = packageInputHash({
      packageDir: dir,
      depDirs: directDepDirs(graph, dir),
      entries,
      lockfileBlob,
    });
  }
  return hashes;
}

/**
 * Next pass-cache JSON: previous sentinels plus this run's candidates.
 * Saved only after shards succeed.
 *
 * @param {{
 *   cache: object,
 *   packageDirs: string[],
 *   hashes: Record<string, string>,
 * }} opts
 */
export function nextPassCache({ cache, packageDirs, hashes }) {
  let next = {
    salt: cache.salt,
    passed: { ...cache.passed },
  };
  for (const dir of packageDirs) {
    if (hashes[dir]) next = recordPassed(next, dir, hashes[dir]);
  }
  return next;
}

/**
 * Fail-closed aggregator for the required `dart-test` check.
 *
 * @param {{plan: string, shards: string, hasWork: boolean|string}} opts
 * @returns {{ok: boolean, reason: string}}
 */
export function aggregateDartTestResult({ plan, shards, hasWork }) {
  const work =
    hasWork === true || hasWork === 'true'
      ? true
      : hasWork === false || hasWork === 'false'
        ? false
        : null;

  if (plan === 'cancelled' || shards === 'cancelled') {
    return { ok: false, reason: 'cancelled' };
  }
  if (plan !== 'success') {
    return { ok: false, reason: 'plan' };
  }
  if (work === null) {
    return { ok: false, reason: 'has_work' };
  }
  if (work) {
    if (shards === 'skipped') return { ok: false, reason: 'matrix' };
    if (shards !== 'success') return { ok: false, reason: 'shards' };
    return { ok: true, reason: 'ran' };
  }
  if (shards === 'success') return { ok: false, reason: 'claimed-skip' };
  if (shards === 'skipped') return { ok: true, reason: 'skipped' };
  return { ok: false, reason: 'shards' };
}

/**
 * @param {string[]} argv
 * @returns {{plan: string, shards: string, hasWork: string}}
 */
export function parseAggregateArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan' || arg === '--shards' || arg === '--has-work' || arg === '--aggregate') {
      if (arg === '--aggregate') continue;
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      out[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument '${arg}'`);
    }
  }
  if (!out.plan || !out.shards || out['has-work'] === undefined) {
    throw new Error('--plan, --shards, and --has-work are required');
  }
  return { plan: out.plan, shards: out.shards, hasWork: out['has-work'] };
}

export const PASS_CACHE_FILE = '.cache/dart-test-pass.json';
export const PASS_CACHE_NEXT_FILE = '.cache/dart-test-pass-next.json';

export { TIMING_CACHE_FILE } from './test-shard-timing.mjs';

/**
 * stdout ceiling for the git calls the lanes make.
 *
 * Node defaults `spawnSync` to 1 MiB. `git ls-files -s` over this
 * monorepo crossed that in August 2026 (~8.9k files, ~1.02 MiB) and
 * every lane that hashes packages started dying on the merge ref with
 * an empty stderr. The list grows monotonically, so the ceiling is set
 * far above the next few years of it rather than just past today.
 */
export const GIT_STDOUT_MAX_BUFFER = 64 * 1024 * 1024;

/* c8 ignore start -- CLI wrapper; exported logic above is tested. */
function gitStdout(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_STDOUT_MAX_BUFFER,
  });
  // See `defaultGit` in run-lane.mjs: an ENOBUFS overflow can leave
  // `status` at 0 with stdout truncated, which hashes packages from a
  // partial file list instead of failing.
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout ?? '';
}

async function emitPlan({ base, repoRoot }) {
  const { collectTestLaneContext } = await import('./run-lane.mjs');
  const { changedFiles, workspaceLevel, graph, testPackageDirs } = collectTestLaneContext({
    base,
    repoRoot,
  });

  const cachePath = path.join(repoRoot, PASS_CACHE_FILE);
  const cache = fs.existsSync(cachePath)
    ? parsePassCache(fs.readFileSync(cachePath, 'utf8'))
    : emptyPassCache();

  const timingPath = path.join(repoRoot, TIMING_CACHE_FILE);
  const timingCache = fs.existsSync(timingPath)
    ? parseTimingCache(fs.readFileSync(timingPath, 'utf8'))
    : emptyTimingCache();

  const hasTestDir = (dir) => fs.existsSync(path.join(repoRoot, 'flutter', dir, 'test'));

  const withTests = filterPackagesWithTests(testPackageDirs, hasTestDir);
  const lsFilesS = gitStdout(['ls-files', '-s', '--', 'flutter']);
  const hashes = hashPackagesFromLsFiles({
    lsFilesS,
    packageDirs: withTests,
    graph,
  });
  const planned = planTestShards({
    candidateDirs: withTests,
    hasTestDir: () => true,
    hashes,
    cache,
    nameByDir: graph.nameByDir,
    repoRoot,
    timingCache,
  });
  const next = nextPassCache({
    cache,
    packageDirs: withTests,
    hashes,
  });

  process.stdout.write(
    `dart-test-plan: ${changedFiles.length} changed file(s) vs ${base}; ` +
      `${withTests.length} package(s) with tests; ` +
      `${planned.toRun.length} to run, ${planned.skipped.length} cached` +
      (planned.skipLog ? ` (${planned.skipLog})` : '') +
      '\n',
  );
  if (workspaceLevel) {
    process.stdout.write('dart-test-plan: workspace-level diff; sample, not proof.\n');
  }
  const estimates = planned.estimates ?? {};
  const estimateFn = (dir) =>
    estimates[dir] ??
    estimatePackageSeconds(dir, {
      repoRoot,
      timingCache,
      contentHash: hashes[dir],
    });
  const maxSeconds = maxShardEstimatedSeconds(planned.shards, estimateFn);
  const smallShards = planned.shards.filter(
    (shard) => !shard.some((dir) => FAT_PACKAGE_DIRS.includes(dir)),
  );
  const maxSmallSeconds = maxShardEstimatedSeconds(smallShards, estimateFn);
  const maxWall = maxSeconds + BOOTSTRAP_RESERVE_SECONDS;
  process.stdout.write(
    `dart-test-plan: ${planned.shards.length} shard(s); ` +
      `max test est ${formatDuration(maxSeconds)} + ` +
      `${BOOTSTRAP_RESERVE_SECONDS}s bootstrap\n`,
  );
  if (maxSmallSeconds > MAX_SHARD_TEST_SECONDS) {
    process.stdout.write(
      'dart-test-plan: warning — a shard exceeds the test-time budget; ' +
        'raise MAX_SHARDS or refresh timing cache\n',
    );
  }
  if (maxWall > MAX_SHARD_SECONDS) {
    process.stdout.write(
      'dart-test-plan: warning — a shard may exceed the 5-minute wall SLA\n',
    );
  }
  for (const [i, shard] of planned.shards.entries()) {
    const shardSeconds = shard.reduce((sum, dir) => sum + estimateFn(dir), 0);
    process.stdout.write(
      `  shard ${i} (${formatDuration(shardSeconds)} est): ${shard.join(', ')}\n`,
    );
  }
  for (const dir of planned.skipped) {
    process.stdout.write(`  skip (hash hit): ${dir}\n`);
  }

  fs.mkdirSync(path.join(repoRoot, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, PASS_CACHE_NEXT_FILE), `${JSON.stringify(next, null, 2)}\n`);

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(
      outputFile,
      `has_work=${planned.hasWork}\nmatrix=${JSON.stringify(planned.matrix)}\n`,
    );
  }
}

function mergeTimingFromDir(dir, repoRoot) {
  const timingPath = path.join(repoRoot, TIMING_CACHE_FILE);
  const base = fs.existsSync(timingPath)
    ? parseTimingCache(fs.readFileSync(timingPath, 'utf8'))
    : emptyTimingCache();

  /** @type {Array<{packages?: Record<string, number>}>} */
  const partials = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      try {
        partials.push(JSON.parse(text));
      } catch {
        process.stderr.write(`test-shards: skip invalid timing ${name}\n`);
      }
    }
  }

  const merged = mergeTimingPartials(base, partials);
  fs.mkdirSync(path.dirname(timingPath), { recursive: true });
  fs.writeFileSync(timingPath, `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(
    `dart-test-timing: merged ${partials.length} partial(s); ` +
      `${Object.keys(merged.packages).length} package(s) tracked\n`,
  );
}

function main(argv) {
  const mergeIdx = argv.indexOf('--merge-timing');
  if (mergeIdx >= 0) {
    const dirIdx = argv.indexOf('--dir');
    const dir = argv[dirIdx + 1];
    if (!dir || dir.startsWith('--')) {
      throw new Error('--merge-timing requires --dir');
    }
    mergeTimingFromDir(path.resolve(dir), resolveRepoRoot());
    return;
  }
  if (argv.includes('--aggregate')) {
    const parsed = parseAggregateArgs(argv);
    const result = aggregateDartTestResult(parsed);
    process.stdout.write(`${result.reason}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (argv.includes('--emit-plan')) {
    const baseIdx = argv.indexOf('--base');
    const base = argv[baseIdx + 1];
    if (!base || base.startsWith('--')) {
      throw new Error('--emit-plan requires --base');
    }
    return emitPlan({ base, repoRoot: resolveRepoRoot() });
  }
  throw new Error('usage: test-shards.mjs --emit-plan --base <ref> | --aggregate …');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`test-shards: ${err.message}\n`);
    process.exitCode = 2;
  }
}
/* c8 ignore stop */
