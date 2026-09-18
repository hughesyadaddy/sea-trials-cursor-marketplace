#!/usr/bin/env node
/**
 * Fast validation for agent sessions — changed Dart files only.
 *
 * Use during /build, /hotfix, and iteration. Full-package gates stay on
 * prepush (format, analyze, custom lint) and CI (tests).
 *
 * Usage:
 *   pnpm agent-validate
 *   pnpm agent-validate -- flutter/packages/foo/lib/a.dart
 *   pnpm agent-validate --analyze-only
 *   pnpm agent-validate --tests-only
 *
 * Explicit paths may be repo-relative (flutter/...) or absolute — including
 * git worktrees outside the current checkout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runParallelLimited } from './lib/parallel.mjs';
import { findNearestPubspecYaml, getFlutterWorkspaceMembers } from './lib/flutter-packages.mjs';
import { assertL10nGenerated } from './lib/check-l10n-generated.mjs';
import { isLintableDartPath } from './lib/artifact-paths.mjs';

const isWindows = process.platform === 'win32';

const repoRoot = (() => {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (top.status === 0) return (top.stdout ?? '').trim();
  return process.cwd();
})();

const flutterRoot = path.join(repoRoot, 'flutter');

function capture(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

function parseArgs(argv) {
  const flags = new Set();
  const paths = [];
  for (const arg of argv) {
    if (arg === '--analyze-only') flags.add('analyze-only');
    else if (arg === '--tests-only') flags.add('tests-only');
    else if (arg === '--help' || arg === '-h') flags.add('help');
    else if (arg === '--') continue;
    else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      process.exit(2);
    } else {
      paths.push(arg);
    }
  }
  return { flags, paths };
}

function gitChangedDartPaths() {
  const unstaged =
    capture('git', ['diff', '--name-only', '--diff-filter=ACMR']) ?? '';
  const staged =
    capture('git', ['diff', '--name-only', '--cached', '--diff-filter=ACMR']) ??
    '';
  const untracked =
    capture('git', ['ls-files', '--others', '--exclude-standard']) ?? '';

  const merged = new Set(
    [...unstaged.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => isLintableDartPath(p)),
  );
  return [...merged];
}

/**
 * Resolve a Dart file under flutter/ in any git checkout (main or worktree).
 *
 * @returns {{ repoRoot: string, repoRel: string, flutterRoot: string } | null}
 */
function resolveFlutterDartFile(inputPath) {
  const abs = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.normalize(path.join(repoRoot, inputPath));

  if (!abs.endsWith('.dart') || !fs.existsSync(abs)) {
    return null;
  }

  const gitRoot = capture('git', [
    '-C',
    path.dirname(abs),
    'rev-parse',
    '--show-toplevel',
  ]);
  if (!gitRoot) {
    return null;
  }

  const repoRel = path.relative(gitRoot, abs).replace(/\\/g, '/');
  if (!isLintableDartPath(repoRel)) {
    return null;
  }

  return {
    repoRoot: gitRoot,
    repoRel,
    flutterRoot: path.join(gitRoot, 'flutter'),
  };
}

function packageRelFromResolved(resolved) {
  const abs = path.join(resolved.repoRoot, resolved.repoRel);
  const pubspecPath = findNearestPubspecYaml(abs);
  if (!pubspecPath) return null;
  const pkgDirAbs = path.dirname(pubspecPath);
  const pkgDirRel = path
    .relative(resolved.flutterRoot, pkgDirAbs)
    .replace(/\\/g, '/');
  return pkgDirRel === '' ? '.' : pkgDirRel;
}

function pathRelToPackage(repoRel, pkgRel) {
  const prefix = pkgRel === '.' ? 'flutter/' : `flutter/${pkgRel}/`;
  if (!repoRel.startsWith(prefix)) return null;
  return repoRel.slice(prefix.length);
}

function packageGroupKey(resolved, pkgRel) {
  return `${resolved.flutterRoot}::${pkgRel}`;
}

/** @type {Set<string>} */
const firstPartyNonWorkspacePackages = new Set([
  '.',
  'packages/test_utils',
]);

function isAgentValidatablePackage(pkgRel, workspaceMembers) {
  return (
    workspaceMembers.has(pkgRel) ||
    firstPartyNonWorkspacePackages.has(pkgRel)
  );
}

function groupByPackage(resolvedFiles) {
  /** @type {Map<string, { resolved: { repoRoot: string, flutterRoot: string }, pkgRel: string, lib: string[], test: string[], pubspecChanged: boolean }>} */
  const groups = new Map();
  /** @type {Map<string, Set<string>>} */
  const workspaceMembersByFlutterRoot = new Map();

  for (const resolved of resolvedFiles) {
    const pkgRel = packageRelFromResolved(resolved);
    if (!pkgRel) continue;

    let workspaceMembers = workspaceMembersByFlutterRoot.get(
      resolved.flutterRoot,
    );
    if (!workspaceMembers) {
      workspaceMembers = getFlutterWorkspaceMembers(resolved.flutterRoot);
      workspaceMembersByFlutterRoot.set(
        resolved.flutterRoot,
        workspaceMembers,
      );
    }
    // Only declared workspace members are ours to validate, plus a
    // small set of first-party packages outside the workspace list.
    if (!isAgentValidatablePackage(pkgRel, workspaceMembers)) continue;

    const key = packageGroupKey(resolved, pkgRel);
    if (!groups.has(key)) {
      groups.set(key, {
        resolved,
        pkgRel,
        lib: [],
        test: [],
        pubspecChanged: false,
      });
    }
    const entry = groups.get(key);

    const inPkg = pathRelToPackage(resolved.repoRel, pkgRel);
    if (!inPkg) continue;

    if (inPkg.startsWith('test/')) {
      // Only runnable test files: shared fixtures/helpers under
      // test/ (e.g. test/helpers/mock_*.dart) have no main() and
      // make `flutter test` fail if passed directly.
      if (inPkg.endsWith('_test.dart')) entry.test.push(inPkg);
    } else if (
      inPkg.startsWith('lib/') ||
      inPkg.startsWith('scripts/') ||
      inPkg.startsWith('bin/') ||
      inPkg.startsWith('tool/')
    ) {
      entry.lib.push(inPkg);
    }
  }

  return groups;
}

function resolveExplicitPaths(explicitPaths) {
  /** @type {{ repoRoot: string, repoRel: string, flutterRoot: string }[]} */
  const resolved = [];
  const rejected = [];

  for (const inputPath of explicitPaths) {
    const file = resolveFlutterDartFile(inputPath);
    if (file) {
      resolved.push(file);
    } else {
      rejected.push(inputPath);
    }
  }

  if (rejected.length > 0) {
    process.stderr.write(
      `⚠️  Skipped ${rejected.length} path(s) — not flutter/*.dart ` +
        `in a git checkout:\n`,
    );
    for (const p of rejected) {
      process.stderr.write(`   ${p}\n`);
    }
  }

  return resolved;
}

function printHelp() {
  process.stdout.write(`\
Fast agent validation (changed Dart files only).

  pnpm agent-validate
  pnpm agent-validate -- flutter/packages/foo/lib/a.dart
  pnpm agent-validate --analyze-only
  pnpm agent-validate --tests-only

Absolute paths from git worktrees are supported.

Full gates: prepush hook + CI. Do not run whole-package MCP test during
iteration unless the user explicitly asks before merge.
`);
}

async function main() {
  const { flags, paths: explicitPaths } = parseArgs(process.argv.slice(2));

  if (flags.has('help')) {
    printHelp();
    process.exit(0);
  }

  const analyzeOnly = flags.has('analyze-only');
  const testsOnly = flags.has('tests-only');

  /** @type {{ repoRoot: string, repoRel: string, flutterRoot: string }[]} */
  let resolvedFiles = [];

  if (explicitPaths.length > 0) {
    resolvedFiles = resolveExplicitPaths(explicitPaths);
    if (resolvedFiles.length === 0) {
      process.stderr.write(
        '❌ No valid flutter/*.dart paths in explicit file list.\n',
      );
      process.exit(2);
    }
  } else {
    const repoPaths = gitChangedDartPaths();
    resolvedFiles = repoPaths.map((repoRel) => ({
      repoRoot,
      repoRel,
      flutterRoot,
    }));

    // Include pubspec.yaml changes that sit beside changed dart files.
    for (const repoRel of repoPaths) {
      const pkgRel = packageRelFromResolved({
        repoRoot,
        repoRel,
        flutterRoot,
      });
      if (!pkgRel) continue;
      const pubspecRepoPath =
        pkgRel === '.'
          ? 'flutter/pubspec.yaml'
          : `flutter/${pkgRel}/pubspec.yaml`;
      if (!fs.existsSync(path.join(repoRoot, pubspecRepoPath))) continue;
      const pubspecChanged =
        capture('git', ['diff', '--name-only', pubspecRepoPath]) ||
        capture('git', ['diff', '--name-only', '--cached', pubspecRepoPath]) ||
        capture('git', [
          'ls-files',
          '--others',
          '--exclude-standard',
          pubspecRepoPath,
        ]);
      if (pubspecChanged) {
        resolvedFiles.push({
          repoRoot,
          repoRel: pubspecRepoPath,
          flutterRoot,
        });
      }
    }
  }

  resolvedFiles = [
    ...new Map(
      resolvedFiles.map((file) => [
        path.join(file.repoRoot, file.repoRel),
        file,
      ]),
    ).values(),
  ];

  if (resolvedFiles.length === 0) {
    process.stdout.write('✅ No changed Flutter Dart files to validate.\n');
    process.exit(0);
  }

  const groups = groupByPackage(resolvedFiles);
  if (groups.size === 0) {
    process.stdout.write('✅ No analyzable Flutter packages in changed set.\n');
    process.exit(0);
  }

  process.stdout.write(
    `🔎 Agent validate (${resolvedFiles.length} file(s), ` +
      `${groups.size} package(s))...\n`,
  );

  if (!testsOnly) {
    const repoRoots = [
      ...new Set([...groups.values()].map(({ resolved }) => resolved.repoRoot)),
    ];
    for (const root of repoRoots) {
      const l10n = assertL10nGenerated(root);
      if (!l10n.ok) {
        process.stderr.write(`❌ ${l10n.message}\n`);
        process.exit(2);
      }
    }
  }

  const tasks = [];

  for (const [, { resolved, pkgRel, lib, test }] of groups) {
    const pkgCwd =
      pkgRel === '.'
        ? resolved.flutterRoot
        : path.join(resolved.flutterRoot, pkgRel);

    const pubspecRepoPath =
      pkgRel === '.'
        ? 'flutter/pubspec.yaml'
        : `flutter/${pkgRel}/pubspec.yaml`;
    const pubspecChanged =
      resolved.repoRoot === repoRoot &&
      (capture('git', ['diff', '--name-only', pubspecRepoPath]) ||
        capture('git', ['diff', '--name-only', '--cached', pubspecRepoPath]) ||
        capture('git', [
          'ls-files',
          '--others',
          '--exclude-standard',
          pubspecRepoPath,
        ]));

    if (pubspecChanged) {
      tasks.push({
        label: `flutter pub get (${pkgRel})`,
        cmd: 'flutter',
        args: ['pub', 'get'],
        options: { cwd: pkgCwd },
      });
    }

    if (!testsOnly && lib.length > 0) {
      // --fatal-infos matches pre-push and CI severity so agent
      // iteration surfaces the same failures the push gate would.
      //
      // weight 1: a single file-scoped analyze is far lighter than the
      // merged package-scoped chunks pre-push builds, so these can run
      // concurrently. Pre-push instead serializes with
      // `weight: max(cores, 2)` — it must never run two analysis servers
      // against the IDE at once. Both shapes are intentional, which is
      // why this script does not share `lib/check-plan.mjs`.
      for (const libFile of lib) {
        tasks.push({
          label: `dart analyze (${pkgRel}, ${libFile})`,
          cmd: 'dart',
          args: ['analyze', '--fatal-infos', libFile],
          options: { cwd: pkgCwd },
          weight: 1,
        });
      }
    }

    if (!analyzeOnly && test.length > 0) {
      tasks.push({
        label: `flutter test (${pkgRel}, ${test.length} file(s))`,
        cmd: 'flutter',
        args: ['test', '--reporter', 'compact', ...test],
        options: { cwd: pkgCwd },
      });
    }
  }

  if (tasks.length === 0) {
    process.stdout.write(
      '✅ Nothing to run (lib-only change with no test files — analyze skipped with --tests-only, or no lib with --analyze-only).\n',
    );
    process.exit(0);
  }

  const { failures } = await runParallelLimited(tasks);

  if (failures.length > 0) {
    process.stderr.write(
      '\n❌ Agent validation failed. Fix issues above.\n' +
        'Full gates still run on push via prepush + CI.\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    '✅ Agent validation passed (changed files only).\n' +
      'Run full package tests locally before merge if you changed shared code.\n',
  );
}

main().catch((err) => {
  process.stderr.write(`Agent validate error: ${err.message}\n`);
  process.exit(2);
});
