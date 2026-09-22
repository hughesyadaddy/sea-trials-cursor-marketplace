/**
 * PR-diff path matching and git tree fingerprints for PR Checks skip.
 *
 * Path skip: if this PR's changed files miss the job's globs, do not
 * install toolchains — even on a cold pass-cache. Tree hash: one
 * `git rev-parse HEAD:<dir>` per input, not hashFiles of every blob.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} glob
 * @param {string} file
 * @returns {boolean}
 */
export function globMatches(glob, file) {
  const g = glob.replace(/\\/g, '/').replace(/^\/+/, '');
  const f = file.replace(/\\/g, '/').replace(/^\/+/, '');
  if (g.endsWith('/**')) {
    const prefix = g.slice(0, -3);
    if (!prefix) return true;
    return f === prefix || f.startsWith(`${prefix}/`);
  }
  if (!g.includes('*')) {
    return f === g || f.startsWith(`${g}/`);
  }
  let re = '^';
  for (let i = 0; i < g.length; ) {
    if (g.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (g.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    if (g[i] === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    re += g[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`${re}$`).test(f);
}

/**
 * Workflow / action edits must fail-open every lane: fingerprint
 * includes these trees, but path-skip runs first and would otherwise
 * report a hit before that hash is considered.
 *
 * The repo's `scripts/ci/**` (lane registry + wiring) is on the list too:
 * a change to the registry alters what every lane considers relevant, so
 * a PR that only edits it must re-run every lane rather than grade itself
 * with the config it is replacing.
 */
export const LANE_INFRA_GLOBS = [
  '.github/workflows/pr-checks.yml',
  '.github/workflows/main-guardrails.yml',
  '.github/actions/pr-lane-pass-cache/**',
  '.github/actions/setup-flutter-stable/**',
  // The app repo's remaining CI surface: the lane registry, the plugin
  // wiring shim and the config-parity tests. The skip logic itself
  // (this module, pr-push-changed-files.mjs, guardrails-analyze-packages.mjs)
  // ships in the sea-trials plugin, so a plugin version bump — not a
  // repo path — is what changes it.
  'scripts/ci/**',
];

/**
 * @param {string[]} changedFiles
 * @param {string[]} globs
 * @returns {boolean}
 */
export function anyPathMatches(changedFiles, globs) {
  const files = changedFiles.map((s) => s.trim()).filter(Boolean);
  const patterns = globs.map((s) => s.trim()).filter(Boolean);
  if (patterns.length === 0) return true;
  return files.some((file) => patterns.some((g) => globMatches(g, file)));
}

/**
 * Path-skip match including always-watched lane infrastructure.
 *
 * @param {string[]} changedFiles
 * @param {string[]} globs
 * @returns {boolean}
 */
export function matchLanePaths(changedFiles, globs) {
  return anyPathMatches(changedFiles, [...globs, ...LANE_INFRA_GLOBS]);
}

/** Sentinel `treePathsFromGlobs` emits for "the whole repository". */
export const REPO_ROOT_TREE = '.';

/**
 * `git rev-parse` argument for a fingerprint path.
 *
 * `HEAD:.` is an error ("path '.' exists on disk, but not in HEAD"), so
 * the repo-root sentinel has to become the bare `HEAD:`.
 *
 * @param {string} treePath
 * @returns {string}
 */
export function revParseSpec(treePath) {
  return treePath === REPO_ROOT_TREE ? 'HEAD:' : `HEAD:${treePath}`;
}

/**
 * Git paths to fingerprint for a glob list (`flutter/**` → `flutter`).
 *
 * A leading `**` (e.g. `**\/*.arb`) names no directory, so there is no
 * subtree to hash. Dropping it silently would let two different PRs that
 * each touch only such a file produce the *same* fingerprint — the second
 * one would then hit the first one's pass sentinel and skip a lane whose
 * inputs did change. Fall back to the whole repository tree instead: the
 * cost is a cache miss, and the alternative is a false skip.
 *
 * @param {string[]} globs
 * @returns {string[]}
 */
export function treePathsFromGlobs(globs) {
  const out = new Set();
  for (const raw of globs) {
    const g = raw.trim().replace(/\\/g, '/');
    if (!g) continue;
    if (g.startsWith('**')) {
      out.add(REPO_ROOT_TREE);
      continue;
    }
    let p = g;
    if (p.endsWith('/**/*')) p = p.slice(0, -5);
    else if (p.endsWith('/**')) p = p.slice(0, -3);
    else if (p.includes('/**/')) p = p.slice(0, p.indexOf('/**/'));
    else if (p.includes('*')) {
      const before = p.split('*')[0];
      p = before.replace(/\/[^/]*$/, '') || before.replace(/\/+$/, '');
    }
    if (p) out.add(p);
  }
  return [...out].sort();
}

/**
 * Tree paths a lane's fingerprint must cover: its own globs plus lane
 * infrastructure.
 *
 * Exported and used as the single call site so the infra list is never
 * restated. It previously was — a second hardcoded copy inside `main()`,
 * kept in step by a comment, which had already drifted
 * (`.github/actions/pr-lane-pass-cache` there versus `…/**` in the
 * constant). That copy sat under `c8 ignore`, so nothing observed it.
 *
 * @param {string[]} globs the lane's own globs
 * @returns {string[]} sorted, de-duplicated tree paths
 */
export function fingerprintTreePaths(globs) {
  return [
    ...new Set([
      ...treePathsFromGlobs(globs),
      ...treePathsFromGlobs(LANE_INFRA_GLOBS),
    ]),
  ].sort();
}

/**
 * @param {string} stdout `git rev-parse` lines
 * @param {string[]} paths requested paths, same order
 * @returns {string}
 */
export function fingerprintFromRevParse(stdout, paths) {
  const lines = stdout.split('\n').map((s) => s.trim());
  const rows = paths.map((p, i) => {
    const line = lines[i] ?? '';
    const ok = /^[0-9a-f]{40,}$/i.test(line);
    return `${p}:${ok ? line : 'missing'}`;
  });
  return rows.join('\n');
}

/**
 * @param {string[]} argv
 * @returns {{
 *   match?: boolean,
 *   fingerprint?: boolean,
 *   globs: string[],
 *   changed: string[],
 * }}
 */
export function parseLanePathArgs(argv) {
  /** @type {string[]} */
  const globs = [];
  /** @type {string[]} */
  const changed = [];
  let match = false;
  let fingerprint = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--match') {
      match = true;
    } else if (arg === '--fingerprint') {
      fingerprint = true;
    } else if (arg === '--glob' || arg === '--changed') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--glob') globs.push(value);
      else changed.push(value);
      i += 1;
    } else if (arg === '--changed-file') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--changed-file requires a value');
      }
      changed.push(
        ...readFileSync(value, 'utf8')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      i += 1;
    } else if (arg === '--globs') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--globs requires a value');
      }
      globs.push(
        ...value
          .split(/\n|,/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      i += 1;
    } else {
      throw new Error(`Unknown argument '${arg}'`);
    }
  }
  return { match, fingerprint, globs, changed };
}

function gitLines(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim();
}

/* c8 ignore start */
function main() {
  const opts = parseLanePathArgs(process.argv.slice(2));
  if (opts.match) {
    const ok = matchLanePaths(opts.changed, opts.globs);
    process.stdout.write(`matched=${ok ? 'true' : 'false'}\n`);
    return;
  }
  if (opts.fingerprint) {
    const paths = fingerprintTreePaths(opts.globs);
    const lines = paths.map((p) => {
      try {
        return gitLines(['rev-parse', revParseSpec(p)]);
      } catch {
        return 'missing';
      }
    });
    process.stdout.write(
      `${fingerprintFromRevParse(lines.join('\n'), paths)}\n`,
    );
    return;
  }
  throw new Error('pass --match or --fingerprint');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pr-lane-paths: ${err.message}\n`);
    process.exit(2);
  }
}
/* c8 ignore stop */
