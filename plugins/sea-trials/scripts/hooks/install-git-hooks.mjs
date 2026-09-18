#!/usr/bin/env node
/**
 * Wires git hooks for this clone. Runs from the root `prepare` script,
 * i.e. on every `pnpm install`, and replaces `husky`'s installer.
 *
 * Husky pointed `core.hooksPath` at `.husky/_`, a generated directory
 * it self-ignores. Git resolves that relative path against whichever
 * working tree the command runs in, so linked worktrees — which
 * `.cursor/rules/git-safe-worktree.mdc` *requires* agents to use —
 * found no hook there and pushed with the whole gate silently absent.
 * See `lib/git-hooks-wiring.mjs` for the full contract.
 *
 * This installer points `core.hooksPath` at the tracked `.husky`
 * directory instead, so no per-worktree step exists to forget, then
 * verifies the result and fails the install loudly if it did not take.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HOOKS_DIR,
  REQUIRED_HOOKS,
  verifyHooksWiring,
} from './lib/git-hooks-wiring.mjs';

const isWindows = process.platform === 'win32';

function git(args, options = {}) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    shell: isWindows,
    ...options,
  });
}

const repoRoot = (() => {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status === 0 && (top.stdout ?? '').trim()) {
    return (top.stdout ?? '').trim();
  }
  return process.cwd();
})();

function fail(lines) {
  process.stderr.write(`\n❌ Git hooks are not wired.\n${lines}\n`);
  process.exit(1);
}

// A worktree-scoped override wins over the shared config and is the
// one value we cannot express relatively — agent harnesses have been
// observed writing an absolute path here that points back at another
// tree, which disables every hook just as thoroughly. Only meaningful
// when `extensions.worktreeConfig` is on; a no-op otherwise.
function clearWorktreeOverride() {
  const scoped = git(['config', '--worktree', '--get', 'core.hooksPath'], {
    cwd: repoRoot,
  });
  if (scoped.status !== 0) return false;
  const value = (scoped.stdout ?? '').trim();
  if (value === '' || value === HOOKS_DIR) return false;
  git(['config', '--worktree', '--unset-all', 'core.hooksPath'], {
    cwd: repoRoot,
  });
  process.stdout.write(
    `🧹 Removed worktree-scoped core.hooksPath "${value}" — it overrode `
      + `the shared "${HOOKS_DIR}".\n`,
  );
  return true;
}

// Husky's generated shim directory is now a decoy: it still looks like
// the hooks live there, and a stray `npx husky` would re-point
// core.hooksPath back at it. Remove it so there is one hooks
// directory, not two. Guarded on husky's own marker files so this
// never deletes something a human put there.
function removeHuskyShimDirectory() {
  const shimDir = path.join(repoRoot, '.husky', '_');
  const markers = ['h', 'husky.sh'];
  if (!fs.existsSync(shimDir)) return false;
  const isHuskyGenerated = markers.some((marker) =>
    fs.existsSync(path.join(shimDir, marker)),
  );
  if (!isHuskyGenerated) return false;
  fs.rmSync(shimDir, { recursive: true, force: true });
  process.stdout.write(
    '🧹 Removed husky\'s generated .husky/_ shim directory (worktrees '
      + 'never checked it out).\n',
  );
  return true;
}

// Git skips a hook that is not executable. Tracked mode is 100755, so
// this only matters for a stray local chmod — cheap insurance either
// way, and `git ls-tree` mode drift is caught by the test.
function ensureHooksExecutable() {
  if (isWindows) return;
  for (const hook of REQUIRED_HOOKS) {
    const hookPath = path.join(repoRoot, HOOKS_DIR, hook);
    if (!fs.existsSync(hookPath)) continue;
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      // Non-fatal: verifyHooksWiring reports what actually matters.
    }
  }
}

clearWorktreeOverride();

const set = git(['config', '--local', 'core.hooksPath', HOOKS_DIR], {
  cwd: repoRoot,
});
if (set.status !== 0) {
  fail(
    `   \`git config --local core.hooksPath ${HOOKS_DIR}\` failed:\n`
      + `   ${(set.stderr ?? '').trim()}\n`,
  );
}

removeHuskyShimDirectory();
ensureHooksExecutable();

const { ok, problems, hooksDir } = verifyHooksWiring(repoRoot);

if (hooksDir !== HOOKS_DIR) {
  fail(
    `   core.hooksPath reads back as "${hooksDir}" instead of `
      + `"${HOOKS_DIR}".\n`
      + '   Something outside this repo overrides it (a --worktree, --global\n'
      + '   or --system value). Inspect with:\n'
      + '     git config --show-origin --get-all core.hooksPath\n',
  );
}

if (!ok) {
  fail(problems.map((problem) => `   • ${problem}`).join('\n'));
}

process.stdout.write(
  `✅ Git hooks wired: core.hooksPath=${HOOKS_DIR} `
    + `(${REQUIRED_HOOKS.join(', ')}) — tracked, so linked worktrees run `
    + 'the same gate.\n',
);
