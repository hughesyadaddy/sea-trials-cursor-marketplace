/**
 * Byte- and index-accurate fingerprints for scoped validation trust.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function git(repoRoot, args, opts = {}) {
  const result = spawnSync('git', args, {
    encoding: opts.binary ? 'buffer' : 'utf8',
    cwd: repoRoot,
    shell: isWindows,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * @param {string} repoRoot
 * @returns {Map<string, string>} repoRel → porcelain XY (first two cols)
 */
export function porcelainByPath(repoRoot) {
  const out = git(repoRoot, ['status', '--porcelain=v1', '-uall']);
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!out) return map;
  for (const line of String(out).split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let rel = line.slice(3).trim();
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop().trim();
    if (rel) map.set(rel.replace(/\\/g, '/'), xy);
  }
  return map;
}

/**
 * @param {string} repoRoot
 * @param {string} repoRel
 */
function blobDigest(repoRoot, repoRel, source) {
  if (source === 'missing') return 'missing';
  if (source === 'worktree') {
    const abs = path.join(repoRoot, repoRel);
    if (!fs.existsSync(abs)) return 'missing';
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
  const spec = source === 'index' ? `:${repoRel}` : `HEAD:${repoRel}`;
  const buf = git(repoRoot, ['show', spec], { binary: true });
  if (!buf) return 'missing';
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Paths with both index and worktree edits (partial staging) block validation.
 *
 * @param {string} repoRoot
 * @param {string[]} scopePaths
 */
export function assertNoPartialStaging(repoRoot, scopePaths) {
  const porc = porcelainByPath(repoRoot);
  const bad = [];
  for (const rel of scopePaths) {
    const xy = porc.get(rel.replace(/\\/g, '/'));
    if (!xy) continue;
    const indexTouched = xy[0] !== ' ' && xy[0] !== '?';
    const workTouched = xy[1] !== ' ' && xy[1] !== '?';
    if (indexTouched && workTouched) {
      bad.push(`${rel} (${xy})`);
    }
  }
  if (bad.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      'Partial staging in scoped paths — stage fully or reset before validate: '
      + bad.join(', '),
  };
}

/**
 * Fingerprint scoped paths using index + worktree + HEAD byte digests.
 *
 * @param {string} repoRoot
 * @param {string[]} repoRelPaths
 */
export function scopePathsByteFingerprint(repoRoot, repoRelPaths) {
  const sorted = [...new Set(repoRelPaths.map((p) => p.replace(/\\/g, '/').trim()).filter(Boolean))].sort();
  const porc = porcelainByPath(repoRoot);
  const hash = crypto.createHash('sha256');
  for (const rel of sorted) {
    const xy = porc.get(rel) ?? '  ';
    const head = blobDigest(repoRoot, rel, 'head');
    const index = blobDigest(repoRoot, rel, 'index');
    const worktree = blobDigest(repoRoot, rel, 'worktree');
    hash.update(`${rel}\t${xy}\thead=${head}\tidx=${index}\twt=${worktree}\n`);
  }
  return hash.digest('hex');
}

/**
 * All dirty / scoped paths from status (for gate token tree).
 *
 * @param {string} repoRoot
 */
export function allDirtyRepoPaths(repoRoot) {
  return [...porcelainByPath(repoRoot).keys()];
}

/**
 * @param {string} repoRoot
 */
export function workingTreeByteFingerprint(repoRoot) {
  return scopePathsByteFingerprint(repoRoot, allDirtyRepoPaths(repoRoot));
}
