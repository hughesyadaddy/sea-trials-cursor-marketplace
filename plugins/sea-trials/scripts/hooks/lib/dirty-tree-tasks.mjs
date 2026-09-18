/**
 * Dirty working-tree tasks for agent iteration and push-gate fan-out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertL10nGenerated } from './check-l10n-generated.mjs';
import { isLintableDartPath, isGeneratedDartPath } from './artifact-paths.mjs';
import {
  findNearestPubspecYaml,
  getFlutterWorkspaceMembers,
} from './flutter-packages.mjs';
import { TASK_KIND, buildFlutterCheckPlan } from './check-plan.mjs';
import { ensureSeaTrialsLint } from './ensure-sea-trials-lint.mjs';
import { getSeaTrialsLintCmd } from './resolve-sea-trials-lint.mjs';

const isWindows = process.platform === 'win32';

function capture(repoRoot, cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: isWindows,
    cwd: repoRoot,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/**
 * @param {string} repoRoot
 */
export function gitChangedRepoPaths(repoRoot) {
  const unstaged =
    capture(repoRoot, 'git', ['diff', '--name-only', '--diff-filter=ACMR']) ??
    '';
  const staged =
    capture(repoRoot, 'git', [
      'diff',
      '--name-only',
      '--cached',
      '--diff-filter=ACMR',
    ]) ?? '';
  const untracked =
    capture(repoRoot, 'git', ['ls-files', '--others', '--exclude-standard']) ??
    '';

  return [
    ...new Set(
      [...unstaged.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((p) => !isGeneratedDartPath(p)),
    ),
  ];
}

function packageRelFromRepoPath(repoRoot, repoRel) {
  const flutterRoot = path.join(repoRoot, 'flutter');
  if (!repoRel.startsWith('flutter/')) return null;
  const abs = path.join(repoRoot, repoRel);
  const pubspecPath = findNearestPubspecYaml(abs);
  if (!pubspecPath) return null;
  const pkgDirRel = path
    .relative(flutterRoot, path.dirname(pubspecPath))
    .replace(/\\/g, '/');
  return pkgDirRel === '' ? '.' : pkgDirRel;
}

function pathRelToPackage(repoRel, pkgRel) {
  const prefix = pkgRel === '.' ? 'flutter/' : `flutter/${pkgRel}/`;
  if (!repoRel.startsWith(prefix)) return null;
  return repoRel.slice(prefix.length);
}

function groupChangedTests(repoRoot, changed) {
  const flutterRoot = path.join(repoRoot, 'flutter');
  /** @type {Map<string, string[]>} */
  const byPackage = new Map();
  const workspaceMembers = getFlutterWorkspaceMembers(flutterRoot);

  for (const repoRel of changed) {
    if (!isLintableDartPath(repoRel)) continue;
    const pkgRel = packageRelFromRepoPath(repoRoot, repoRel);
    if (!pkgRel || !workspaceMembers.has(pkgRel)) continue;
    const inPkg = pathRelToPackage(repoRel, pkgRel);
    if (!inPkg?.startsWith('test/') || !inPkg.endsWith('_test.dart')) {
      continue;
    }
    if (!byPackage.has(pkgRel)) byPackage.set(pkgRel, []);
    byPackage.get(pkgRel).push(inPkg);
  }
  return byPackage;
}

/**
 * @param {{
 *   repoRoot: string,
 *   analyzeOnly?: boolean,
 *   testsOnly?: boolean,
 * }} opts
 */
export function prepareDirtyTreeGate({ repoRoot, testsOnly = false }) {
  const changed = gitChangedRepoPaths(repoRoot).filter((p) =>
    fs.existsSync(path.join(repoRoot, p)),
  );
  const changedFlutter = changed.filter((p) => p.startsWith('flutter/'));

  if (!testsOnly && changedFlutter.length > 0) {
    const l10n = assertL10nGenerated(repoRoot);
    if (!l10n.ok) {
      return { ok: false, message: l10n.message, changed };
    }
  }

  return { ok: true, changed };
}

/**
 * @param {{
 *   repoRoot: string,
 *   changed: string[],
 *   analyzeOnly?: boolean,
 *   testsOnly?: boolean,
 * }} opts
 */
export function buildDirtyTreeTasks({
  repoRoot,
  changed,
  analyzeOnly = false,
  testsOnly = false,
}) {
  const flutterRoot = path.join(repoRoot, 'flutter');
  const changedFlutter = changed.filter((p) => p.startsWith('flutter/'));
  const changedToolsLauncher = changed.some((p) =>
    p.startsWith('tools/vscode-sea-trials-flutter-launch/'),
  );
  const changedRustLint = changed.some((p) =>
    p.startsWith('tools/sea-trials-lint/'),
  );

  /** @type {Array<Record<string, unknown>>} */
  const tasks = [];

  if (!testsOnly && changedFlutter.length > 0) {
    const pubspecDiff = changed.includes('flutter/pubspec.yaml')
      ? capture(repoRoot, 'git', ['diff', '--', 'flutter/pubspec.yaml']) ?? ''
      : '';

    ensureSeaTrialsLint(repoRoot, { soft: false });
    const lintCmd = getSeaTrialsLintCmd(repoRoot);

    const { tasks: flutterTasks } = buildFlutterCheckPlan({
      repoRoot,
      changedFiles: changed,
      pubspecDiff,
      lintCmd,
      allowFullWorkspace: false,
    });

    for (const task of flutterTasks) {
      tasks.push({ ...task, weight: 1 });
    }
  }

  if (!analyzeOnly) {
    for (const [pkgRel, testFiles] of groupChangedTests(repoRoot, changed)) {
      const pkgCwd =
        pkgRel === '.' ? flutterRoot : path.join(flutterRoot, pkgRel);
      tasks.push({
        kind: TASK_KIND.TEST,
        label: `flutter test (${pkgRel}, ${testFiles.length} file(s))`,
        cmd: 'flutter',
        args: ['test', '--reporter', 'compact', ...testFiles],
        options: { cwd: pkgCwd },
        weight: 1,
      });
    }

    if (changedToolsLauncher) {
      tasks.push({
        label: 'vscode launcher unit tests',
        cmd: 'node',
        args: [
          '--test',
          'tools/vscode-sea-trials-flutter-launch/flavorModeParser.test.js',
        ],
        options: { cwd: repoRoot },
        weight: 1,
      });
    }

    if (changedRustLint) {
      tasks.push({
        label: 'cargo fmt --check (sea-trials-lint)',
        cmd: 'cargo',
        args: ['fmt', '--check'],
        options: { cwd: path.join(repoRoot, 'tools', 'sea-trials-lint') },
        weight: 1,
      });
    }
  }

  return tasks;
}
