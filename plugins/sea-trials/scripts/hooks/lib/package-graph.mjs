/**
 * Reverse-dependency resolution across the Flutter pub workspace.
 *
 * Scoped CI tests need "changed packages plus the packages that depend on
 * them". Nothing in the repo resolved dependents before this.
 *
 * CRITICAL: dependents must be resolved by dependency **key**, never by a
 * `path:` value. This workspace declares sibling dependencies as bare keys
 * with null values under `resolution: workspace`:
 *
 *     resolution: workspace
 *     dependencies:
 *       api_client:      # null value — no path:, no version
 *       app_logger:
 *
 * 63 packages do this and only a handful carry `path:`. A resolver that
 * looks for `path:` entries, or for object-valued dependencies, returns an
 * empty dependent set — and an empty set means a test lane that reports
 * green having run nothing.
 *
 * Filesystem access is injected so this stays unit-testable, mirroring
 * `resolve-base-ref.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getAllFlutterPackageDirs } from './flutter-packages.mjs';

/**
 * Minimal pubspec reader: the package name and its dependency keys.
 *
 * Deliberately not a general YAML parser — the repo has no YAML
 * dependency, and pubspecs have a fixed shape: top-level `name:` and
 * dependency keys nested exactly one level under `dependencies:` /
 * `dev_dependencies:`.
 *
 * @param {string} text pubspec.yaml contents
 * @returns {{name: string|null, deps: string[]}}
 */
export function parsePubspec(text) {
  let name = null;
  const deps = new Set();
  let section = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Top-level key (column 0).
    if (!/^\s/.test(line)) {
      const topLevel = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
      if (!topLevel) {
        section = null;
        continue;
      }
      const [, key, rest] = topLevel;
      if (key === 'name') name = rest.trim() || null;
      section =
        key === 'dependencies' || key === 'dev_dependencies' ? key : null;
      continue;
    }

    if (!section) continue;

    // Dependency entries sit exactly one level in. Deeper lines are that
    // entry's own configuration (`sdk: flutter`, `path: ../x`) and must
    // not be mistaken for further dependencies.
    const entry = line.match(/^ {2}([A-Za-z_][\w-]*)\s*:/);
    if (entry) deps.add(entry[1]);
  }

  return { name, deps: [...deps] };
}

const realIo = {
  listPackageDirs: (flutterRoot) => getAllFlutterPackageDirs(flutterRoot),
  readPubspec: (absPath) => {
    try {
      return fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * Build the workspace dependency graph.
 *
 * @param {{flutterRoot: string, io?: object}} opts
 * @returns {{
 *   dirByName: Map<string, string>,
 *   nameByDir: Map<string, string>,
 *   dependentsByName: Map<string, Set<string>>,
 * }}
 */
export function buildPackageGraph({ flutterRoot, io = realIo }) {
  const dirs = io.listPackageDirs(flutterRoot);
  const dirByName = new Map();
  const nameByDir = new Map();
  /** @type {Map<string, string[]>} package name -> its dependency keys */
  const depsByName = new Map();

  for (const dir of dirs) {
    const text = io.readPubspec(path.join(flutterRoot, dir, 'pubspec.yaml'));
    if (text == null) continue;
    const { name, deps } = parsePubspec(text);
    // A package whose directory name differs from its `name:` is normal
    // here (for example apps/*), so always key off the declared name.
    if (!name) continue;
    dirByName.set(name, dir);
    nameByDir.set(dir, name);
    depsByName.set(name, deps);
  }

  const dependentsByName = new Map();
  for (const [consumer, deps] of depsByName) {
    for (const dep of deps) {
      // Intersect against declared workspace names: this is what makes
      // null-valued sibling deps resolve at all.
      if (!dirByName.has(dep)) continue;
      if (!dependentsByName.has(dep)) dependentsByName.set(dep, new Set());
      dependentsByName.get(dep).add(consumer);
    }
  }

  return { dirByName, nameByDir, dependentsByName };
}

/**
 * Default size of the representative sample. Provisional: the suite has
 * never been timed in CI, so this is a budget guess, not a measurement.
 */
export const REPRESENTATIVE_LIMIT = 12;

/**
 * Trim a package set to a bounded, deterministic sample.
 *
 * Needed because "scope to changed packages" degenerates at both ends for
 * workspace-level diffs: `sea_trials_lints` has 87 direct dependents (the
 * entire workspace) and `shared_deps` has 81, while a root `pubspec.lock`
 * edit owns no package at all and would otherwise validate nothing.
 *
 * Ordering is by descending dependent count, then by name. Most-depended-on
 * packages are picked first because they carry the most signal per unit of
 * budget — if `app_ui` and `api_client` compile and pass, most breakage has
 * surfaced. The name tiebreak keeps the selection stable across runs so a
 * rerun checks the same packages.
 *
 * This is a sample, never a proof: whole-workspace assurance stays with the
 * post-merge audit. Callers must say so in their output.
 *
 * @param {{graph: object, packageDirs: string[], limit?: number}} opts
 * @returns {string[]}
 */
export function boundPackageSet({
  graph,
  packageDirs,
  limit = REPRESENTATIVE_LIMIT,
}) {
  const dirs = [...new Set(packageDirs)];
  if (dirs.length <= limit) return dirs.sort();
  const weight = (dir) => {
    const name = graph.nameByDir.get(dir);
    return graph.dependentsByName.get(name)?.size ?? 0;
  };
  return dirs
    .sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
    .slice(0, limit)
    .sort();
}

/**
 * Changed package dirs plus the dirs of their **direct** in-workspace
 * dependents.
 *
 * Direct-only is deliberate: the whole-tree audit in Main Guardrails is
 * the transitive backstop, and a transitive closure from a low-level
 * package (app_ui, l10n) would pull in most of the workspace and defeat
 * the point of scoping.
 *
 * @param {{graph: object, changedPackageDirs: string[]}} opts
 * @returns {string[]} package dirs relative to `flutter/`, sorted
 */
export function withDirectDependents({ graph, changedPackageDirs }) {
  const out = new Set(changedPackageDirs);
  for (const dir of changedPackageDirs) {
    const name = graph.nameByDir.get(dir);
    if (!name) continue;
    for (const dependent of graph.dependentsByName.get(name) ?? []) {
      const dependentDir = graph.dirByName.get(dependent);
      if (dependentDir) out.add(dependentDir);
    }
  }
  return [...out].sort();
}
