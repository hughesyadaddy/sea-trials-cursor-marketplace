#!/usr/bin/env node
/**
 * Scoped vendor sync for VGV plugins from imports/vgv-cursor-marketplace.
 *
 * Replaces blind `rsync -a --delete` at plugin root so Cursor and Claude host
 * trees can coexist under plugins/vgv-* without one bump wiping the other.
 *
 * Usage:
 *   node scripts/sync-vendor-plugins.mjs           # apply
 *   node scripts/sync-vendor-plugins.mjs --dry-run # preview only
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const importRoot = path.join(
  repoRoot,
  'imports',
  'vgv-cursor-marketplace',
  'plugins',
);

const dryRun = process.argv.includes('--dry-run');

/** @type {readonly string[]} */
const flutterPluginRootFiles = [
  '.cache-complete',
  '.gitignore',
  '.release-please-config.json',
  '.release-please-manifest.json',
  'CHANGELOG.md',
  'CLAUDE.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
];

/** @type {Array<{ id: string; includes: readonly SyncEntry[] }>} */
const pluginSyncPlans = [
  {
    id: 'vgv-wingspan',
    includes: [
      dir('cursor/'),
      dir('rules/'),
      dir('mcp/'),
      dir('references/'),
      dir('skills/'),
      dir('agents/'),
      dir('hooks/'),
      dir('.cursor-plugin/'),
      dir('.claude-plugin/'),
      file('mcp.json'),
      file('.mcp.json'),
      file('UPSTREAM.md'),
      file('LICENSE'),
    ],
  },
  {
    id: 'vgv-ai-flutter-plugin',
    includes: [
      dir('cursor/'),
      dir('skills/'),
      dir('agents/'),
      dir('hooks/'),
      dir('config/'),
      dir('.cursor-plugin/'),
      dir('.claude-plugin/'),
      file('mcp.json'),
      file('.mcp.json'),
      ...flutterPluginRootFiles.map((name) => file(name)),
    ],
  },
];

/**
 * @typedef {{ kind: 'dir' | 'file'; rel: string; delete?: boolean }} SyncEntry
 */

/** @returns {SyncEntry} */
function dir(rel) {
  return { kind: 'dir', rel, delete: true };
}

/** @returns {SyncEntry} */
function file(rel) {
  return { kind: 'file', rel, delete: false };
}

function fail(message) {
  process.stderr.write(`sync-vendor-plugins: ${message}\n`);
  process.exit(1);
}

function relDisplay(repoPath) {
  return path.relative(repoRoot, repoPath) || '.';
}

function ensureImportSubmodule() {
  const submodulePath = path.join(repoRoot, 'imports', 'vgv-cursor-marketplace');
  if (!fs.existsSync(submodulePath)) {
    fail(
      'missing imports/vgv-cursor-marketplace — run: ' +
        'git submodule update --init imports/vgv-cursor-marketplace',
    );
  }
}

/**
 * @param {string[]} args
 * @returns {{ ok: boolean; output: string }}
 */
function runRsync(args) {
  const result = spawnSync('rsync', args, {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) {
    return { ok: false, output: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      output: output || `rsync exited with code ${result.status}`,
    };
  }
  return { ok: true, output };
}

/**
 * @param {{
 *   pluginId: string;
 *   entry: SyncEntry;
 *   sourceRoot: string;
 *   destRoot: string;
 * }} opts
 */
function syncEntry({ pluginId, entry, sourceRoot, destRoot }) {
  const sourcePath = path.join(sourceRoot, entry.rel);
  const destPath = path.join(destRoot, entry.rel);

  if (!fs.existsSync(sourcePath)) {
    return {
      status: 'skip',
      detail: `missing in import (not merged upstream yet): ${entry.rel}`,
    };
  }

  const rsyncArgs = ['-a'];
  if (dryRun) {
    rsyncArgs.push('--dry-run', '-v');
  }
  if (entry.kind === 'dir' && entry.delete) {
    rsyncArgs.push('--delete');
  }

  if (entry.kind === 'dir') {
    fs.mkdirSync(destPath, { recursive: true });
    rsyncArgs.push(
      `${sourcePath}${path.sep}`,
      `${destPath}${path.sep}`,
    );
  } else {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    rsyncArgs.push(sourcePath, destPath);
  }

  const { ok, output } = runRsync(rsyncArgs);
  if (!ok) {
    return {
      status: 'error',
      detail: output || `rsync failed for ${entry.rel}`,
    };
  }

  const verb = dryRun ? 'would sync' : 'synced';
  const mode =
    entry.kind === 'dir'
      ? entry.delete
        ? 'dir+delete'
        : 'dir'
      : 'file';
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    status: 'ok',
    detail: `${verb} ${entry.rel} (${mode})`,
    lines,
  };
}

function main() {
  ensureImportSubmodule();

  const modeLabel = dryRun ? 'DRY RUN' : 'APPLY';
  process.stdout.write(
    `\nsync-vendor-plugins [${modeLabel}] — scoped rsync (never --delete at plugin root)\n`,
  );
  process.stdout.write(`repo: ${repoRoot}\n\n`);

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const plan of pluginSyncPlans) {
    const sourceRoot = path.join(importRoot, plan.id);
    const destRoot = path.join(repoRoot, 'plugins', plan.id);

    process.stdout.write(`== ${plan.id} ==\n`);
    process.stdout.write(`  from: ${relDisplay(sourceRoot)}\n`);
    process.stdout.write(`  to:   ${relDisplay(destRoot)}\n`);

    if (!fs.existsSync(sourceRoot)) {
      process.stdout.write('  !! import plugin path missing — skip entire plugin\n\n');
      skipped += plan.includes.length;
      continue;
    }

    fs.mkdirSync(destRoot, { recursive: true });

    for (const entry of plan.includes) {
      const result = syncEntry({
        pluginId: plan.id,
        entry,
        sourceRoot,
        destRoot,
      });

      if (result.status === 'skip') {
        process.stdout.write(`  - skip ${entry.rel}: ${result.detail}\n`);
        skipped += 1;
        continue;
      }

      if (result.status === 'error') {
        process.stdout.write(`  ! error ${entry.rel}: ${result.detail}\n`);
        errors += 1;
        continue;
      }

      process.stdout.write(`  - ${result.detail}\n`);
      for (const line of result.lines ?? []) {
        process.stdout.write(`      ${line}\n`);
      }
      synced += 1;
    }

    process.stdout.write('\n');
  }

  process.stdout.write(
    `done: ${synced} path(s) ${dryRun ? 'would sync' : 'synced'}, ` +
      `${skipped} skipped, ${errors} error(s)\n`,
  );

  if (!dryRun) {
    process.stdout.write(
      '\nNext: update PLUGIN_SOURCES.md SHAs after submodule bump, then commit.\n',
    );
  }

  if (errors > 0) {
    process.exit(1);
  }
}

main();
