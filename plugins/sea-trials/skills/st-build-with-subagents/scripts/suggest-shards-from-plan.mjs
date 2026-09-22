#!/usr/bin/env node
/**
 * Derive a `shards.json` manifest from a plan markdown file.
 *
 *   node suggest-shards-from-plan.mjs docs/plan/<plan>.md > shards.json
 *   node .../validate-shard-manifest.mjs shards.json
 *
 * Preference order:
 *   1. A fenced ```shards block (JSON: full manifest or shard array).
 *   2. A `## Parallel execution map` section with a table
 *      `| id | paths | dependsOn | tier |` (optional `sharedFiles`).
 *   3. Heuristics: package-like paths mentioned in backticks, one shard
 *      per package root, no dependencies.
 *
 * stdout is always valid manifest JSON; hints go to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default `maxParallel` for generated manifests. */
export const DEFAULT_MAX_PARALLEL = 6;

const SHARDS_FENCE = /```shards[^\n]*\n([\s\S]*?)```/;
const EXEC_MAP_HEADING = /^#{2,3}\s+parallel execution map\s*$/im;
const PACKAGE_DIRS = new Set([
  'apps',
  'packages',
  'plugins',
  'functions',
  'services',
  'libs',
  'modules',
]);

function splitList(cell) {
  const text = String(cell ?? '').trim();
  if (!text || text === '-' || text === '—' || text === 'none') return [];
  return text
    .split(/[,\s]+/)
    .map((s) => s.replace(/`/g, '').trim())
    .filter(Boolean);
}

/**
 * Parse the fenced ```shards JSON block, if present.
 *
 * @param {string} text plan markdown
 * @returns {object|null} manifest or null when absent
 */
export function parseShardsFence(text) {
  const match = text.match(SHARDS_FENCE);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`\`\`\`shards block is not valid JSON: ${err.message}`);
  }
  const shards = Array.isArray(parsed) ? parsed : parsed?.shards;
  if (!Array.isArray(shards)) {
    throw new Error('```shards block must be a manifest or shard array');
  }
  const base = Array.isArray(parsed) ? {} : parsed;
  return finalize({ ...base, shards }, 'plan-shards-block');
}

/**
 * Parse a `## Parallel execution map` markdown table, if present.
 * Columns are matched by header name; `id` and `paths` are required.
 *
 * @param {string} text plan markdown
 * @returns {object|null} manifest or null when absent
 */
export function parseExecutionMap(text) {
  const heading = text.match(EXEC_MAP_HEADING);
  if (!heading) return null;
  const after = text.slice(heading.index + heading[0].length);
  const nextHeading = after.search(/^#{1,6}\s/m);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  const rows = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  if (rows.length < 2) return null;
  const cells = (row) =>
    row
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const header = cells(rows[0]).map((h) => h.toLowerCase());
  const col = (name) => header.indexOf(name);
  const idIdx = col('id');
  const pathsIdx = col('paths');
  if (idIdx === -1 || pathsIdx === -1) {
    throw new Error('Parallel execution map table needs id and paths columns');
  }
  const depIdx = col('dependson');
  const tierIdx = col('tier');
  const sharedIdx = col('sharedfiles');
  const summaryIdx = col('summary');
  const shards = [];
  for (const row of rows.slice(1)) {
    const c = cells(row);
    if (c.every((v) => /^:?-+:?$/.test(v) || v === '')) continue;
    const id = (c[idIdx] ?? '').replace(/`/g, '').trim();
    if (!id) continue;
    const shard = {
      id,
      paths: splitList(c[pathsIdx]),
      dependsOn: depIdx === -1 ? [] : splitList(c[depIdx]),
    };
    const tier = tierIdx === -1 ? '' : (c[tierIdx] ?? '').trim();
    if (tier && tier !== '-') shard.tier = tier;
    if (sharedIdx !== -1) {
      const shared = splitList(c[sharedIdx]);
      if (shared.length) shard.sharedFiles = shared;
    }
    if (summaryIdx !== -1 && c[summaryIdx]) shard.summary = c[summaryIdx];
    shards.push(shard);
  }
  if (shards.length === 0) return null;
  return finalize({ shards }, 'plan-execution-map');
}

/**
 * Reduce a path mention to a package root. `<x>/(apps|packages|…)/<n>/…`
 * collapses to `<x>/(apps|packages|…)/<n>/`; otherwise keep the first
 * two directory segments. Bare files and single segments are dropped.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function packageRootOf(raw) {
  const clean = raw.replace(/[`*()<>"',;:]/g, '').replace(/\\/g, '/');
  if (!clean.includes('/') || clean.startsWith('http')) return null;
  const parts = clean.split('/').filter(Boolean);
  const hasExt = (seg) => /\.[a-z0-9]+$/i.test(seg);
  const dirs = hasExt(parts[parts.length - 1]) ? parts.slice(0, -1) : parts;
  if (dirs.length < 2) return null;
  const idx = dirs.findIndex((seg) => PACKAGE_DIRS.has(seg));
  if (idx !== -1 && dirs.length > idx + 1) {
    return `${dirs.slice(0, idx + 2).join('/')}/`;
  }
  return `${dirs.slice(0, 2).join('/')}/`;
}

/**
 * Heuristic shards: one per package root mentioned in the plan.
 *
 * @param {string} text plan markdown
 * @returns {object} manifest (may have zero shards)
 */
export function heuristicShards(text) {
  const roots = new Set();
  for (const match of text.matchAll(/`([^`\n]*\/[^`\n]*)`/g)) {
    const root = packageRootOf(match[1]);
    if (root) roots.add(root);
  }
  for (const match of text.matchAll(
    /\bflutter\/(?:apps|packages)\/[a-z0-9_./-]+/gi,
  )) {
    const root = packageRootOf(match[0]);
    if (root) roots.add(root);
  }
  const sorted = [...roots]
    .filter((r) => !r.startsWith('docs/'))
    .sort();
  const kept = sorted.filter(
    (r) => !sorted.some((o) => o !== r && r.startsWith(o)),
  );
  const used = new Set();
  const shards = kept.map((p, i) => {
    let id = shardIdFor(p, i);
    let n = 2;
    while (used.has(id)) id = `${shardIdFor(p, i)}-${n++}`;
    used.add(id);
    return { id, paths: [p], dependsOn: [] };
  });
  return finalize({ shards }, 'heuristic');
}

function shardIdFor(p, i) {
  const name = p
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase();
  return name ? name : `shard-${i + 1}`;
}

/**
 * Fill defaults and stamp the provenance.
 *
 * @param {object} manifest
 * @param {string} source
 */
export function finalize(manifest, source) {
  const shards = (manifest.shards ?? []).map((s) => ({
    ...s,
    dependsOn: s.dependsOn ?? [],
  }));
  const maxParallel =
    manifest.maxParallel ??
    Math.max(1, Math.min(DEFAULT_MAX_PARALLEL, shards.length));
  const out = { ...manifest, shards, maxParallel, source };
  return out;
}

/**
 * Suggest a manifest from plan text using the preference order above.
 *
 * @param {string} text
 * @returns {object}
 */
export function suggestManifest(text) {
  return (
    parseShardsFence(text) ?? parseExecutionMap(text) ?? heuristicShards(text)
  );
}

function main() {
  const planPath = process.argv[2];
  if (!planPath) {
    process.stderr.write('Usage: suggest-shards-from-plan.mjs <plan.md>\n');
    process.exit(2);
  }
  const text = fs.readFileSync(planPath, 'utf8');
  const manifest = suggestManifest(text);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  const hint =
    manifest.source === 'heuristic'
      ? 'heuristic shards — review paths/dependsOn/sharedFiles, then run ' +
        'validate-shard-manifest.mjs'
      : `shards from ${manifest.source} — run validate-shard-manifest.mjs`;
  process.stderr.write(
    `[suggest-shards-from-plan] ${manifest.shards.length} shard(s); ${hint}\n`,
  );
  if (manifest.shards.length === 0) process.exit(3);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`suggest-shards-from-plan: ${err.message}\n`);
    process.exit(1);
  }
}
