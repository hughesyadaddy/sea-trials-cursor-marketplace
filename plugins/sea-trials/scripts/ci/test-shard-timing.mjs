/**
 * Duration estimates and bin-packing for dart-test shards.
 *
 * Pure helpers except `countTestFiles`, which reads the workspace tree.
 */

import fs from 'node:fs';
import path from 'node:path';

import { effectivePassCacheSalt, PASS_CACHE_SALT } from './pass-cache.mjs';

/** Five-minute shard SLA for wall clock (seconds). */
export const MAX_SHARD_SECONDS = 300;

/** melos bootstrap before very_good test in multi-scope shards. */
export const BOOTSTRAP_RESERVE_SECONDS = 90;

/** Bin-pack budget: sequential tests only (bootstrap excluded). */
export const MAX_SHARD_TEST_SECONDS =
  MAX_SHARD_SECONDS - BOOTSTRAP_RESERVE_SECONDS;

/** @deprecated Prefer effectivePassCacheSalt() at runtime. */
export const TIMING_CACHE_SALT = PASS_CACHE_SALT;

export function timingCacheSalt() {
  return effectivePassCacheSalt();
}
export const TIMING_CACHE_FILE = '.cache/dart-test-timing.json';

/** CI cold-run baselines (very_good test -j 4, post-bootstrap). */
export const FAT_BASELINE_SECONDS = {
  'apps/client_app': 290,
  'apps/admin_app': 245,
  'packages/api_client/powersync_api_client': 240,
};

export const FAT_PACKAGE_DIRS = Object.keys(FAT_BASELINE_SECONDS);

export const SMALL_SET_LIMIT = 3;
/** Whole-workspace cold runs need headroom to avoid cap pile-up. */
export const MAX_SHARDS = 60;

/** Per-package overhead beyond test-file runtime. */
export const BASE_PACKAGE_SECONDS = 15;

/** CI cold-run floor for a sequential very_good test invocation. */
export const MIN_PACKAGE_SECONDS = 35;

/** Conservative vs observed ~33–60 s/pkg on ubuntu-latest. */
export const SECONDS_PER_TEST_FILE = 2.0;

/**
 * @returns {{salt: string, packages: Record<string, {seconds: number,
 *   samples: number, hash?: string}>}}
 */
export function emptyTimingCache() {
  return { salt: timingCacheSalt(), packages: {} };
}

/**
 * @param {string} text
 * @returns {ReturnType<typeof emptyTimingCache>}
 */
export function parseTimingCache(text) {
  if (!text || !text.trim()) return emptyTimingCache();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyTimingCache();
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    typeof parsed.packages !== 'object' ||
    parsed.packages == null
  ) {
    return emptyTimingCache();
  }
  /** @type {Record<string, {seconds: number, samples: number, hash?: string}>} */
  const packages = {};
  for (const [dir, entry] of Object.entries(parsed.packages)) {
    if (
      entry == null ||
      typeof entry !== 'object' ||
      typeof entry.seconds !== 'number' ||
      entry.seconds <= 0
    ) {
      continue;
    }
    packages[dir] = {
      seconds: entry.seconds,
      samples: typeof entry.samples === 'number' && entry.samples > 0 ? entry.samples : 1,
      ...(typeof entry.hash === 'string' && entry.hash ? { hash: entry.hash } : {}),
    };
  }
  return {
    salt: typeof parsed.salt === 'string' ? parsed.salt : '',
    packages,
  };
}

/**
 * @param {ReturnType<typeof emptyTimingCache>} cache
 * @param {string} dir
 * @param {number} seconds measured wall time
 * @param {string} [contentHash] package input hash; resets history on change
 * @returns {ReturnType<typeof emptyTimingCache>}
 */
export function recordTimingSample(cache, dir, seconds, contentHash) {
  if (!Number.isFinite(seconds) || seconds <= 0) return cache;
  const salt = timingCacheSalt();
  const prev = cache.packages[dir];
  if (
    !prev ||
    cache.salt !== salt ||
    (contentHash && prev.hash && prev.hash !== contentHash)
  ) {
    return {
      salt,
      packages: {
        ...cache.packages,
        [dir]: {
          seconds,
          samples: 1,
          ...(contentHash ? { hash: contentHash } : {}),
        },
      },
    };
  }
  const samples = prev.samples + 1;
  const merged = (prev.seconds * prev.samples + seconds) / samples;
  return {
    salt,
    packages: {
      ...cache.packages,
      [dir]: {
        seconds: merged,
        samples,
        ...(contentHash ? { hash: contentHash } : prev.hash ? { hash: prev.hash } : {}),
      },
    },
  };
}

/**
 * @param {ReturnType<typeof emptyTimingCache>} base
 * @param {Array<{packages?: Record<string, number>}>} partials
 * @returns {ReturnType<typeof emptyTimingCache>}
 */
export function mergeTimingPartials(base, partials) {
  const salt = timingCacheSalt();
  let next = base.salt === salt ? base : emptyTimingCache();
  for (const partial of partials) {
    if (!partial?.packages) continue;
    for (const [dir, value] of Object.entries(partial.packages)) {
      if (typeof value === 'number' && value > 0) {
        next = recordTimingSample(next, dir, value);
        continue;
      }
      if (
        value != null &&
        typeof value === 'object' &&
        typeof value.seconds === 'number' &&
        value.seconds > 0
      ) {
        next = recordTimingSample(next, dir, value.seconds, value.hash);
      }
    }
  }
  return next;
}

/**
 * @param {string} repoRoot monorepo root (parent of flutter/)
 * @param {string} packageDir e.g. packages/app_ui
 * @returns {number}
 */
export function countTestFiles(repoRoot, packageDir) {
  const testRoot = path.join(repoRoot, 'flutter', packageDir, 'test');
  if (!fs.existsSync(testRoot)) return 0;

  /** @type {number} */
  let count = 0;
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('_test.dart')) count += 1;
    }
  };
  walk(testRoot);
  return count;
}

/**
 * @param {string} dir package dir under flutter/
 * @param {{repoRoot?: string, timingCache?: ReturnType<
 *   typeof emptyTimingCache>, contentHash?: string}} [opts]
 * @returns {number}
 */
export function estimatePackageSeconds(dir, { repoRoot, timingCache, contentHash } = {}) {
  const entry = timingCache?.packages?.[dir];
  const cached = entry?.seconds;
  const hashMatches =
    !contentHash ||
    (entry?.hash != null && entry.hash === contentHash);
  if (
    cached &&
    cached > 0 &&
    timingCache?.salt === timingCacheSalt() &&
    hashMatches
  ) {
    return cached;
  }
  const fat = FAT_BASELINE_SECONDS[dir];
  if (fat) return fat;
  const fileCount = repoRoot ? countTestFiles(repoRoot, dir) : 0;
  const heuristic = BASE_PACKAGE_SECONDS + fileCount * SECONDS_PER_TEST_FILE;
  return Math.max(MIN_PACKAGE_SECONDS, heuristic);
}

/**
 * @param {string[][]} shards
 * @param {(dir: string) => number} estimateSeconds
 * @returns {number}
 */
export function maxShardEstimatedSeconds(shards, estimateSeconds) {
  return shards.reduce((max, shard) => {
    const total = shard.reduce((sum, dir) => sum + estimateSeconds(dir), 0);
    return Math.max(max, total);
  }, 0);
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const whole = Math.round(seconds);
  const min = Math.floor(whole / 60);
  const sec = whole % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

/**
 * Bin-pack package dirs so each shard's estimated sequential test time
 * stays under `maxShardTestSeconds` (default 210 s — 5 min SLA minus
 * bootstrap). Fat apps always get exclusive shards.
 *
 * @param {string[]} dirs
 * @param {{fatDirs?: string[], smallLimit?: number, maxShards?: number,
 *   maxShardTestSeconds?: number, repoRoot?: string,
 *   timingCache?: ReturnType<typeof emptyTimingCache>,
 *   estimateSeconds?: (dir: string) => number}} [opts]
 * @returns {{shards: string[][], hasWork: boolean, skipLog: string,
 *   estimates: Record<string, number>}}
 */
export function assignTestShards(
  dirs,
  {
    fatDirs = FAT_PACKAGE_DIRS,
    smallLimit = SMALL_SET_LIMIT,
    maxShards = MAX_SHARDS,
    maxShardTestSeconds = MAX_SHARD_TEST_SECONDS,
    repoRoot,
    timingCache,
    estimateSeconds,
  } = {},
) {
  const estimate =
    estimateSeconds ??
    ((dir) => estimatePackageSeconds(dir, { repoRoot, timingCache }));

  const unique = [...new Set(dirs)];
  if (unique.length === 0) {
    return {
      shards: [],
      hasWork: false,
      skipLog: 'nothing_to_test',
      estimates: {},
    };
  }

  const fatSet = new Set(fatDirs);
  /** @type {Record<string, number>} */
  const estimates = {};
  /** @type {{dir: string, seconds: number, isFat: boolean}[]} */
  const packages = unique.map((dir) => {
    const seconds = estimate(dir);
    estimates[dir] = seconds;
    return { dir, seconds, isFat: fatSet.has(dir) };
  });

  const fat = packages.filter((p) => p.isFat);
  const rest = packages.filter((p) => !p.isFat);
  const totalSeconds = packages.reduce((sum, p) => sum + p.seconds, 0);

  if (
    fat.length === 0 &&
    packages.length <= smallLimit &&
    totalSeconds <= maxShardTestSeconds
  ) {
    return {
      shards: [unique.sort()],
      hasWork: true,
      skipLog: '',
      estimates,
    };
  }

  /** @type {string[][]} */
  const fatShards = fat.map((p) => [p.dir]);
  /** @type {{dirs: string[], seconds: number}[]} */
  const bins = [];

  const sortedRest = [...rest].sort((a, b) => b.seconds - a.seconds);
  for (const pkg of sortedRest) {
    let best = bins.find(
      (b) => b.seconds + pkg.seconds <= maxShardTestSeconds,
    );
    if (!best && fatShards.length + bins.length < maxShards) {
      best = { dirs: [], seconds: 0 };
      bins.push(best);
    }
    if (!best) {
      best = bins.reduce(
        (min, b) => (b.seconds < min.seconds ? b : min),
        bins[0],
      );
    }
    best.dirs.push(pkg.dir);
    best.seconds += pkg.seconds;
  }

  const shards = [...fatShards, ...bins.map((b) => b.dirs.sort())];
  if (shards.length > maxShards) {
    throw new Error(
      `shard plan exceeds MAX_SHARDS (${shards.length} > ${maxShards})`,
    );
  }

  return { shards, hasWork: true, skipLog: '', estimates };
}
