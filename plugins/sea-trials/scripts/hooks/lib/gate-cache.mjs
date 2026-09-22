/**
 * Persistent gate cache keyed by content hash.
 *
 * `gate-pass-token.mjs` skips a whole gate when the *tree* is unchanged
 * since the last pass. This cache is finer: one entry per
 * format / lint / analyze task, keyed by what that task actually reads,
 * so a task whose inputs were already verified green is skipped even
 * on a different branch, worktree or checkout path.
 *
 * Key = sha256 over
 *   - task kind + the tool version (`dart --version`,
 *     `sea-trials-lint --version` — or the binary's size/mtime),
 *   - the command line with repo paths made repo-relative,
 *   - sorted (relative path, content hash) for every input file:
 *       format / lint → the listed files plus each file's nearest
 *         pubspec.yaml and analysis_options.yaml (language version and
 *         page width change the verdict);
 *       analyze → the owning package's pubspec.yaml, pubspec.lock,
 *         analysis_options.yaml, every .dart under lib/ and test/, plus
 *         the workspace root's pubspec/lock/options, plus — for every
 *         transitive workspace / `path:` dependency — that package's
 *         pubspec.yaml and every .dart under its lib/ (an API change in
 *         `x` must invalidate the analyze of its consumer `y`). Hosted
 *         deps are pinned by pubspec.lock. More than
 *         MAX_PACKAGE_DART_FILES dart files in total → not cached.
 *
 * Only SUCCESS verdicts are recorded. One JSON file per key under
 * `stateDir('gate-cache')`, written temp + rename so concurrent
 * workers never observe a torn entry.
 *
 * Env: `ST_GATE_CACHE=0` disables, `ST_GATE_CACHE_DEBUG=1` logs keys.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { stateDir } from '../../lib/st-state-dir.mjs';
import { getAllFlutterPackageDirs } from './flutter-packages.mjs';
import { parsePubspec } from './package-graph.mjs';

const isWindows = process.platform === 'win32';

/** Bump when the key recipe changes so stale entries cannot match. */
export const CACHE_VERSION = 2;

export const CACHEABLE_KINDS = new Set(['format', 'lint', 'analyze']);

/** Above this many .dart files a package is hashed too slowly to help. */
export const MAX_PACKAGE_DART_FILES = 3000;

/** Flags whose following token is a value, not an input path. */
const VALUE_FLAGS = new Set([
  '--output',
  '--root',
  '--line-length',
  '--reporter',
  '--format',
]);

const SKIP_DIRS = new Set(['.dart_tool', 'build', '.git', 'node_modules']);

const CONFIG_FILES = ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml'];

/** @param {NodeJS.ProcessEnv} [env] */
export function cacheEnabled(env = process.env) {
  const raw = (env.ST_GATE_CACHE ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

/** @param {NodeJS.ProcessEnv} [env] */
export function cacheDebug(env = process.env) {
  return (env.ST_GATE_CACHE_DEBUG ?? '').trim() === '1';
}

/**
 * A task is cacheable only when its `kind` is one we know how to hash
 * AND the command line is the check-plan shape for that kind. Lane
 * wrappers (`node run-lane.mjs --lane analyze`) also arrive labelled
 * `analyze` via push-gate JSON lines; their inputs are the whole diff,
 * so they must never be keyed off the wrapper script's content.
 *
 * @param {{ kind?: unknown, cmd?: unknown, args?: unknown }} task
 */
export function isCacheableTask(task) {
  if (!task || !CACHEABLE_KINDS.has(String(task.kind))) return false;
  const cmd = path.basename(String(task.cmd ?? '')).toLowerCase();
  const args = Array.isArray(task.args) ? task.args.map(String) : [];
  switch (task.kind) {
    case 'format':
      return cmd.startsWith('dart') && args[0] === 'format';
    case 'analyze':
      return cmd.startsWith('dart') && args[0] === 'analyze';
    case 'lint':
      return cmd.includes('sea-trials-lint') && args.includes('check');
    default:
      return false;
  }
}

/** @param {{ label?: string, id?: string, cmd?: string }} task */
export function describeSkip(task) {
  return `⏭ cache hit: ${task?.label ?? task?.id ?? task?.cmd ?? 'task'}`;
}

// ---------------------------------------------------------------------
// tool versions
// ---------------------------------------------------------------------

/** @type {Map<string, string | null>} */
const versionMemo = new Map();

/**
 * Version string for a gate binary, memoised per process. Falls back
 * to the binary's size + mtime when `--version` is unavailable, and to
 * null (→ uncacheable) when neither works.
 *
 * @param {string} cmd
 * @param {{ cwd?: string }} [opts]
 */
export function toolVersion(cmd, opts = {}) {
  if (versionMemo.has(cmd)) return versionMemo.get(cmd);
  let version = null;
  try {
    const result = spawnSync(cmd, ['--version'], {
      encoding: 'utf8',
      shell: isWindows,
      cwd: opts.cwd,
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.status === 0 && text) version = text.split('\n')[0].trim();
  } catch {
    version = null;
  }
  if (!version) {
    try {
      const stat = fs.statSync(cmd);
      version = `file:${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      version = null;
    }
  }
  versionMemo.set(cmd, version);
  return version;
}

/** Test seam. */
export function resetToolVersionMemo() {
  versionMemo.clear();
}

// ---------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------

/** @type {Map<string, string | null>} */
const repoRootMemo = new Map();

/**
 * Nearest ancestor (inclusive) containing `.git` (dir or worktree file).
 *
 * @param {string} startDir
 * @returns {string | null}
 */
export function findRepoRoot(startDir) {
  const start = path.resolve(startDir);
  if (repoRootMemo.has(start)) return repoRootMemo.get(start);
  let current = start;
  let found = null;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      found = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  repoRootMemo.set(start, found);
  return found;
}

function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function hashFile(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

function isUnder(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Walk from `startDir` up to (and including) `stopDir` looking for
 * `name`; returns the first absolute hit or null.
 */
function nearestUp(startDir, name, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    const candidate = path.join(current, name);
    if (isFile(candidate)) return candidate;
    if (current === stop) return null;
    const parent = path.dirname(current);
    if (parent === current || !isUnder(stop, current)) return null;
    current = parent;
  }
}

/**
 * Recursively list `.dart` files under `dir`. Returns null once more
 * than `limit` are found (caller treats as uncacheable).
 *
 * @param {string} dir
 * @param {number} limit
 * @param {string[]} [out]
 */
export function listDartFiles(dir, limit = MAX_PACKAGE_DART_FILES, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (listDartFiles(path.join(dir, entry.name), limit, out) === null) {
        return null;
      }
    } else if (entry.isFile() && entry.name.endsWith('.dart')) {
      out.push(path.join(dir, entry.name));
      if (out.length > limit) return null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// workspace dependency closure
// ---------------------------------------------------------------------

/**
 * `path:` values per dependency key. `parsePubspec` (package-graph)
 * yields the keys; this only adds the one nested value we need to
 * resolve a dependency that is not a workspace member.
 *
 * @param {string} text pubspec.yaml contents
 * @returns {Map<string, string>} dependency key → path value
 */
export function parsePathDeps(text) {
  const out = new Map();
  let section = null;
  let entry = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const top = line.match(/^([A-Za-z_][\w-]*)\s*:/);
      section =
        top && (top[1] === 'dependencies' || top[1] === 'dev_dependencies')
          ? top[1]
          : null;
      entry = null;
      continue;
    }
    if (!section) continue;
    const dep = line.match(/^ {2}([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (dep) {
      entry = dep[1];
      const inline = dep[2].match(/path:\s*['"]?([^,}'"\s]+)/);
      if (inline) out.set(entry, inline[1]);
      continue;
    }
    const nested = entry && line.match(/^ {4}path:\s*['"]?([^'"\s]+)/);
    if (nested) out.set(entry, nested[1]);
  }
  return out;
}

/**
 * Nearest ancestor of `pkgDir` (exclusive, up to `repoRoot`) whose
 * pubspec.yaml declares a `workspace:` list — the pub workspace root
 * that resolves bare `resolution: workspace` dependency keys.
 */
function findWorkspaceRoot(pkgDir, repoRoot) {
  let current = path.dirname(path.resolve(pkgDir));
  const stop = path.resolve(repoRoot);
  for (;;) {
    const pubspec = path.join(current, 'pubspec.yaml');
    if (isFile(pubspec)) {
      try {
        if (/^workspace:/m.test(fs.readFileSync(pubspec, 'utf8'))) {
          return current;
        }
      } catch {
        // unreadable — keep walking
      }
    }
    if (current === stop || !isUnder(stop, current)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** @type {Map<string, Map<string, string>>} workspace root → name → abs dir */
const workspaceMembersMemo = new Map();

/**
 * Declared package name → absolute dir for every package under the
 * workspace root. Memoised per process: the directory walk is the
 * expensive part and packages do not appear mid-gate.
 */
function workspaceMembersByName(wsRoot) {
  if (workspaceMembersMemo.has(wsRoot)) return workspaceMembersMemo.get(wsRoot);
  const byName = new Map();
  for (const rel of getAllFlutterPackageDirs(wsRoot)) {
    const dir = path.join(wsRoot, rel);
    try {
      const { name } = parsePubspec(
        fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8'),
      );
      if (name && !byName.has(name)) byName.set(name, dir);
    } catch {
      // unreadable pubspec — not resolvable by name
    }
  }
  workspaceMembersMemo.set(wsRoot, byName);
  return byName;
}

/** Test seam. */
export function resetWorkspaceMemo() {
  workspaceMembersMemo.clear();
  repoRootMemo.clear();
}

/**
 * Transitive in-repo dependencies of `pkgDirs`: bare workspace keys
 * resolve through the workspace root's member list, `path:` values
 * resolve relative to the declaring pubspec. The starting packages are
 * excluded from the result.
 *
 * @param {string[]} pkgDirs absolute package dirs
 * @param {string} repoRoot
 * @returns {string[]} sorted absolute dependency package dirs
 */
export function transitiveLocalDeps(pkgDirs, repoRoot) {
  const start = new Set(pkgDirs.map((d) => path.resolve(d)));
  const seen = new Set(start);
  const queue = [...start];
  const deps = new Set();
  while (queue.length > 0) {
    const dir = queue.shift();
    let text;
    try {
      text = fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
    } catch {
      continue;
    }
    const { deps: keys } = parsePubspec(text);
    const pathDeps = parsePathDeps(text);
    const wsRoot = findWorkspaceRoot(dir, repoRoot);
    const members = wsRoot ? workspaceMembersByName(wsRoot) : new Map();
    for (const key of keys) {
      let target = null;
      if (pathDeps.has(key)) {
        target = path.resolve(dir, pathDeps.get(key));
      } else if (members.has(key)) {
        target = members.get(key);
      }
      if (!target || !isFile(path.join(target, 'pubspec.yaml'))) continue;
      if (!isUnder(repoRoot, target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      deps.add(target);
      queue.push(target);
    }
  }
  return [...deps].sort();
}

// ---------------------------------------------------------------------
// task → inputs
// ---------------------------------------------------------------------

/**
 * Path-looking tokens from a command line: anything not starting with
 * `-` that exists relative to `cwd`, skipping values of known flags.
 *
 * @param {string[]} args
 * @param {string} cwd
 */
export function pathArgs(args, cwd) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (VALUE_FLAGS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    const abs = path.resolve(cwd, token);
    if (isFile(abs) || isDir(abs)) out.push(abs);
  }
  return out;
}

/**
 * Resolve the concrete input files a task reads.
 *
 * @param {{ kind?: string, args?: string[], cwd?: string,
 *   options?: { cwd?: string } }} task
 * @param {{ repoRoot: string, maxPackageDartFiles?: number }} opts
 * @returns {{ files: string[], tooBig: boolean, packages: string[],
 *   dependencies: string[] }}
 */
export function taskInputs(task, opts) {
  const repoRoot = path.resolve(opts.repoRoot);
  const limit = opts.maxPackageDartFiles ?? MAX_PACKAGE_DART_FILES;
  const cwd = path.resolve(task.cwd ?? task.options?.cwd ?? repoRoot);
  const args = Array.isArray(task.args) ? task.args : [];
  const files = new Set();
  const packages = new Set();
  const dependencies = new Set();
  let tooBig = false;

  const addConfigsFor = (dir) => {
    for (const name of ['pubspec.yaml', 'analysis_options.yaml']) {
      const hit = nearestUp(dir, name, repoRoot);
      if (hit) files.add(hit);
    }
  };

  const listed = pathArgs(args, cwd);

  if (task.kind === 'analyze') {
    // One shared, deduplicated set so the cap applies to the TOTAL dart
    // file count: analyzed dirs + owning packages (lib/ + test/) +
    // dependency lib/s. (`packages/y/lib` is both a listed dir and the
    // owning package's lib/ — it must count once.)
    const dartFiles = new Set();
    const collect = (dir) => {
      if (tooBig || !isDir(dir)) return;
      const found = listDartFiles(dir, limit);
      if (found === null) {
        tooBig = true;
        return;
      }
      for (const f of found) dartFiles.add(f);
      if (dartFiles.size > limit) tooBig = true;
    };
    for (const abs of listed) {
      const dir = isDir(abs) ? abs : path.dirname(abs);
      if (isFile(abs)) {
        files.add(abs);
      } else {
        // The analyzed directory itself (a workspace root or a package
        // dir without lib/) must be hashed, not just its configs.
        collect(abs);
      }
      const pubspec = nearestUp(dir, 'pubspec.yaml', repoRoot);
      if (pubspec) packages.add(path.dirname(pubspec));
    }
    for (const pkgDir of packages) {
      for (const name of CONFIG_FILES) {
        const abs = path.join(pkgDir, name);
        if (isFile(abs)) files.add(abs);
      }
      collect(path.join(pkgDir, 'lib'));
      collect(path.join(pkgDir, 'test'));
    }
    // Consumers break when a dependency's public API moves, even though
    // none of the consumer's own files changed: hash every transitive
    // workspace / path dependency's pubspec + lib/ (test/ cannot be
    // imported across packages, so it is left out).
    if (!tooBig) {
      for (const depDir of transitiveLocalDeps([...packages], repoRoot)) {
        dependencies.add(depDir);
        const pubspec = path.join(depDir, 'pubspec.yaml');
        if (isFile(pubspec)) files.add(pubspec);
        collect(path.join(depDir, 'lib'));
      }
    }
    if (!tooBig) {
      for (const abs of dartFiles) files.add(abs);
    }
    // Workspace-level resolution: the pub workspace root's lock and
    // options decide what every member package resolves against.
    for (const root of new Set([cwd, repoRoot])) {
      for (const name of CONFIG_FILES) {
        const abs = path.join(root, name);
        if (isFile(abs)) files.add(abs);
      }
    }
  } else {
    for (const abs of listed) {
      if (isDir(abs)) {
        const dartFiles = listDartFiles(abs, limit);
        if (dartFiles === null) {
          tooBig = true;
          break;
        }
        for (const f of dartFiles) files.add(f);
        addConfigsFor(abs);
      } else {
        files.add(abs);
        addConfigsFor(path.dirname(abs));
      }
    }
  }

  return {
    files: [...files].sort(),
    tooBig,
    packages: [...packages].sort(),
    dependencies: [...dependencies].sort(),
  };
}

/**
 * Make the command line checkout-independent: absolute paths under
 * the repo become repo-relative POSIX paths.
 *
 * @param {string[]} tokens
 * @param {string} repoRoot
 * @param {string} cwd
 */
export function normalizeArgs(tokens, repoRoot, cwd) {
  return tokens.map((raw) => {
    const token = String(raw);
    if (token.startsWith('-')) return token;
    const abs = path.isAbsolute(token) ? token : path.resolve(cwd, token);
    if (abs === repoRoot) return '.';
    if (isUnder(repoRoot, abs) && (isFile(abs) || isDir(abs))) {
      return toPosix(path.relative(repoRoot, abs));
    }
    return token;
  });
}

/**
 * @param {Record<string, unknown>} task a check-plan task, a push-gate
 *   JSON line, or a `runParallelLimited` runnable
 * @param {{
 *   repoRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   toolVersions?: Record<string, string>,
 *   maxPackageDartFiles?: number,
 * }} [opts]
 * @returns {string | null} hex key, or null when the task is not cacheable
 */
export function cacheKeyForTask(task, opts = {}) {
  const env = opts.env ?? process.env;
  if (!cacheEnabled(env)) return null;
  if (!isCacheableTask(task)) return null;

  const cwd = path.resolve(
    String(task.cwd ?? task.options?.cwd ?? opts.repoRoot ?? process.cwd()),
  );
  const repoRoot = opts.repoRoot
    ? path.resolve(opts.repoRoot)
    : findRepoRoot(cwd);
  if (!repoRoot) return null;

  const cmd = String(task.cmd ?? '');
  if (!cmd) return null;
  const version =
    opts.toolVersions?.[cmd] ?? toolVersion(cmd, { cwd });
  if (!version) return null;

  const inputs = taskInputs(task, {
    repoRoot,
    maxPackageDartFiles: opts.maxPackageDartFiles,
  });
  const noPackage = task.kind === 'analyze' && inputs.packages.length === 0;
  if (inputs.tooBig || inputs.files.length === 0 || noPackage) {
    if (cacheDebug(env)) {
      const why = inputs.tooBig
        ? 'too many files'
        : noPackage
          ? 'no owning package'
          : 'no inputs';
      process.stderr.write(
        `[gate-cache] uncacheable ${task.label ?? cmd}: ${why}\n`,
      );
    }
    return null;
  }

  const hashed = [];
  for (const abs of inputs.files) {
    const digest = hashFile(abs);
    if (!digest) return null;
    hashed.push([toPosix(path.relative(repoRoot, abs)), digest]);
  }

  const args = Array.isArray(task.args) ? task.args : [];
  const material = JSON.stringify({
    v: CACHE_VERSION,
    kind: task.kind,
    tool: version,
    cmd: normalizeArgs([cmd], repoRoot, cwd)[0],
    args: normalizeArgs(args, repoRoot, cwd),
    cwd: isUnder(repoRoot, cwd)
      ? toPosix(path.relative(repoRoot, cwd))
      : cwd === repoRoot
        ? '.'
        : cwd,
    files: hashed,
  });
  const key = crypto.createHash('sha256').update(material).digest('hex');
  if (cacheDebug(env)) {
    process.stderr.write(
      `[gate-cache] ${key.slice(0, 12)} ${task.kind} ` +
        `${hashed.length} file(s) ${task.label ?? cmd}\n`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------
// store
// ---------------------------------------------------------------------

/** @param {{ env?: NodeJS.ProcessEnv }} [opts] */
export function cacheDir(opts = {}) {
  return stateDir('gate-cache', { env: opts.env });
}

/**
 * @param {string} key
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function entryPath(key, opts = {}) {
  return path.join(cacheDir(opts), `${key}.json`);
}

/**
 * @param {string | null} key
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ hit: boolean, at?: number, meta?: Record<string, unknown> }}
 */
export function lookup(key, opts = {}) {
  if (!key) return { hit: false };
  try {
    const raw = JSON.parse(fs.readFileSync(entryPath(key, opts), 'utf8'));
    if (!raw || raw.key !== key) return { hit: false };
    const at = Date.parse(String(raw.at ?? ''));
    return { hit: true, at: Number.isFinite(at) ? at : undefined, meta: raw };
  } catch {
    return { hit: false };
  }
}

/**
 * Record a SUCCESS verdict. Callers must never call this for a failed
 * task. Temp + rename keeps concurrent writers safe.
 *
 * @param {string | null} key
 * @param {Record<string, unknown>} [meta]
 * @param {{ env?: NodeJS.ProcessEnv, now?: Date }} [opts]
 * @returns {boolean} true when written
 */
export function record(key, meta = {}, opts = {}) {
  if (!key) return false;
  if (meta.ok === false) return false;
  try {
    const dir = cacheDir(opts);
    const target = path.join(dir, `${key}.json`);
    const tmp = path.join(
      dir,
      `${key}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    const entry = {
      key,
      at: (opts.now ?? new Date()).toISOString(),
      ...meta,
    };
    fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop entries older than `maxAgeDays`, then the oldest beyond
 * `maxEntries`. Stale `.tmp` files from crashed writers go too.
 *
 * @param {{ maxAgeDays?: number, maxEntries?: number, now?: number,
 *   env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ removed: number, kept: number }}
 */
export function prune(opts = {}) {
  const maxAgeDays = opts.maxAgeDays ?? 14;
  const maxEntries = opts.maxEntries ?? 5000;
  const now = opts.now ?? Date.now();
  const dir = cacheDir(opts);
  let removed = 0;
  /** @type {Array<{ file: string, mtime: number }>} */
  const entries = [];

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }
  const unlink = (file) => {
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      // raced another pruner
    }
  };
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (name.endsWith('.tmp')) {
      if (now - stat.mtimeMs > 60 * 60 * 1000) unlink(file);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    if (now - stat.mtimeMs > maxAgeDays * 24 * 60 * 60 * 1000) {
      unlink(file);
      continue;
    }
    entries.push({ file, mtime: stat.mtimeMs });
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  while (entries.length > maxEntries) {
    unlink(entries.shift().file);
  }
  return { removed, kept: entries.length };
}
