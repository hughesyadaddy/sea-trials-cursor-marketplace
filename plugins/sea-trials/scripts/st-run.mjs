#!/usr/bin/env node
/**
 * Run a Sea Trials plugin hook against the current git checkout.
 *
 * Shipped in the sea-trials Cursor plugin — not in app repos.
 *
 *   node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" pr-review-push -- --pr 1663
 */
import { spawnSync } from 'node:child_process';
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

function main() {
  const { hook, args } = parseArgv(process.argv.slice(2));
  const script = path.join(pluginRoot, 'scripts/hooks', `${hook}.mjs`);
  const cwd = repoRoot();

  const result = spawnSync(process.execPath, [script, ...args], {
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

try {
  main();
} catch (err) {
  process.stderr.write(`st-run: ${err.message}\n`);
  process.exit(2);
}
