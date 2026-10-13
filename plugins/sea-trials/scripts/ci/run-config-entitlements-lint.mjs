/**
 * CI entry for codemagic + App Attest entitlements lint.
 *
 * Executable logic lives in the plugin; the app repo holds only parity
 * tests (optional fixtures later).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const pyScript = path.join(pluginDir, 'promotion', 'config_entitlements_lint.py');

/** @returns {number} exit code */
export function runSelfTest() {
  const r = spawnSync('python3', [pyScript, '--self-test'], {
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

function runLint(repoRoot) {
  const r = spawnSync('python3', [pyScript], {
    cwd: repoRoot,
    env: { ...process.env, REPO_ROOT: repoRoot },
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    return runSelfTest();
  }

  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  return runLint(repoRoot);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
