/**
 * dart-test-shard job: scoped file runs or full-package lane (escape hatch).
 *
 * PR matrix rows from the plugin always carry `test_paths_map` (per-package
 * planned files). Multi-package bins iterate packages — no whole-package
 * fallback when a map is present.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRepoRoot } from '../hooks/lib/plugin-paths.mjs';
import { parseTestPathsMap } from './pr-scoped-test-plan.mjs';

/**
 * @param {string[]} argv
 * @returns {{
 *   base: string,
 *   packages: string,
 *   testPaths?: string,
 *   testPathsMap?: string,
 * }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | undefined>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (
      arg === '--base' ||
      arg === '--packages' ||
      arg === '--test-paths' ||
      arg === '--test-paths-map'
    ) {
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      if (arg === '--base') out.base = val;
      if (arg === '--packages') out.packages = val;
      if (arg === '--test-paths') out.testPaths = val;
      if (arg === '--test-paths-map') out.testPathsMap = val;
      i += 1;
    }
  }
  if (!out.base || !out.packages) {
    throw new Error(
      'usage: dart-test-run-shard.mjs --base <ref> --packages <csv> ' +
        '[--test-paths <paths>] [--test-paths-map <json>]',
    );
  }
  return {
    base: out.base,
    packages: out.packages,
    testPaths: out.testPaths,
    testPathsMap: out.testPathsMap,
  };
}

/**
 * @param {string} packageDir
 * @param {string[]} inPkgTestPaths
 * @param {string} repoRoot
 * @returns {number}
 */
export function runVeryGoodScopedTests(packageDir, inPkgTestPaths, repoRoot) {
  if (inPkgTestPaths.length === 0) {
    throw new Error(`no test paths for ${packageDir}`);
  }
  const flutterPkg = path.join(repoRoot, 'flutter', packageDir);
  const result = spawnSync(
    'very_good',
    ['test', '-j', '4', '-x', 'presubmit-only', ...inPkgTestPaths],
    { cwd: flutterPkg, stdio: 'inherit', env: process.env },
  );
  return result.status ?? 1;
}

/**
 * @param {{
 *   base: string,
 *   packages: string,
 *   testPaths?: string,
 *   testPathsMap?: string,
 *   repoRoot?: string,
 * }} opts
 * @returns {number}
 */
export function runTestShard(opts) {
  const repoRoot = opts.repoRoot ?? resolveRepoRoot();
  const pkgs = opts.packages
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const map = opts.testPathsMap
    ? parseTestPathsMap(opts.testPathsMap)
    : null;

  if (map) {
    let exitCode = 0;
    const mapPkgs = Object.keys(map).sort();
    for (const pkg of pkgs) {
      if (!map[pkg]) {
        throw new Error(
          `test_paths_map missing package ${pkg} (refusing whole-package run)`,
        );
      }
    }
    for (const extra of mapPkgs) {
      if (!pkgs.includes(extra)) {
        throw new Error(`test_paths_map has unexpected package ${extra}`);
      }
    }
    for (const pkg of pkgs) {
      const files = map[pkg].split(/\s+/).filter(Boolean);
      const code = runVeryGoodScopedTests(pkg, files, repoRoot);
      if (code !== 0) exitCode = code;
    }
    return exitCode;
  }

  const trimmedPaths = opts.testPaths?.trim();
  if (trimmedPaths) {
    if (pkgs.length !== 1) {
      throw new Error(
        'file-level --test-paths require a single package or --test-paths-map',
      );
    }
    const files = trimmedPaths.split(/\s+/).filter(Boolean);
    return runVeryGoodScopedTests(pkgs[0], files, repoRoot);
  }

  if (pkgs.length > 1) {
    throw new Error(
      'multi-package shard requires --test-paths-map (refusing whole-package run)',
    );
  }

  const pluginScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'run-lane.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [
      pluginScript,
      '--lane',
      'test',
      '--base',
      opts.base,
      '--packages',
      opts.packages,
    ],
    { cwd: repoRoot, stdio: 'inherit', env: process.env },
  );
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    process.exit(runTestShard(opts));
  } catch (err) {
    process.stderr.write(`dart-test-run-shard: ${err.message}\n`);
    process.exit(2);
  }
}