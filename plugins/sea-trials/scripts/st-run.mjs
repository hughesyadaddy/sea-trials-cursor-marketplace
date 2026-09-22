#!/usr/bin/env node
/**
 * Run a Sea Trials plugin hook against the current git checkout.
 *
 * Shipped in the sea-trials Cursor plugin — not in app repos.
 *
 *   node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" pr-review-push -- --pr 1663
 *
 * Hook names resolve to `scripts/hooks/<name>.mjs`. A `ci/` prefix
 * resolves into `scripts/ci/` instead — `<name>.mjs` via node, or
 * `<name>.sh` via bash when only the shell script exists:
 *
 *   node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" ci/assert-workflow-paths
 *   node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" ci/run-lane -- --lane static
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function repoRoot() {
  if (process.env.ST_REPO_ROOT?.trim()) {
    return path.resolve(process.env.ST_REPO_ROOT.trim());
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (top.status !== 0) {
    throw new Error('st-run: not inside a git repository');
  }
  return (top.stdout ?? '').trim();
}

function parseArgv(argv) {
  const hook = argv[0];
  if (!hook || hook.startsWith('-')) {
    throw new Error(
      'Usage: st-run <hook-name> [-- extra args…]\n'
        + 'Example: st-run pr-review-push -- --pr 1663',
    );
  }
  let rest = argv.slice(1);
  if (rest[0] === '--') rest = rest.slice(1);
  return { hook, args: rest };
}

/**
 * Map a hook name to `{ cmd, argv }` for the script it names.
 *
 * @param {string} hook
 * @param {string} root plugin root
 */
export function resolveHookCommand(hook, root = pluginRoot) {
  if (hook.includes('..')) {
    throw new Error(`st-run: invalid hook name '${hook}'`);
  }
  if (hook.startsWith('ci/')) {
    const stem = path.join(root, 'scripts/ci', hook.slice('ci/'.length));
    if (fs.existsSync(`${stem}.mjs`)) {
      return { cmd: process.execPath, argv: [`${stem}.mjs`] };
    }
    if (fs.existsSync(`${stem}.sh`)) {
      return { cmd: 'bash', argv: [`${stem}.sh`] };
    }
    throw new Error(`st-run: no scripts/ci/${hook.slice(3)}.{mjs,sh} in plugin`);
  }
  return {
    cmd: process.execPath,
    argv: [path.join(root, 'scripts/hooks', `${hook}.mjs`)],
  };
}

function main() {
  const { hook, args } = parseArgv(process.argv.slice(2));
  const { cmd, argv } = resolveHookCommand(hook);
  const cwd = repoRoot();

  const result = spawnSync(cmd, [...argv, ...args], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ST_PLUGIN_ROOT: pluginRoot,
      ST_REPO_ROOT: cwd,
    },
  });
  process.exit(result.status ?? 1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`st-run: ${err.message}\n`);
    process.exit(2);
  }
}
