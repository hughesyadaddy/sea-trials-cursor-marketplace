#!/usr/bin/env node
/**
 * Install the prebuilt `sea-trials-lint` binary for this platform into
 * `<repo>/tools/sea-trials-lint/bin`, falling back to a Cargo build.
 *
 *   node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" install-sea-trials-lint
 *
 * The release repo is taken from the checkout's `origin` remote.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { buildSeaTrialsLintFromSource } from './lib/ensure-sea-trials-lint.mjs';
import { resolveRepoRoot } from './lib/plugin-paths.mjs';
import { resolveGithubOwnerRepo } from './lib/resolve-github-repo.mjs';

const PLATFORM_MAP = {
  'darwin-arm64': 'sea-trials-lint-darwin-arm64',
  'darwin-x64': 'sea-trials-lint-darwin-x64',
  'linux-arm64': 'sea-trials-lint-linux-arm64',
  'linux-x64': 'sea-trials-lint-linux-x64',
  'win32-x64': 'sea-trials-lint-win32-x64',
  'win32-arm64': 'sea-trials-lint-win32-arm64',
};

const isWindows = process.platform === 'win32';
const ext = isWindows ? '.exe' : '';

const MAX_REDIRECTS = 10;

/**
 * @param {string} url
 * @param {number} [depth]
 * @returns {Promise<unknown>}
 */
function fetchJson(url, depth = 0) {
  if (depth > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many HTTP redirects'));
  }
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'sea-trials-lint-installer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, depth + 1).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (parseErr) {
          reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
        }
      });
    }).on('error', reject);
  });
}

/**
 * @param {string} url
 * @param {string} dest
 * @param {number} [depth]
 * @returns {Promise<void>}
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, d) => {
      if (d > MAX_REDIRECTS) {
        reject(new Error('Too many HTTP redirects'));
        return;
      }
      https.get(u, { headers: { 'User-Agent': 'sea-trials-lint-installer' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location, d + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          writeFileSync(dest, Buffer.concat(chunks));
          resolve();
        });
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  const { owner: OWNER, repo: REPO } = resolveGithubOwnerRepo();
  const repoRoot = path.resolve(resolveRepoRoot());
  const binDir = path.join(repoRoot, 'tools', 'sea-trials-lint', 'bin');
  const binaryPath = path.join(binDir, `sea-trials-lint${ext}`);
  const versionPath = path.join(binDir, '.version');

  const platformKey = `${process.platform}-${process.arch}`;
  let assetName = PLATFORM_MAP[platformKey];

  if (!assetName) {
    process.stderr.write(
      `⚠️  sea-trials-lint: unsupported platform '${platformKey}'. Trying build from source...\n`,
    );
    if (buildSeaTrialsLintFromSource(repoRoot)) {
      process.stderr.write('✅ sea-trials-lint built locally.\n');
      process.exit(0);
    }
    process.stderr.write('❌ sea-trials-lint: build failed. Install Rust: https://rustup.rs/\n');
    process.exit(1);
  }

  if (isWindows) {
    assetName += '.exe';
  }

  let tag = null;
  const ghResult = spawnSync('gh', [
    'api', `repos/${OWNER}/${REPO}/releases/latest`,
    '--jq', '.tag_name',
  ], { encoding: 'utf8', shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'] });

  if (ghResult.status === 0 && ghResult.stdout?.trim()) {
    tag = ghResult.stdout.trim();
  } else {
    try {
      const release = await fetchJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
      const t = release?.tag_name;
      tag = typeof t === 'string' ? t.trim() : '';
    } catch {
      process.stderr.write('⚠️  sea-trials-lint: no GitHub releases found; building from source...\n');
      if (buildSeaTrialsLintFromSource(repoRoot)) {
        process.stderr.write('✅ sea-trials-lint built locally.\n');
        process.exit(0);
      }
      process.stderr.write('❌ sea-trials-lint: build failed. Install Rust: https://rustup.rs/\n');
      process.exit(1);
    }
  }

  if (tag == null || tag === '') {
    process.stderr.write('⚠️  sea-trials-lint: empty release tag; building from source...\n');
    if (buildSeaTrialsLintFromSource(repoRoot)) {
      process.stderr.write('✅ sea-trials-lint built locally.\n');
      process.exit(0);
    }
    process.stderr.write('❌ sea-trials-lint: build failed. Install Rust: https://rustup.rs/\n');
    process.exit(1);
  }

  if (existsSync(versionPath)) {
    const installed = readFileSync(versionPath, 'utf8').trim();
    if (installed === tag && existsSync(binaryPath)) {
      process.stderr.write(`✅ sea-trials-lint ${tag} already installed.\n`);
      process.exit(0);
    }
  }

  process.stderr.write(`📦 Installing sea-trials-lint ${tag} for ${platformKey}...\n`);

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const dlResult = spawnSync('gh', [
    'release', 'download', tag,
    '-p', assetName,
    '-D', binDir,
    '--clobber',
  ], { encoding: 'utf8', shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'] });

  if (dlResult.status === 0) {
    const downloadedPath = path.join(binDir, assetName);
    if (downloadedPath !== binaryPath && existsSync(downloadedPath)) {
      const { renameSync } = await import('node:fs');
      renameSync(downloadedPath, binaryPath);
    }
  } else {
    try {
      const release = await fetchJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find((a) => a && a.name === assetName);
      if (!asset || typeof asset.browser_download_url !== 'string') {
        throw new Error(`Asset '${assetName}' not found in release ${tag}`);
      }
      await downloadFile(asset.browser_download_url, binaryPath);
    } catch (err) {
      if (existsSync(binaryPath)) unlinkSync(binaryPath);
      process.stderr.write(`❌ sea-trials-lint: download failed: ${errorMessage(err)}\n`);
      process.stderr.write('⚙️  Trying Cargo build from source...\n');
      if (buildSeaTrialsLintFromSource(repoRoot)) {
        process.stderr.write('✅ sea-trials-lint built locally.\n');
        process.exit(0);
      }
      process.stderr.write('❌ sea-trials-lint: build failed. Install Rust: https://rustup.rs/\n');
      process.exit(1);
    }
  }

  if (!isWindows) {
    chmodSync(binaryPath, 0o755);
  }

  const verify = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
  });
  if (verify.error != null || verify.status !== 0) {
    if (existsSync(binaryPath)) unlinkSync(binaryPath);
    process.stderr.write('❌ sea-trials-lint: binary verification failed.\n');
    process.exit(1);
  }

  writeFileSync(versionPath, tag);
  process.stderr.write(`✅ sea-trials-lint ${tag} installed successfully.\n`);
}

main().catch((err) => {
  process.stderr.write(`❌ sea-trials-lint install error: ${errorMessage(err)}\n`);
  process.exit(1);
});
