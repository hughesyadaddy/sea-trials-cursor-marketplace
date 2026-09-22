/**
 * Pin shard env vars to matrix lengths in CI workflows.
 *
 * GitHub Actions cannot report a matrix's length back to the job, so
 * the shard count is duplicated: the matrix drives how many runners
 * start, and the env var tells each one how to slice the workspace.
 * A mismatch is silent and one-directional in the dangerous way — set
 * the env var too low and some packages are never analyzed while every
 * shard still exits green.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRepoRoot } from '../hooks/lib/plugin-paths.mjs';

const MAIN_GUARDRAILS_WORKFLOW = '.github/workflows/main-guardrails.yml';
const PR_CHECKS_WORKFLOW = '.github/workflows/pr-checks.yml';

/**
 * @param {string} yaml
 * @param {string} envName
 * @returns {number}
 */
export function parseShardTotalEnv(yaml, envName) {
  const re = new RegExp(`^\\s*${envName}:\\s*(\\d+)\\s*$`, 'm');
  const m = yaml.match(re);
  if (!m) {
    throw new Error(`${envName} not found in workflow env`);
  }
  return Number(m[1]);
}

/**
 * @param {string} yaml
 * @param {string} jobId
 * @returns {number}
 */
export function parseMatrixShardCountForJob(yaml, jobId) {
  const jobRe = new RegExp(
    `^  ${jobId}:[\\s\\S]*?^\\s*matrix:\\s*$[\\s\\S]*?^\\s*shard:\\s*\\[([^\\]]+)\\]\\s*$`,
    'm',
  );
  const m = yaml.match(jobRe);
  if (!m) {
    throw new Error(`${jobId} shard matrix not found in workflow`);
  }
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/**
 * @param {{
 *   workflowPath: string,
 *   envName: string,
 *   jobId: string,
 *   repoRoot?: string,
 * }} opts
 */
export function assertWorkflowShards({
  workflowPath,
  envName,
  jobId,
  repoRoot = resolveRepoRoot(),
}) {
  const yaml = fs.readFileSync(path.join(repoRoot, workflowPath), 'utf8');
  const shardTotal = parseShardTotalEnv(yaml, envName);
  const matrixCount = parseMatrixShardCountForJob(yaml, jobId);
  if (shardTotal !== matrixCount) {
    throw new Error(
      `${envName} is ${shardTotal} but ${jobId} declares ${matrixCount} ` +
        `shard(s) in ${workflowPath}. They must match, or the lane leaves ` +
        'packages unanalyzed while still reporting green.',
    );
  }
  return { shardTotal, matrixCount, workflowPath, envName, jobId };
}

/**
 * @param {string} [repoRoot]
 */
export function assertAuditShards(repoRoot = resolveRepoRoot()) {
  return assertWorkflowShards({
    workflowPath: MAIN_GUARDRAILS_WORKFLOW,
    envName: 'AUDIT_SHARD_TOTAL',
    jobId: 'dart-full-audit',
    repoRoot,
  });
}

/**
 * @param {string} [repoRoot]
 */
export function assertPrAnalyzeShards(repoRoot = resolveRepoRoot()) {
  return assertWorkflowShards({
    workflowPath: PR_CHECKS_WORKFLOW,
    envName: 'PR_ANALYZE_SHARD_TOTAL',
    jobId: 'dart-analyze-shard',
    repoRoot,
  });
}

/** @param {string} yaml */
export function parseShardTotal(yaml) {
  return parseShardTotalEnv(yaml, 'AUDIT_SHARD_TOTAL');
}

/** @param {string} yaml */
export function parseMatrixShardCount(yaml) {
  return parseMatrixShardCountForJob(yaml, 'dart-full-audit');
}

/* c8 ignore start */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const audit = assertAuditShards();
    const prAnalyze = assertPrAnalyzeShards();
    process.stdout.write(
      `assert-audit-shards: ${audit.envName}=${audit.shardTotal} matches ` +
        `${audit.jobId} in ${audit.workflowPath}.\n`,
    );
    process.stdout.write(
      `assert-audit-shards: ${prAnalyze.envName}=${prAnalyze.shardTotal} ` +
        `matches ${prAnalyze.jobId} in ${prAnalyze.workflowPath}.\n`,
    );
  } catch (err) {
    process.stderr.write(`assert-audit-shards: ${err.message}\n`);
    process.exit(1);
  }
}
/* c8 ignore stop */
