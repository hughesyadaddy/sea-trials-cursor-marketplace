/**
 * Partition repo-relative changed paths for per-commit scoped validation.
 */
import { isLintableDartPath } from './artifact-paths.mjs';

const DOCS_PREFIXES = ['docs/', 'sprint_planning/'];
const DOC_SUFFIXES = ['.md', '.mdx', '.txt'];

/**
 * @param {string} repoRel
 */
export function classifyRepoPath(repoRel) {
  const norm = repoRel.replace(/\\/g, '/').trim();
  if (!norm) return 'empty';
  if (isLintableDartPath(norm)) return 'dart';
  if (DOC_SUFFIXES.some((s) => norm.endsWith(s)) || DOCS_PREFIXES.some((p) => norm.startsWith(p))) {
    return 'docs';
  }
  if (
    norm.startsWith('functions/')
    || norm.startsWith('web/')
    || norm.startsWith('supabase/')
    || norm.startsWith('powersync/')
    || norm.endsWith('.mjs')
    || norm.endsWith('.js')
    || norm.endsWith('.ts')
    || norm.endsWith('.json')
    || norm.endsWith('.yaml')
    || norm.endsWith('.yml')
    || norm.endsWith('.sh')
    || norm.startsWith('scripts/')
    || norm.startsWith('tools/')
    || norm.startsWith('plugins/')
  ) {
    return 'nondart';
  }
  return 'other';
}

/**
 * @param {string[]} repoRelPaths
 */
export function partitionRepoPaths(repoRelPaths) {
  /** @type {string[]} */
  const dart = [];
  /** @type {string[]} */
  const nondart = [];
  /** @type {string[]} */
  const docs = [];
  /** @type {string[]} */
  const other = [];
  for (const p of repoRelPaths) {
    const kind = classifyRepoPath(p);
    if (kind === 'dart') dart.push(p);
    else if (kind === 'nondart') nondart.push(p);
    else if (kind === 'docs') docs.push(p);
    else other.push(p);
  }
  return { dart, nondart, docs, other };
}

/**
 * @param {string[]} repoRelPaths
 */
export function isDocsOnlySet(repoRelPaths) {
  if (repoRelPaths.length === 0) return false;
  return repoRelPaths.every((p) => classifyRepoPath(p) === 'docs');
}
