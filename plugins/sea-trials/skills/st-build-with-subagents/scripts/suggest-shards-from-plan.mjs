#!/usr/bin/env node
/**
 * Heuristic shard hints from a plan markdown file (stdout only — not authoritative).
 *
 * Usage: node suggest-shards-from-plan.mjs path/to/plan.md
 */
import fs from 'node:fs';

const planPath = process.argv[2];
if (!planPath) {
  process.stderr.write('Usage: suggest-shards-from-plan.mjs <plan.md>\n');
  process.exit(2);
}

const text = fs.readFileSync(planPath, 'utf8');
const packagePaths = new Set();

for (const match of text.matchAll(
  /flutter\/(?:apps|packages)\/[a-z0-9_./-]+/gi,
)) {
  const raw = match[0].replace(/[`*)]/g, '');
  const parts = raw.split('/');
  if (parts.length >= 3) {
    const base = `${parts[0]}/${parts[1]}/${parts[2]}/`;
    packagePaths.add(base.endsWith('lib/') ? base : base);
  }
}

const shards = [...packagePaths].sort().map((p, i) => ({
  id: `shard-${i + 1}`,
  paths: [p],
  dependsOn: [],
}));

const manifest = {
  shards,
  maxParallel: Math.min(4, shards.length || 1),
};

process.stdout.write(
  '# Hints only — edit before validate-shard-manifest.mjs\n' +
    `${JSON.stringify(manifest, null, 2)}\n`,
);
