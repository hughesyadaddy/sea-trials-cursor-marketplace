/**
 * Drop review-loop artifacts for PRs that are no longer open.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} repoRoot
 * @param {string} absPath
 */
function isGitTracked(repoRoot, absPath) {
  const rel = path.relative(repoRoot, absPath);
  if (!rel || rel.startsWith('..')) return false;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', rel], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

const PR_ARTIFACT_RE = /^pr-(\d+)-/;

const LOOP_STATE_FILES = new Set([
  'pr-review-queue.json',
  'pr-review-state.json',
]);

/**
 * @param {string} repoRoot
 * @returns {Map<number, string[]>} prNumber → absolute file paths
 */
export function collectReviewArtifactFiles(repoRoot) {
  const reviewRoot = path.join(repoRoot, 'docs', 'code-review');
  /** @type {Map<number, string[]>} */
  const byPr = new Map();
  if (!fs.existsSync(reviewRoot)) {
    return byPr;
  }

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const match = PR_ARTIFACT_RE.exec(entry.name);
      if (!match) continue;
      const prNumber = Number(match[1]);
      if (!Number.isFinite(prNumber)) continue;
      const list = byPr.get(prNumber) ?? [];
      list.push(abs);
      byPr.set(prNumber, list);
    }
  };

  walk(reviewRoot);
  return byPr;
}

/**
 * PR numbers referenced by `pr-N-*` artifacts in one review scope dir.
 *
 * @param {string} dir
 * @returns {Set<number>}
 */
/**
 * True when shared loop JSON in [dir] belongs to an active PR number.
 *
 * @param {string} dir
 * @param {Set<number>} active
 */
function loopStateBelongsToActivePr(dir, active) {
  const statePath = path.join(dir, 'pr-review-state.json');
  if (!fs.existsSync(statePath)) {
    return false;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const n = raw?.pr?.number;
    if (Number.isFinite(n) && active.has(n)) {
      return true;
    }
  } catch {
    // ignore malformed state
  }
  return false;
}

function prNumbersInReviewDir(dir) {
  /** @type {Set<number>} */
  const nums = new Set();
  if (!fs.existsSync(dir)) {
    return nums;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = PR_ARTIFACT_RE.exec(entry.name);
    if (!match) continue;
    const prNumber = Number(match[1]);
    if (Number.isFinite(prNumber)) {
      nums.add(prNumber);
    }
  }
  return nums;
}

/**
 * @param {string} repoRoot
 * @param {{
 *   activePrNumbers?: number[],
 *   resolveState?: (prNumber: number) => string | null | undefined,
 * }} [opts]
 * @returns {{ pruned: number[], skipped: number[] }}
 */
export function pruneStaleReviewArtifacts(repoRoot, opts = {}) {
  const active = new Set(opts.activePrNumbers ?? []);
  const resolveState =
    opts.resolveState ??
    (() => {
      throw new Error('pruneStaleReviewArtifacts requires resolveState');
    });

  const byPr = collectReviewArtifactFiles(repoRoot);
  /** @type {number[]} */
  const pruned = [];
  /** @type {number[]} */
  const skipped = [];

  for (const [prNumber, files] of byPr.entries()) {
    if (active.has(prNumber)) {
      skipped.push(prNumber);
      continue;
    }
    const state = (resolveState(prNumber) ?? '').toUpperCase();
    if (state !== 'MERGED' && state !== 'CLOSED') {
      skipped.push(prNumber);
      continue;
    }
    const dirs = new Set(files.map((file) => path.dirname(file)));
    /** @type {string[]} */
    const toDelete = [...files];
    for (const dir of dirs) {
      const prsInDir = prNumbersInReviewDir(dir);
      const otherOpen = [...prsInDir].some((other) => {
        if (other === prNumber) return false;
        if (active.has(other)) return true;
        const otherState = (resolveState(other) ?? '').toUpperCase();
        return otherState !== 'MERGED' && otherState !== 'CLOSED';
      });
      if (otherOpen || loopStateBelongsToActivePr(dir, active)) {
        continue;
      }
      for (const name of LOOP_STATE_FILES) {
        const abs = path.join(dir, name);
        if (fs.existsSync(abs)) {
          toDelete.push(abs);
        }
      }
    }
    for (const file of new Set(toDelete)) {
      if (isGitTracked(repoRoot, file)) {
        continue;
      }
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
    }
    pruned.push(prNumber);
  }

  return { pruned, skipped };
}
