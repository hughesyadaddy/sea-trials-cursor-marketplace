#!/usr/bin/env node
/**
 * Validate a build shard manifest (parent-authored JSON).
 *
 * Usage:
 *   node validate-shard-manifest.mjs path/to/shards.json
 *   cat shards.json | node validate-shard-manifest.mjs
 */
import fs from 'node:fs';

const path = process.argv[2];

function readInput() {
  if (path) {
    return fs.readFileSync(path, 'utf8');
  }
  return fs.readFileSync(0, 'utf8');
}

function fail(message) {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

let raw;
try {
  raw = readInput();
} catch (err) {
  fail(`cannot read manifest: ${err.message}`);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch {
  fail('manifest is not valid JSON');
}

if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
  fail('shards must be a non-empty array');
}

const maxParallel = manifest.maxParallel ?? 4;
if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) {
  fail('maxParallel must be an integer between 1 and 8');
}

const ids = new Set();
for (const shard of manifest.shards) {
  if (!shard?.id || typeof shard.id !== 'string') {
    fail('each shard needs a string id');
  }
  if (ids.has(shard.id)) {
    fail(`duplicate shard id: ${shard.id}`);
  }
  ids.add(shard.id);

  if (!Array.isArray(shard.paths) || shard.paths.length === 0) {
    fail(`shard ${shard.id} needs non-empty paths[]`);
  }
  for (const p of shard.paths) {
    if (typeof p !== 'string' || p.includes('..')) {
      fail(`shard ${shard.id} has invalid path: ${p}`);
    }
  }

  if (shard.dependsOn != null) {
    if (!Array.isArray(shard.dependsOn)) {
      fail(`shard ${shard.id} dependsOn must be an array`);
    }
  }
}

for (const shard of manifest.shards) {
  for (const dep of shard.dependsOn ?? []) {
    if (!ids.has(dep)) {
      fail(`shard ${shard.id} depends on unknown id: ${dep}`);
    }
  }
}

const visiting = new Set();
const visited = new Set();

function visit(id) {
  if (visited.has(id)) return;
  if (visiting.has(id)) {
    fail(`cycle detected at shard: ${id}`);
  }
  visiting.add(id);
  const shard = manifest.shards.find((s) => s.id === id);
  for (const dep of shard?.dependsOn ?? []) {
    visit(dep);
  }
  visiting.delete(id);
  visited.add(id);
}

for (const id of ids) {
  visit(id);
}

const normalized = manifest.shards.map((s) => ({
  id: s.id,
  paths: [...s.paths].sort(),
}));

for (let i = 0; i < normalized.length; i += 1) {
  for (let j = i + 1; j < normalized.length; j += 1) {
    const a = normalized[i];
    const b = normalized[j];
    for (const pa of a.paths) {
      for (const pb of b.paths) {
        if (pa === pb || pa.startsWith(pb) || pb.startsWith(pa)) {
          fail(`path overlap between ${a.id} and ${b.id}: ${pa} ~ ${pb}`);
        }
      }
    }
  }
}

process.stdout.write(
  `✅ Shard manifest OK (${manifest.shards.length} shard(s), ` +
    `maxParallel=${maxParallel})\n`,
);
