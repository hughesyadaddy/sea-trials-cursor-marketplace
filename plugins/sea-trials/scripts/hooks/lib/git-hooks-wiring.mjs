/**
 * The git-hooks wiring contract.
 *
 * Git resolves a relative `core.hooksPath` against the top level of
 * the working tree the command runs in — not against the primary
 * clone. Husky's default value is `.husky/_`, a directory husky
 * generates during install and self-ignores (`.husky/_/.gitignore`
 * contains `*`). A fresh `git worktree add` therefore checks out
 * `.husky/pre-push` but never `.husky/_/pre-push`, git finds no hook,
 * and the push goes out with no format check, no `dart analyze` and no
 * `sea-trials-lint`. Git prints nothing: the bypass is silent, which
 * put `.cursor/rules/git-safe-worktree.mdc` (use a worktree) in direct
 * conflict with `.cursor/rules/never-skip-hooks.mdc` (never skip the
 * gate).
 *
 * The contract that closes it: `core.hooksPath` points at a directory
 * whose hooks are **tracked at HEAD**, so every hook git looks for is
 * a file that every worktree checks out with no per-worktree install
 * step. This module is the single source of truth, shared by the
 * installer (`../install-git-hooks.mjs`), the push gate
 * (`../prepush.mjs`), and the test that pins it.
 */

import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/**
 * Repo-relative value for `core.hooksPath`.
 *
 * Tracked (`git ls-files .husky`), so it exists in every worktree.
 * Relative, so it is never a machine-specific absolute path baked
 * into a shared config. Must stay in sync with `REQUIRED_HOOKS`.
 */
export const HOOKS_DIR = '.husky';

/** Hooks this repo relies on. Each must be tracked and executable. */
export const REQUIRED_HOOKS = ['pre-commit', 'pre-push', 'post-merge'];

/** Mode git records for a tracked executable file. */
export const EXECUTABLE_MODE = '100755';

/**
 * Splits a package.json script into its command segments.
 *
 * Shell-lite on purpose: enough to see which commands a `prepare`
 * script runs, without pretending to be a shell parser.
 *
 * @param {string} script
 * @returns {string[]}
 */
export function scriptSegments(script) {
  if (typeof script !== 'string') return [];
  return script
    .split(/&&|\|\||;/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** `husky`, `npx husky`, `node_modules/.bin/husky`, `husky.mjs`. */
const HUSKY_COMMAND = /(^|[/\\])husky(\.[cm]?js)?$/;

/** A path into the husky package, e.g. `node_modules/husky/bin.mjs`. */
const HUSKY_PACKAGE_PATH = /(^|[/\\])husky[/\\]/;

/**
 * True when a script invokes husky's CLI.
 *
 * Husky's install re-points `core.hooksPath` at the generated,
 * gitignored `.husky/_`, which is exactly the hole this contract
 * exists to close — so invoking it anywhere in `prepare` reopens the
 * hole on the next `pnpm install`.
 *
 * Every token is checked rather than just the command position, so
 * runner prefixes (`npx`, `pnpm exec`, `node`) need no enumeration.
 * `.husky` paths do not match: the patterns require a separator or the
 * start of the token before `husky`, and `.husky` has a dot there.
 *
 * @param {string} script
 * @returns {boolean}
 */
export function invokesHuskyCli(script) {
  return scriptSegments(script)
    .flatMap((segment) => segment.split(/\s+/))
    .filter(Boolean)
    .some(
      (token) => HUSKY_COMMAND.test(token) || HUSKY_PACKAGE_PATH.test(token),
    );
}

/**
 * Reads the tree entries git would check out for `pathspec`.
 *
 * `ls-tree HEAD` — not `ls-files` — because HEAD is precisely what a
 * fresh `git worktree add` materializes. An index-only file would pass
 * an `ls-files` check and still be missing in the worktree.
 *
 * @param {string} repoRoot
 * @param {string} pathspec
 * @returns {{ mode: string, path: string }[]}
 */
export function listHeadEntries(repoRoot, pathspec) {
  const result = spawnSync(
    'git',
    ['ls-tree', '-r', 'HEAD', '--', pathspec],
    { cwd: repoRoot, encoding: 'utf8', shell: isWindows },
  );
  if (result.status !== 0) return [];
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // "<mode> <type> <oid>\t<path>"
      const [meta, filePath] = line.split('\t');
      const [mode] = meta.split(/\s+/);
      return { mode, path: filePath };
    });
}

/**
 * Pure wiring check.
 *
 * @param {object} args
 * @param {string} args.hooksDir Configured `core.hooksPath` value.
 * @param {{ mode: string, path: string }[]} args.headEntries
 *   Tree entries at HEAD (see `listHeadEntries`).
 * @param {string[]} [args.requiredHooks]
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function assessHooksWiring({
  hooksDir,
  headEntries,
  requiredHooks = REQUIRED_HOOKS,
}) {
  const problems = [];

  if (!hooksDir) {
    problems.push(
      'core.hooksPath is not set, so git falls back to `.git/hooks` — '
        + 'which is untracked and empty in every fresh clone and worktree. '
        + 'Run `pnpm install` (or `node scripts/hooks/install-git-hooks.mjs`).',
    );
    return { ok: false, problems };
  }

  if (hooksDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(hooksDir)) {
    problems.push(
      `core.hooksPath is the absolute path "${hooksDir}". Absolute paths `
        + 'break on other machines and point linked worktrees back at '
        + `another tree. Use the repo-relative "${HOOKS_DIR}".`,
    );
  }

  const byPath = new Map(headEntries.map((entry) => [entry.path, entry]));

  for (const hook of requiredHooks) {
    const expected = `${hooksDir.replace(/\/+$/, '')}/${hook}`;
    const entry = byPath.get(expected);
    if (!entry) {
      problems.push(
        `${expected} is not tracked at HEAD. Git resolves core.hooksPath `
          + 'against the working tree it runs in, so an untracked hooks '
          + `directory means \`git worktree add\` produces a tree where the `
          + `${hook} gate silently does not run. Point core.hooksPath at `
          + `"${HOOKS_DIR}" and commit the hook there.`,
      );
      continue;
    }
    if (entry.mode !== EXECUTABLE_MODE) {
      problems.push(
        `${expected} is tracked with mode ${entry.mode}; git skips a hook `
          + `that is not executable. Run \`git update-index --chmod=+x `
          + `${expected}\`.`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Effective `core.hooksPath` for a working tree, or `null` if unset.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
export function readConfiguredHooksPath(cwd) {
  const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd,
    encoding: 'utf8',
    shell: isWindows,
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value === '' ? null : value;
}

/**
 * Checks the wiring of a real working tree.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, problems: string[], hooksDir: string | null }}
 */
export function verifyHooksWiring(repoRoot) {
  const hooksDir = readConfiguredHooksPath(repoRoot);
  const headEntries = listHeadEntries(repoRoot, hooksDir ?? HOOKS_DIR);
  const { ok, problems } = assessHooksWiring({ hooksDir, headEntries });
  return { ok, problems, hooksDir };
}
