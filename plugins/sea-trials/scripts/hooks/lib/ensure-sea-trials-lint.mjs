import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getSeaTrialsLintCmd,
  hasSeaTrialsLintBinary,
} from './resolve-sea-trials-lint.mjs';

const isWindows = process.platform === 'win32';

/**
 * Newest mtime under the linter's source tree (src/ + Cargo files).
 * Git stamps files at checkout time, so pulling new lint rules makes
 * the source newer than a binary built before the pull.
 *
 * @param {string} root
 * @returns {number} epoch ms, or 0 when the source tree is absent
 */
function newestLintSourceMtimeMs(root) {
  const toolDir = path.join(root, 'tools', 'sea-trials-lint');
  const targets = [
    path.join(toolDir, 'Cargo.toml'),
    path.join(toolDir, 'Cargo.lock'),
    path.join(toolDir, 'src'),
  ];
  let newest = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  };
  for (const target of targets) walk(target);
  return newest;
}

/**
 * True when the resolved binary is OLDER than the newest lint source
 * file — i.e. it predates rules/allowlists now in the tree. A stale
 * binary silently enforces outdated rules (observed 2026-07-08: a
 * May 26 binary failed a push on an import the July 7 allowlist
 * exempts, 20 minutes into the gate).
 *
 * @param {string} root
 * @returns {boolean}
 */
function seaTrialsLintBinaryIsStale(root) {
  let binPath;
  try {
    [binPath] = getSeaTrialsLintCmd(root);
  } catch {
    return false;
  }
  try {
    const binMtime = fs.statSync(binPath).mtimeMs;
    const srcMtime = newestLintSourceMtimeMs(root);
    return srcMtime > 0 && binMtime < srcMtime;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} repoRoot
 * @returns {string}
 */
function assertRepoRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new TypeError('repoRoot must be a non-empty string');
  }
  return path.resolve(repoRoot);
}

/**
 * @param {unknown} repoRoot
 * @returns {boolean}
 */
export function buildSeaTrialsLintFromSource(repoRoot) {
  const root = assertRepoRoot(repoRoot);
  const toolDir = path.join(root, 'tools', 'sea-trials-lint');
  const cargoToml = path.join(toolDir, 'Cargo.toml');
  if (!fs.existsSync(cargoToml)) {
    return false;
  }
  const r = spawnSync('cargo', ['build', '--release'], {
    cwd: toolDir,
    stdio: 'inherit',
    shell: isWindows,
  });
  if (r.error != null || r.status !== 0) {
    return false;
  }
  if (!hasSeaTrialsLintBinary(root)) {
    return false;
  }
  const ext = isWindows ? '.exe' : '';
  const built = path.join(toolDir, 'target', 'release', `sea-trials-lint${ext}`);
  if (!fs.existsSync(built)) {
    return false;
  }
  const verify = spawnSync(built, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
  });
  if (verify.error != null || verify.status !== 0) {
    return false;
  }
  // The resolver prefers bin/ over target/release, so a stale copy in
  // bin/ would shadow the fresh build — refresh it when present.
  const binCopy = path.join(toolDir, 'bin', `sea-trials-lint${ext}`);
  if (fs.existsSync(binCopy)) {
    try {
      fs.copyFileSync(built, binCopy);
    } catch {
      // Copy may fail while the old binary is executing; the fresh
      // target/release build still exists as the second candidate.
    }
  }
  return true;
}

/**
 * @param {unknown} repoRoot
 * @param {{ soft?: boolean, forceRebuild?: boolean }} [options]
 * @returns {boolean}
 */
export function ensureSeaTrialsLint(repoRoot, options = {}) {
  const root = assertRepoRoot(repoRoot);
  const soft = options.soft === true;
  const forceRebuild = options.forceRebuild === true;
  if (hasSeaTrialsLintBinary(root)) {
    if (forceRebuild || seaTrialsLintBinaryIsStale(root)) {
      if (forceRebuild && !seaTrialsLintBinaryIsStale(root)) {
        process.stderr.write(
          '⚙️  sea-trials-lint: forcing rebuild (lint source changed vs base)...\n',
        );
      } else {
        process.stderr.write(
          '⚙️  sea-trials-lint binary predates the current lint source; '
          + 'rebuilding...\n',
        );
      }
      if (buildSeaTrialsLintFromSource(root)) {
        process.stderr.write('✅ sea-trials-lint rebuilt from source.\n');
      } else {
        // Hard-fail: a stale binary silently drops newly ported rules
        // (e.g. former check_dart_only). Rebuild or install Rust.
        const msg =
          'sea-trials-lint rebuild failed; refusing to use a stale binary.\n'
          + '  Install Rust: https://rustup.rs/\n'
          + '  Then: cd tools/sea-trials-lint && cargo build --release\n'
          + '  Or: node scripts/hooks/ensure-sea-trials-lint.mjs';
        if (soft) {
          process.stderr.write(`⚠️  ${msg}\n`);
          return false;
        }
        throw new Error(msg);
      }
    }
    return true;
  }

  const installScript = path.join(root, 'scripts', 'hooks', 'install-sea-trials-lint.mjs');
  if (!forceRebuild && fs.existsSync(installScript)) {
    process.stderr.write('⚙️  sea-trials-lint not found; trying GitHub release download...\n');
    const dl = spawnSync(process.execPath, [installScript], {
      cwd: root,
      stdio: 'inherit',
      shell: isWindows,
    });
    if (dl.error == null && dl.status === 0 && hasSeaTrialsLintBinary(root)) {
      return true;
    }
  } else if (forceRebuild) {
    process.stderr.write(
      '⚙️  sea-trials-lint: lint source in diff; building from source...\n',
    );
  }

  process.stderr.write('⚙️  sea-trials-lint: building from source with Cargo...\n');
  if (buildSeaTrialsLintFromSource(root)) {
    process.stderr.write('✅ sea-trials-lint built locally (tools/sea-trials-lint/target/release).\n');
    return true;
  }

  const msg =
    'Could not obtain sea-trials-lint (no release asset, or Cargo build failed).\n' +
    '  Install Rust: https://rustup.rs/\n' +
    '  Then: cd tools/sea-trials-lint && cargo build --release';

  if (soft) {
    process.stderr.write(`⚠️  ${msg}\n`);
    return false;
  }
  throw new Error(msg);
}
