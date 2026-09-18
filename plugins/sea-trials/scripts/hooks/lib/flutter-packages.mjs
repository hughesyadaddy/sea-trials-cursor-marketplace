import fs from 'node:fs';
import path from 'node:path';

export function findNearestPubspecYaml(startAbsPath) {
  let current = path.dirname(startAbsPath);
  const root = path.parse(current).root;

  while (current !== root && current.length > root.length) {
    const pubspec = path.join(current, 'pubspec.yaml');
    if (fs.existsSync(pubspec)) {
      return pubspec;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export function getFlutterPackageDirs(repoFilePaths, repoRoot) {
  const dirs = new Set();

  for (const repoPath of repoFilePaths) {
    const abs = path.join(repoRoot, repoPath);
    const pubspecPath = findNearestPubspecYaml(abs);
    if (!pubspecPath) continue;

    const pkgDirAbs = path.dirname(pubspecPath);
    const pkgDirRel = path.relative(repoRoot, pkgDirAbs);

    if (!pkgDirRel.startsWith('flutter')) continue;
    dirs.add(pkgDirRel.slice('flutter/'.length).replace(/\\/g, '/'));
  }

  return [...dirs];
}

/// Enumerates every Flutter workspace package dir (relative to
/// `flutterRoot`, e.g. `packages/cache_client`, `apps/client_app`).
///
/// Used by the full-analyze fallback: analyzing per package keeps the
/// analyzer on each package's own analysis_options.yaml (VGA, no
/// `plugins:` block) instead of the workspace root options file, which
/// would load the sea_trials_lints analyzer plugin and re-run all
/// custom rules that `sea-trials-lint check` already enforces.
export function getAllFlutterPackageDirs(flutterRoot) {
  const skip = new Set([
    'b',
    'build',
    'b',
    'node_modules',
    '.dart_tool',
    '.git',
    'ios',
    'android',
    'macos',
    'windows',
    'linux',
    'web',
  ]);
  const results = [];

  function walk(dirAbs) {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    const isPackage =
      dirAbs !== flutterRoot &&
      entries.some((e) => e.isFile() && e.name === 'pubspec.yaml');
    if (isPackage) {
      results.push(
        path.relative(flutterRoot, dirAbs).replace(/\\/g, '/'),
      );
      // Keep walking below a package: nested workspace packages
      // (e.g. app_ui/gallery) get their own entry.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dirAbs, entry.name));
    }
  }

  walk(flutterRoot);
  return results.sort();
}

/// Dart source subdirs to pass to `dart analyze` for a package.
///
/// Analyzing the package root (`.`) can crash the analysis server on
/// Dart 3.12+ workspace packages; lib/test/tool paths are stable.
const dartAnalyzeSubdirs = [
  'lib',
  'test',
  'tool',
  'bin',
  'integration_test',
];

/**
 * Returns analyze targets for a Flutter package (paths relative to
 * [flutterRoot]). Falls back to [pkgDirRel] when no Dart subdirs exist.
 *
 * @param {string} flutterRoot absolute path to `flutter/`
 * @param {string} pkgDirRel package dir relative to flutterRoot
 * @returns {string[]}
 */
export function getDartAnalyzeTargetsForPackage(flutterRoot, pkgDirRel) {
  const targets = [];
  for (const sub of dartAnalyzeSubdirs) {
    const abs = path.join(flutterRoot, pkgDirRel, sub);
    if (fs.existsSync(abs)) {
      targets.push(`${pkgDirRel}/${sub}`.replace(/\\/g, '/'));
    }
  }
  return targets.length > 0 ? targets : [pkgDirRel];
}

/** @type {Map<string, Set<string>>} */
const workspaceMembersCache = new Map();

/**
 * Declared Melos workspace package dirs (relative to [flutterRoot]).
 *
 * Used to ignore vendored SDK trees under a custom Flutter build dir
 * whose nearest pubspec is not a workspace member.
 *
 * @param {string} flutterRoot absolute path to `flutter/`
 * @returns {Set<string>}
 */
export function getFlutterWorkspaceMembers(flutterRoot) {
  const cached = workspaceMembersCache.get(flutterRoot);
  if (cached) return cached;

  const pubspecPath = path.join(flutterRoot, 'pubspec.yaml');
  const content = fs.readFileSync(pubspecPath, 'utf8');
  const members = new Set();
  let inWorkspace = false;

  for (const line of content.split('\n')) {
    if (/^workspace:\s*$/.test(line)) {
      inWorkspace = true;
      continue;
    }
    if (!inWorkspace) continue;

    const match = line.match(/^\s*-\s+(.+)\s*$/);
    if (match) {
      members.add(match[1].trim());
      continue;
    }
    if (line.trim() && !/^\s/.test(line)) {
      break;
    }
  }

  workspaceMembersCache.set(flutterRoot, members);
  return members;
}

/**
 * Candidate workspace-level flutter paths: files whose change can alter
 * analyzer output for packages nobody touched.
 *
 * NOTE: `flutter/analysis_options.yaml` is intentionally NOT here.
 * Pre-push / CI analyze each package via its own
 * `analysis_options.yaml` (VGA, no `plugins:`). The workspace-root
 * options file is IDE-only; comment or Tier-3-toggle edits there
 * must not fan out to ~87 `dart analyze` servers.
 *
 * NOTE: `.github/workflows/pr-checks.yml` is deliberately NOT here
 * either. It was listed to mirror a `dart-analyze` job's `paths:`
 * trigger list; that job is gone and the workflow no longer declares
 * any `paths:` filters, so the coupling had no remaining basis — while
 * still forcing an 87-package sweep on every CI-config edit, inside a
 * PR budget that cannot hold one. Scoping now lives in
 * `check-plan.mjs`, and unchanged consumers are covered by the
 * whole-tree audit in Main Guardrails.
 *
 * @param {string} repoPath path relative to the repo root
 * @returns {boolean}
 */
export function isFlutterWorkspaceLevelChange(repoPath) {
  return /^(flutter\/pubspec\.yaml|flutter\/pubspec\.lock|flutter\/melos\.yaml|flutter\/packages\/shared_deps\/|flutter\/packages\/sea_trials_lints\/)/.test(
    repoPath,
  );
}

/**
 * True when a unified-diff of `flutter/pubspec.yaml` changes the
 * package resolution graph for workspace members: SDK constraints,
 * workspace membership, root `dependencies`, or
 * `dependency_overrides`. Root-only `dev_dependencies` tooling
 * (melos, ft_patch_package, sea_trials_lints, …) returns false.
 *
 * @param {string} diffText `git diff` unified output
 * @returns {boolean}
 */
export function pubspecDiffAffectsPackageGraph(diffText) {
  if (!diffText || !diffText.trim()) return false;
  let section = null;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@')) {
      // Reset at every hunk boundary. A hunk that starts mid-section
      // carries no header of its own, so retaining the previous hunk's
      // section would classify it by the wrong one — a tooling-only
      // `dev_dependencies` bump followed by a graph-affecting hunk was
      // reported as tooling-only, which is precisely backwards. With
      // `section` null again, an unclassified change fails closed below.
      section = null;
      continue;
    }
    if (
      raw.startsWith('diff ')
      || raw.startsWith('index ')
      || raw.startsWith('---')
      || raw.startsWith('+++')
    ) {
      continue;
    }
    if (!(raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' '))) {
      continue;
    }
    const line = raw.slice(1);
    const sec = line.match(/^([A-Za-z_][\w]*)\s*:/);
    if (sec && !/^\s/.test(line)) {
      section = sec[1];
    }
    if (!(raw.startsWith('+') || raw.startsWith('-'))) continue;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // Unified diffs omit section headers when the hunk is far below
    // them (most workspace: / dependency_overrides: item edits).
    // Unclassified changed lines must not be treated as tooling-only.
    if (section == null) return true;
    if (
      section === 'environment'
      || section === 'workspace'
      || section === 'dependencies'
      || section === 'dependency_overrides'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether changed paths require analyzing every Flutter package.
 *
 * Workspace-path hits for shared_deps / sea_trials_lints / melos /
 * environment+workspace pubspec edits still force full analyze.
 * Root-only tooling edits (patch packages, melos bumps) do not —
 * those previously triggered an 87-package storm while looking
 * identical to a hung `dart format` in the progress printer.
 *
 * @param {string[]} changed repo-relative paths
 * @param {{ pubspecDiff?: string }} [opts]
 * @returns {boolean}
 */
export function needsFullFlutterPackageAnalyze(changed, opts = {}) {
  const ws = changed.filter(isFlutterWorkspaceLevelChange);
  if (ws.length === 0) return false;

  if (
    ws.some(
      (p) =>
        p === 'flutter/melos.yaml'
        || p.startsWith('flutter/packages/shared_deps/')
        || p.startsWith('flutter/packages/sea_trials_lints/'),
    )
  ) {
    return true;
  }

  const touchesPubspec = ws.includes('flutter/pubspec.yaml');
  const touchesLock = ws.includes('flutter/pubspec.lock');
  if (!touchesPubspec && !touchesLock) return true;

  if (touchesPubspec) {
    // null = git diff failed — fail closed to full analyze.
    if (opts.pubspecDiff == null) return true;
    if (pubspecDiffAffectsPackageGraph(opts.pubspecDiff)) return true;
    // Tooling-only pubspec edit: ignore accompanying lock churn.
    return false;
  }

  // Lock-only change can bump every resolved package version.
  return true;
}

/**
 * True when a changed file can affect `dart analyze` output for its
 * owning package: Dart sources, pubspec/analysis/build config, and
 * l10n ARB sources (they generate Dart). Native platform code
 * (.swift/.kt/.m), assets, markdown, SQL, etc. cannot change Dart
 * analysis results and must not spawn analyzers.
 *
 * @param {string} repoPath path relative to the repo root
 * @returns {boolean}
 */
export function isDartAnalyzeRelevant(repoPath) {
  return /(\.dart|\.arb|pubspec\.yaml|pubspec\.lock|analysis_options\.yaml|build\.yaml|l10n\.yaml)$/.test(
    repoPath,
  );
}

export function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Merge per-package `dart analyze` targets into a few chunked
 * invocations instead of one process per package.
 *
 * Every `dart analyze` spawn pays a Dart VM + analysis-server cold
 * start (~15–40s); a scoped push touching 18 packages serialized to
 * ~8 minutes of mostly startup (observed 2026-07-15). One server
 * resolves all package contexts in a single pass, so merging turns
 * 18 spawns into 1–2.
 *
 * Package DIRS (full-package fallback) are far heavier than files —
 * they get `dirCost` budget units each so a chunk never stacks many
 * cold full-package contexts.
 *
 * @param {{ fileGroups?: string[][], dirPaths?: string[],
 *   chunkSize?: number, dirCost?: number }} opts
 *   fileGroups: changed-file lists (one per package, flutter-relative)
 *   dirPaths: package dirs needing full analyze (flutter-relative)
 * @returns {{ paths: string[], fileCount: number, dirCount: number }[]}
 */
export function buildMergedAnalyzeChunks({
  fileGroups = [],
  dirPaths = [],
  chunkSize = 40,
  dirCost = 5,
} = {}) {
  /** @type {{ path: string, cost: number, isDir: boolean }[]} */
  const entries = [];
  for (const files of fileGroups) {
    for (const p of files) entries.push({ path: p, cost: 1, isDir: false });
  }
  for (const dir of dirPaths) {
    entries.push({ path: dir, cost: dirCost, isDir: true });
  }

  const chunks = [];
  let current = { paths: [], fileCount: 0, dirCount: 0 };
  let currentCost = 0;
  for (const entry of entries) {
    if (current.paths.length > 0 && currentCost + entry.cost > chunkSize) {
      chunks.push(current);
      current = { paths: [], fileCount: 0, dirCount: 0 };
      currentCost = 0;
    }
    current.paths.push(entry.path);
    currentCost += entry.cost;
    if (entry.isDir) current.dirCount += 1;
    else current.fileCount += 1;
  }
  if (current.paths.length > 0) chunks.push(current);
  return chunks;
}
