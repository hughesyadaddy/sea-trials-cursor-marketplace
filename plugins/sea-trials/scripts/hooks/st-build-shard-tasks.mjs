#!/usr/bin/env node
/**
 * Emit JSON Task lines for parallel build shards (/st-build-with-subagents).
 *
 *   pnpm st-build-shard-tasks -- --manifest shards.json --root /path/to/repo
 *
 * Respects dependsOn: only shards with satisfied deps are emitted per wave.
 * Parent runs one turn per wave; re-run after integration for next wave.
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {
    manifest: 'shards.json',
    root: process.cwd(),
    wave: null,
    done: [],
    stateFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--wave') out.wave = Number(argv[++i]);
    else if (arg === '--state-file') out.stateFile = argv[++i];
    else if (arg === '--done') {
      out.done = argv[++i]
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    }
  }
  return out;
}



function loadDoneIds(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return new Set(parsed.done ?? []);
  } catch {
    return new Set();
  }
}

function saveDoneIds(stateFile, done) {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ done: [...done] }, null, 2)}\n`,
  );
}

function readyShards(shards, done) {
  return shards.filter((shard) => {
    if (done.has(shard.id)) return false;
    const deps = shard.dependsOn ?? [];
    return deps.every((d) => done.has(d));
  });
}

function main() {
  const { manifest, root, wave, done: doneIds, stateFile } = parseArgs(
    process.argv.slice(2),
  );
  const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const shards = raw.shards ?? [];
  const maxParallel = raw.maxParallel ?? 4;
  const done = loadDoneIds(stateFile);
  for (const id of doneIds) done.add(id);

  const emitReady = (readySet) => {
    for (const shard of readySet.slice(0, maxParallel)) {
      const paths = (shard.paths ?? []).join(', ');
      const prompt =
        `Build shard ${shard.id} for Sea Trials.\n` +
        `Repo root (ONLY edit here): ${root}\n` +
        `Allowed paths: ${paths}\n` +
        `Forbidden: git push, worktrees, edits outside allowed paths\n` +
        `Run: pnpm agent-validate -- on each changed .dart file before returning.\n` +
        `Return: files changed, validate exit code, blockers.`;
      const task = {
        source: 'build-shard',
        taskId: shard.id,
        subagent_type: 'generalPurpose',
        description: `Build shard ${shard.id}`,
        prompt,
        paths: shard.paths ?? [],
      };
      process.stdout.write(`${JSON.stringify(task)}\n`);
      done.add(shard.id);
    }
  };

  if (wave === null) {
    emitReady(readyShards(shards, done));
    saveDoneIds(stateFile, done);
    return;
  }

  let waveIndex = 0;
  while (true) {
    const ready = readyShards(shards, done);
    if (ready.length === 0) break;
    if (waveIndex !== wave) {
      for (const shard of ready.slice(0, maxParallel)) done.add(shard.id);
      waveIndex += 1;
      continue;
    }
    emitReady(ready);
    saveDoneIds(stateFile, done);
    break;
  }
}

main();
