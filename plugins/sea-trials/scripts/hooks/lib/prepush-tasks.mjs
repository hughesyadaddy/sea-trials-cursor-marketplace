/**
 * Committed-diff pre-push tasks — shared by prepush.mjs and push-gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertL10nGenerated } from './check-l10n-generated.mjs';
import {
  isFlutterWorkspaceLevelChange,
  needsFullFlutterPackageAnalyze,
  chunk,
} from './flutter-packages.mjs';
import { buildFlutterCheckPlan } from './check-plan.mjs';
import { ensureSeaTrialsLint } from './ensure-sea-trials-lint.mjs';
import { getSeaTrialsLintCmd } from './resolve-sea-trials-lint.mjs';
import { resolveBaseRef } from './resolve-base-ref.mjs';

const isWindows = process.platform === 'win32';

function capture(repoRoot, cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: isWindows,
    cwd: options.cwd ?? repoRoot,
    ...options,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

function getUpstreamRef(repoRoot) {
  return capture(repoRoot, 'git', [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
}

function getMergeBase(repoRoot, refA, refB) {
  return capture(repoRoot, 'git', ['merge-base', refA, refB]);
}

function getCurrentBranchName(repoRoot) {
  return capture(repoRoot, 'git', ['branch', '--show-current']);
}

function getPreferredBaseRefs(repoRoot) {
  const branch = getCurrentBranchName(repoRoot);
  if (!branch) return [];

  const configuredBase = capture(repoRoot, 'git', [
    'config',
    '--get',
    `branch.${branch}.gh-merge-base`,
  ]);
  if (!configuredBase) return [];

  if (
    configuredBase.startsWith('origin/') ||
    configuredBase.startsWith('upstream/')
  ) {
    return [configuredBase];
  }

  return [`origin/${configuredBase}`, configuredBase];
}

function getChangedFiles(repoRoot, baseRef) {
  const output = capture(repoRoot, 'git', [
    'diff',
    '--name-only',
    '--diff-filter=ACMRD',
    `${baseRef}..HEAD`,
  ]);
  if (!output) return [];
  return output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function findNearestPackageJson(startAbsPath, repoRoot) {
  let current = path.dirname(startAbsPath);
  while (current.startsWith(repoRoot)) {
    const pkgJson = path.join(current, 'package.json');
    if (fs.existsSync(pkgJson)) return pkgJson;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function getPackageNameForRepoPath(repoRoot, repoPath) {
  const abs = path.join(repoRoot, repoPath);
  const pkgJsonPath = findNearestPackageJson(abs, repoRoot);
  if (!pkgJsonPath) return null;
  try {
    const raw = fs.readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function hasWebRootChange(changedFiles) {
  const webRootFiles = new Set([
    'web/package.json',
    'web/pnpm-lock.yaml',
    'web/turbo.json',
    'web/tsconfig.json',
  ]);
  return changedFiles.some((p) => webRootFiles.has(p));
}

/**
 * @param {string} repoRoot
 */
export function resolvePrepushBaseRef(repoRoot) {
  return resolveBaseRef({
    getMergeBase: (a, b) => getMergeBase(repoRoot, a, b),
    getUpstreamRef: () => getUpstreamRef(repoRoot),
    getPreferredBaseRefs: () => getPreferredBaseRefs(repoRoot),
    revParse: (ref) => capture(repoRoot, 'git', ['rev-parse', ref]),
    preferUpstreamIncremental: process.env.PREPUSH_FULL_BRANCH !== '1',
  });
}

/**
 * @param {string} repoRoot
 */
export function collectPrepushContext(repoRoot) {
  const baseRef = resolvePrepushBaseRef(repoRoot);
  const changed = getChangedFiles(repoRoot, baseRef);
  const changedExisting = changed.filter((repoPath) =>
    fs.existsSync(path.join(repoRoot, repoPath)),
  );

  const pubspecDiffForScope = changed.includes('flutter/pubspec.yaml')
    ? capture(
        repoRoot,
        'git',
        ['diff', `${baseRef}`, '--', 'flutter/pubspec.yaml'],
      ) ?? ''
    : '';

  const webPackageNames = new Set();
  for (const filePath of changed) {
    if (!filePath.startsWith('web/')) continue;
    const name = getPackageNameForRepoPath(repoRoot, filePath);
    if (name) webPackageNames.add(name);
  }

  return {
    baseRef,
    changed,
    changedExisting,
    pubspecDiffForScope,
    hasFlutterWorkspaceLevelChange: needsFullFlutterPackageAnalyze(changed, {
      pubspecDiff: pubspecDiffForScope,
    }),
    changedHasFunctions: changed.some((p) => p.startsWith('functions/')),
    changedHasFlutter: changed.some((p) => p.startsWith('flutter/')),
    changedHasWeb: changed.some((p) => p.startsWith('web/')),
    changedHasMigrations: changed.some((p) =>
      p.startsWith('supabase/migrations/'),
    ),
    changedFlutterDartExistingPaths: changedExisting
      .filter((p) => p.startsWith('flutter/') && p.endsWith('.dart'))
      .map((p) => p.slice('flutter/'.length)),
    changedWebPaths: changedExisting
      .filter((p) => p.startsWith('web/'))
      .map((p) => p.slice('web/'.length)),
    anyPkgJsonChanged: changed.some((p) => p.endsWith('package.json')),
    webPackageNames,
    hasMarketingChanges: webPackageNames.has('@seatrials/marketing'),
    otherWebPkgs: [...webPackageNames].filter(
      (name) =>
        name !== '@seatrials/marketing' && name !== '@seatrials/web',
    ),
    hasWebWorkspaceRootChange: webPackageNames.has('@seatrials/web'),
    hasWebRootChange: hasWebRootChange(changed),
    workspacePathHit: changed.some(isFlutterWorkspaceLevelChange),
  };
}

/**
 * @param {string} repoRoot
 */
export function preparePrepushGate(repoRoot) {
  const ctx = collectPrepushContext(repoRoot);
  if (ctx.changedHasFlutter) {
    const l10n = assertL10nGenerated(repoRoot);
    if (!l10n.ok) {
      return { ok: false, message: l10n.message, ctx };
    }
  }
  return { ok: true, ctx };
}

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof collectPrepushContext>} ctx
 * @param {{ granularity?: string }} [opts]
 */
export function buildPrepushTasks(repoRoot, ctx, opts = {}) {
  const {
    baseRef,
    changed,
    changedExisting,
    pubspecDiffForScope,
    changedHasFunctions,
    changedHasFlutter,
    changedHasWeb,
    changedHasMigrations,
    changedFlutterDartExistingPaths,
    changedWebPaths,
    anyPkgJsonChanged,
    hasMarketingChanges,
    otherWebPkgs,
    hasWebWorkspaceRootChange,
    hasWebRootChange,
  } = ctx;

  /** @type {Array<Record<string, unknown>>} */
  const tasks = [];
  const prettierWebPaths = changedWebPaths.filter((p) =>
    /\.(ts|tsx|md)$/.test(p),
  );

  if (anyPkgJsonChanged) {
    const lockCheckScript = path.join(
      repoRoot,
      'scripts',
      'hooks',
      '_lockfile-check.cjs',
    );
    tasks.push({
      label: 'Lockfile sync check',
      cmd: 'node',
      args: [lockCheckScript],
      weight: 1,
    });
  }

  if (changedHasFlutter) {
    let lintCmd;
    if (changedFlutterDartExistingPaths.length > 0) {
      ensureSeaTrialsLint(repoRoot, { soft: false });
      lintCmd = getSeaTrialsLintCmd(repoRoot);
    }

    // Analyze tasks carry `analyzeWeight()` from the planner: a few
    // analyzers side by side instead of the old one-at-a-time
    // serialisation (which cost ~8 min on multi-package diffs).
    const { tasks: flutterTasks } = buildFlutterCheckPlan({
      repoRoot,
      changedFiles: changed,
      pubspecDiff: pubspecDiffForScope,
      lintCmd,
      allowFullWorkspace: false,
      granularity: opts.granularity,
    });
    tasks.push(...flutterTasks);
  }

  if (changedHasFunctions) {
    tasks.push({
      label: 'Functions lint',
      cmd: 'pnpm',
      args: ['-C', 'functions', 'lint'],
      options: { cwd: repoRoot },
      weight: 1,
    });
  }

  if (changedHasMigrations) {
    const lintDir = path.join(repoRoot, 'scripts', 'migration_lint');
    let lintReady = fs.existsSync(path.join(lintDir, 'node_modules'));
    if (!lintReady) {
      const ci = spawnSync('npm', ['ci', '--silent'], {
        cwd: lintDir,
        shell: isWindows,
        stdio: 'ignore',
      });
      lintReady =
        ci.status === 0 ||
        spawnSync('npm', ['install', '--silent'], {
          cwd: lintDir,
          shell: isWindows,
          stdio: 'ignore',
        }).status === 0;
    }
    const tsxCli = path.join(lintDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (lintReady && fs.existsSync(tsxCli)) {
      tasks.push({
        label: 'migration lint (--strict)',
        cmd: process.execPath,
        args: [
          tsxCli,
          'src/main.ts',
          '--base',
          baseRef,
          '--strict',
          '--grandfather-through',
          '20260605',
        ],
        options: { cwd: lintDir },
        weight: 1,
      });
    }
  }

  if (changedHasWeb) {
    for (const files of chunk(prettierWebPaths, 200)) {
      if (files.length === 0) continue;
      tasks.push({
        label: `prettier --check (${files.length} files)`,
        cmd: 'pnpm',
        args: [
          'exec',
          'prettier',
          '--check',
          ...files.map((f) => path.join('web', f)),
        ],
        options: { cwd: repoRoot },
        weight: 1,
      });
    }

    if (hasMarketingChanges) {
      tasks.push({
        label: 'ESLint (marketing)',
        cmd: 'pnpm',
        args: ['--filter', '@seatrials/marketing', 'lint'],
        options: { cwd: repoRoot },
        weight: 1,
      });
    }

    if (hasWebRootChange || hasWebWorkspaceRootChange) {
      tasks.push({
        label: 'ESLint (web full)',
        cmd: 'pnpm',
        args: ['-C', 'web', 'lint'],
        options: { cwd: repoRoot },
        weight: 1,
      });
    } else if (otherWebPkgs.length > 0) {
      tasks.push({
        label: 'ESLint (web packages)',
        cmd: 'pnpm',
        args: ['-C', 'web', 'lint'],
        options: { cwd: repoRoot },
        weight: 1,
      });
    }
  }

  return tasks;
}
