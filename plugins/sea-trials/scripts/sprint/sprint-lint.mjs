#!/usr/bin/env node
/**
 * Lint sprint_planning folders for dev-ready Jira cards.
 *
 *   node scripts/st-run.mjs sprint-lint -- sprint_planning/my-sprint
 *   node scripts/st-run.mjs sprint-lint -- --changed
 *   node scripts/st-run.mjs sprint-lint -- --changed sprint_planning/foo
 *
 * Exits 1 when any folder has lint errors.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStPluginRoot } from '../lib/resolve-st-plugin-root.mjs';
import { lintSprint, loadSprint } from './parse-sprint-folder.mjs';

const isWindows = process.platform === 'win32';

function repoRoot() {
  if (process.env.ST_REPO_ROOT?.trim()) {
    return path.resolve(process.env.ST_REPO_ROOT.trim());
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (top.status !== 0) {
    throw new Error('sprint-lint: not inside a git repository');
  }
  return (top.stdout ?? '').trim();
}

/** @param {string} repo @param {string} [scopePrefix] */
function changedSprintFolders(repo, scopePrefix) {
  const diff = spawnSync(
    'git',
    ['diff', '--name-only', 'HEAD', '--', 'sprint_planning/'],
    { encoding: 'utf8', cwd: repo, shell: isWindows },
  );
  const staged = spawnSync(
    'git',
    ['diff', '--name-only', '--cached', '--', 'sprint_planning/'],
    { encoding: 'utf8', cwd: repo, shell: isWindows },
  );
  const untracked = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', 'sprint_planning/'],
    { encoding: 'utf8', cwd: repo, shell: isWindows },
  );
  const lines = [
    ...(diff.stdout ?? '').split('\n'),
    ...(staged.stdout ?? '').split('\n'),
    ...(untracked.stdout ?? '').split('\n'),
  ];
  /** @type {Set<string>} */
  const folders = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('sprint_planning/')) continue;
    const parts = trimmed.split('/');
    if (parts.length < 3) continue;
    const folder = path.join('sprint_planning', parts[1]);
    if (scopePrefix && !folder.startsWith(scopePrefix)) continue;
    if (fs.existsSync(path.join(repo, folder, 'sprint.json'))) {
      folders.add(folder);
    } else if (fs.existsSync(path.join(repo, folder, '00-epic.md'))) {
      folders.add(folder);
    }
  }
  return [...folders].sort();
}

function printFindings(folder, findings) {
  for (const f of findings) {
    const tag = f.level === 'error' ? 'ERROR' : 'WARN';
    process.stderr.write(`${tag} ${folder}: ${f.where}: ${f.message}\n`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const changed = argv.includes('--changed');
  const dirs = argv.filter((a) => !a.startsWith('-'));
  const repo = repoRoot();
  /** @type {string[]} */
  let targets = dirs.map((d) => path.relative(repo, path.resolve(repo, d)));
  if (changed) {
    const scope = dirs[0];
    targets = changedSprintFolders(repo, scope);
    if (targets.length === 0) {
      console.log('sprint-lint: no changed sprint folders');
      return;
    }
  }
  if (targets.length === 0) {
    process.stderr.write(
      'Usage: sprint-lint [--changed] [sprint_planning/<folder> …]\n',
    );
    process.exit(2);
  }

  resolveStPluginRoot({ startDir: repo });

  let errors = 0;
  let warnings = 0;
  for (const rel of targets) {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) {
      process.stderr.write(`sprint-lint: missing folder ${rel}\n`);
      errors += 1;
      continue;
    }
    const findings = lintSprint(loadSprint(abs));
    printFindings(rel, findings);
    errors += findings.filter((f) => f.level === 'error').length;
    warnings += findings.filter((f) => f.level === 'warn').length;
  }
  console.log(
    `sprint-lint: ${targets.length} folder(s), ${errors} error(s), ${warnings} warning(s)`,
  );
  if (errors > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`sprint-lint: ${err.message}\n`);
    process.exit(2);
  }
}
