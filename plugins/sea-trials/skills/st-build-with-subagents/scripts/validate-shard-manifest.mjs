#!/usr/bin/env node
/**
 * Validate a build shard manifest (`shards.json`).
 *
 * Usage:
 *   node validate-shard-manifest.mjs path/to/shards.json
 *   cat shards.json | node validate-shard-manifest.mjs
 *
 * Exit 0 with a ✅ line when valid; exit 1 with ❌ lines otherwise.
 * Warnings (⚠️) never fail the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default `maxParallel` when omitted. */
export const DEFAULT_MAX_PARALLEL = 6;
/** Hard cap on concurrent shard workers. */
export const MAX_PARALLEL_CAP = 12;
/** Allowed `tier` values. */
export const TIERS = ['mechanical', 'code', 'reasoning'];

/**
 * Files that are shared across shards of one package and therefore
 * belong to the integrator: barrel exports, pubspec, l10n sources.
 */
const SHARED_FILE_PATTERNS = [
  /(^|\/)pubspec\.yaml$/,
  /\.arb$/,
  /(^|\/)index\.(ts|js|mjs|dart)$/,
  /(^|\/)package\.json$/,
];

/** Package layout roots we know how to split into lib/test. */
const SRC_DIRS = new Set(['lib', 'test', 'src', 'integration_test']);

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Heuristic package root for a shard path: everything before the first
 * `lib/`, `test/`, `src/` or `integration_test/` segment. A path with
 * none of those is its own root.
 *
 * @param {string} p
 * @returns {string} normalised root with trailing slash
 */
export function packageRoot(p) {
  const norm = normalize(p);
  const parts = norm.split('/').filter(Boolean);
  const idx = parts.findIndex((seg) => SRC_DIRS.has(seg));
  const rootParts = idx > 0 ? parts.slice(0, idx) : parts;
  if (rootParts.length === 0) return '';
  const last = rootParts[rootParts.length - 1];
  const isFile = idx === -1 && /\.[a-z0-9]+$/i.test(last);
  const dirParts = isFile ? rootParts.slice(0, -1) : rootParts;
  return dirParts.length ? `${dirParts.join('/')}/` : '';
}

/**
 * Barrel file name for a package root (`<root>/lib/<name>.dart`).
 *
 * @param {string} root
 */
export function barrelFor(root) {
  const name = root.split('/').filter(Boolean).pop();
  return name ? `${root}lib/${name}.dart` : null;
}

/**
 * Whether a path looks like a shared file (pubspec, arb, barrel/index).
 *
 * @param {string} p
 */
export function looksShared(p) {
  const norm = normalize(p);
  if (SHARED_FILE_PATTERNS.some((re) => re.test(norm))) return true;
  const root = packageRoot(norm);
  const barrel = barrelFor(root);
  return barrel !== null && norm === barrel;
}

function isPrefixOverlap(a, b) {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Validate a parsed manifest.
 *
 * @param {unknown} manifest
 * @returns {{ok: boolean, errors: string[], warnings: string[],
 *   maxParallel: number, shardCount: number}}
 */
export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => errors.push(msg);

  if (!manifest || typeof manifest !== 'object') {
    return {
      ok: false,
      errors: ['manifest must be a JSON object'],
      warnings,
      maxParallel: DEFAULT_MAX_PARALLEL,
      shardCount: 0,
    };
  }
  const shards = Array.isArray(manifest.shards) ? manifest.shards : [];
  if (shards.length === 0) fail('shards must be a non-empty array');

  const maxParallel = manifest.maxParallel ?? DEFAULT_MAX_PARALLEL;
  if (
    !Number.isInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > MAX_PARALLEL_CAP
  ) {
    fail(`maxParallel must be an integer between 1 and ${MAX_PARALLEL_CAP}`);
  }

  const manifestShared = manifest.sharedFiles ?? [];
  if (!Array.isArray(manifestShared)) {
    fail('sharedFiles must be an array of file paths');
  }
  const sharedAll = new Set(
    (Array.isArray(manifestShared) ? manifestShared : []).map(normalize),
  );

  const ids = new Set();
  for (const shard of shards) {
    if (!shard?.id || typeof shard.id !== 'string') {
      fail('each shard needs a string id');
      continue;
    }
    if (ids.has(shard.id)) fail(`duplicate shard id: ${shard.id}`);
    ids.add(shard.id);

    if (!Array.isArray(shard.paths) || shard.paths.length === 0) {
      fail(`shard ${shard.id} needs non-empty paths[]`);
    } else {
      for (const p of shard.paths) {
        if (typeof p !== 'string' || !p || p.includes('..')) {
          fail(`shard ${shard.id} has invalid path: ${p}`);
        }
      }
    }
    if (shard.dependsOn != null && !Array.isArray(shard.dependsOn)) {
      fail(`shard ${shard.id} dependsOn must be an array`);
    }
    if (shard.tier != null && !TIERS.includes(shard.tier)) {
      fail(`shard ${shard.id} tier must be one of ${TIERS.join('|')}`);
    }
    if (shard.sharedFiles != null) {
      if (!Array.isArray(shard.sharedFiles)) {
        fail(`shard ${shard.id} sharedFiles must be an array`);
      } else {
        for (const f of shard.sharedFiles) {
          if (typeof f !== 'string' || !f || f.includes('..')) {
            fail(`shard ${shard.id} has invalid sharedFiles entry: ${f}`);
          } else if (f.endsWith('/')) {
            fail(`shard ${shard.id} sharedFiles must be files, not dirs: ${f}`);
          } else {
            sharedAll.add(normalize(f));
          }
        }
      }
    }
  }

  for (const shard of shards) {
    for (const dep of shard?.dependsOn ?? []) {
      if (!ids.has(dep)) {
        fail(`shard ${shard.id} depends on unknown id: ${dep}`);
      }
      if (dep === shard.id) fail(`shard ${shard.id} depends on itself`);
    }
  }

  // Cycle detection over the dependsOn DAG.
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(shards.map((s) => [s?.id, s]));
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      fail(`cycle detected at shard: ${id}`);
      return;
    }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (ids.has(dep)) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  // Path-prefix overlap between shards.
  const normalized = shards
    .filter((s) => s?.id && Array.isArray(s.paths))
    .map((s) => ({
      id: s.id,
      paths: s.paths.filter((p) => typeof p === 'string').map(normalize),
      shared: new Set((s.sharedFiles ?? []).map(normalize)),
    }));
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i];
      const b = normalized[j];
      for (const pa of a.paths) {
        for (const pb of b.paths) {
          if (isPrefixOverlap(pa, pb)) {
            fail(`path overlap between ${a.id} and ${b.id}: ${pa} ~ ${pb}`);
          }
        }
      }
    }
  }

  // A shard may not own a declared shared file as one of its paths.
  for (const s of normalized) {
    for (const p of s.paths) {
      if (sharedAll.has(p)) {
        fail(
          `shard ${s.id} lists shared file ${p} in paths; ` +
            'shared files are integrator-owned',
        );
      }
    }
  }

  // Intra-package splits: two shards inside one package root will both
  // want the barrel / pubspec / arb. Those must be declared sharedFiles.
  const rootOwners = new Map();
  for (const s of normalized) {
    for (const p of s.paths) {
      const root = packageRoot(p);
      if (!root) continue;
      if (!rootOwners.has(root)) rootOwners.set(root, new Set());
      rootOwners.get(root).add(s.id);
    }
  }
  for (const [root, owners] of rootOwners) {
    if (owners.size < 2) continue;
    const declared = [...sharedAll].some((f) => f.startsWith(root));
    if (!declared) {
      const barrel = barrelFor(root);
      fail(
        `shards ${[...owners].sort().join(', ')} split package ${root} ` +
          'but declare no sharedFiles under it; add e.g. ' +
          `"sharedFiles": ["${barrel}", "${root}pubspec.yaml"] ` +
          '(integrator-owned) or merge the shards',
      );
    }
    for (const s of normalized) {
      if (!owners.has(s.id)) continue;
      for (const p of s.paths) {
        if (p.startsWith(root) && looksShared(p) && !sharedAll.has(p)) {
          fail(
            `shard ${s.id} owns shared-looking file ${p} inside a split ` +
              'package; move it to sharedFiles',
          );
        }
      }
    }
  }

  // Shared-looking files owned by a single shard are fine but worth a nod.
  for (const s of normalized) {
    for (const p of s.paths) {
      if (looksShared(p) && !sharedAll.has(p)) {
        const root = packageRoot(p);
        if ((rootOwners.get(root)?.size ?? 0) < 2) {
          warnings.push(
            `shard ${s.id} owns ${p}; fine while no other shard shares ` +
              `${root || 'its package'}`,
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    maxParallel: Number.isInteger(maxParallel)
      ? maxParallel
      : DEFAULT_MAX_PARALLEL,
    shardCount: shards.length,
  };
}

function readInput(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function main() {
  const file = process.argv[2];
  let raw;
  try {
    raw = readInput(file);
  } catch (err) {
    process.stderr.write(`❌ cannot read manifest: ${err.message}\n`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    process.stderr.write('❌ manifest is not valid JSON\n');
    process.exit(1);
  }
  const result = validateManifest(manifest);
  for (const w of result.warnings) process.stderr.write(`⚠️  ${w}\n`);
  if (!result.ok) {
    for (const e of result.errors) process.stderr.write(`❌ ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `✅ Shard manifest OK (${result.shardCount} shard(s), ` +
      `maxParallel=${result.maxParallel})\n`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) main();
