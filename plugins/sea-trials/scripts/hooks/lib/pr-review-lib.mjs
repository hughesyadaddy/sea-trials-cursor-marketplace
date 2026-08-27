/**
 * Shared helpers for pr-review-status / pr-review-loop / pr-review-push.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const reviewThreadsQueryFile = path.join(
  hooksDir,
  '..',
  'pr-review-threads-query.graphql',
);

/**
 * Merge-gate workflow only. Post-merge `Main Guardrails` (dart-full-audit,
 * manifest-freshness, …) can run 30–120 minutes and must not block PR
 * review loops — see docs/runbooks/LINT_STAGES.md.
 */
export const PR_CI_WORKFLOW = 'PR Checks';

/** Fast PR-check jobs — surfaced first in status output. */
export const LIGHT_CI_JOBS = [
  'ci-script-tests',
  'lint-migrations',
  'validate-migrations',
  'validate-sync-config',
  'forbid-legacy-push',
  'rest-schema-surface-freshness',
  'whitelabel-builder-tests',
  'edge-function-tests',
  'storage-migration-tests',
  'functions-sync-tests',
  'audit-unused-l10n',
  'dart-static',
];

export function getRepoRoot() {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (top.status === 0) {
    return (top.stdout ?? '').trim();
  }
  return process.cwd();
}

export function parsePrArgs(argv, defaults = {}) {
  const args = argv ?? process.argv.slice(2);
  const prFlag = args.indexOf('--pr');
  const intervalFlag = args.indexOf('--interval');
  const silenceFlag = args.indexOf('--silence');
  let prNumber;
  if (prFlag >= 0) {
    prNumber = Number(args[prFlag + 1]);
  } else if (defaults.pr != null) {
    prNumber = defaults.pr;
  } else {
    prNumber = resolvePrNumberFromBranch(getRepoRoot());
  }
  return {
    once: args.includes('--once'),
    json: args.includes('--json'),
    prNumber,
    intervalSec:
      intervalFlag >= 0 ? Number(args[intervalFlag + 1]) : (defaults.interval ?? 15),
    silenceMin:
      silenceFlag >= 0 ? Number(args[silenceFlag + 1]) : (defaults.silence ?? 30),
  };
}

/**
 * Resolve the open PR number for the current git branch via `gh`.
 * Callers must pass `--pr` when no PR exists for the branch.
 */
export function resolvePrNumberFromBranch(repoRoot) {
  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
    shell: isWindows,
    cwd: repoRoot,
  });
  const branch = (branchResult.stdout ?? '').trim();
  if (!branch) {
    throw new Error('Cannot resolve PR: detached HEAD. Pass --pr <number>.');
  }

  const prResult = ghSpawn(repoRoot, [
    'pr',
    'view',
    branch,
    '--json',
    'number',
  ]);
  if (prResult.status !== 0) {
    throw new Error(
      `Cannot resolve PR for branch "${branch}". Pass --pr <number>.`,
    );
  }

  const pr = parseGhStdout(prResult.stdout);
  if (!pr?.number) {
    throw new Error(
      `No open PR for branch "${branch}". Pass --pr <number>.`,
    );
  }
  return pr.number;
}

function ghSpawn(repoRoot, cmdArgs) {
  return spawnSync('gh', cmdArgs, {
    encoding: 'utf8',
    cwd: repoRoot,
    shell: isWindows,
  });
}

function parseGhStdout(stdout) {
  const trimmed = (stdout ?? '').trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

function splitTopLevelJsonObjects(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        parts.push(text.slice(start, i + 1));
      }
    }
  }

  return parts;
}

export function parseGhPaginatedGraphql(stdout) {
  const trimmed = (stdout ?? '').trim();
  if (!trimmed) {
    return [];
  }

  const lineChunks = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonChunks = [];
  for (const line of lineChunks) {
    try {
      JSON.parse(line);
      jsonChunks.push(line);
    } catch {
      jsonChunks.push(...splitTopLevelJsonObjects(line));
    }
  }

  const nodes = [];
  for (const chunk of jsonChunks) {
    const page = JSON.parse(chunk);
    const batch =
      page?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    nodes.push(...batch);
  }
  return nodes;
}

function ghJson(repoRoot, cmdArgs, { allowExitCodes = [] } = {}) {
  const result = ghSpawn(repoRoot, cmdArgs);
  if (result.status !== 0 && !allowExitCodes.includes(result.status ?? -1)) {
    const msg = result.stderr || result.stdout || 'gh failed';
    if (msg.includes('no checks reported')) {
      return null;
    }
    throw new Error(msg);
  }
  return parseGhStdout(result.stdout);
}

export function fetchPrMeta(repoRoot, prNumber) {
  return ghJson(repoRoot, [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,state,mergeable,mergeStateStatus,headRefName,headRefOid,url',
  ]);
}

export function fetchReviewThreads(repoRoot, prNumber) {
  const queryFile = reviewThreadsQueryFile;
  const result = ghSpawn(repoRoot, [
    'api',
    'graphql',
    '--paginate',
    '-F',
    `query=@${queryFile}`,
    '-F',
    'owner=hughesyadaddy',
    '-F',
    'repo=sea_trials_universal',
    '-F',
    `number=${prNumber}`,
  ]);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'gh graphql failed');
  }
  const nodes = parseGhPaginatedGraphql(result.stdout);
  const unresolved = nodes.filter((t) => !t.isResolved);
  return { total: nodes.length, unresolved, nodes };
}

/**
 * Keep only checks from the PR merge-gate workflow.
 *
 * @param {Array<{workflow?: string}>} checks
 */
export function filterPrGateChecks(checks) {
  return checks.filter((c) => c.workflow === PR_CI_WORKFLOW);
}

export function fetchCiChecks(repoRoot, prNumber) {
  const result = ghSpawn(repoRoot, [
    'pr',
    'checks',
    String(prNumber),
    '--json',
    'name,bucket,state,link,workflow',
  ]);

  let allChecks = [];
  if (result.status === 0 || result.status === 8) {
    allChecks = parseGhStdout(result.stdout) ?? [];
  } else {
    const msg = result.stderr || result.stdout || 'gh failed';
    if (msg.includes('no checks reported')) {
      allChecks = [];
    } else {
      throw new Error(msg);
    }
  }

  const checks = filterPrGateChecks(allChecks);
  const excludedCount = allChecks.length - checks.length;

  const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const pending = checks.filter((c) => c.bucket === 'pending');
  const passing = checks.filter(
    (c) => c.bucket === 'pass' || c.bucket === 'skipping',
  );
  const light = checks.filter((c) => LIGHT_CI_JOBS.includes(c.name));

  const awaiting = checks.length === 0;

  return {
    total: checks.length,
    excludedCount,
    failed,
    pending,
    passing,
    light,
    ok: !awaiting && failed.length === 0 && pending.length === 0,
    hasPending: awaiting || pending.length > 0 || result.status === 8,
    hasFailure: failed.length > 0,
    awaiting,
    checks,
    allChecks,
  };
}

/**
 * Repo-relative review-loop artifact paths from a PR head branch name.
 *
 * Pure helper — safe to unit-test without `gh` / GH_TOKEN (CI has neither).
 */
export function reviewArtifactPaths(headRefName, prNumber) {
  const scope = (headRefName ?? `pr-${prNumber}`).replace(/\//g, '-');
  const artifactDir = path.join('docs', 'code-review', scope);
  return {
    artifactDir,
    queue: path.join(artifactDir, 'pr-review-queue.json'),
    state: path.join(artifactDir, 'pr-review-state.json'),
    loopLog: path.join(artifactDir, `pr-${prNumber}-loop-log.txt`),
  };
}

export function reviewPaths(repoRoot, prNumber) {
  const pr = fetchPrMeta(repoRoot, prNumber);
  return reviewArtifactPaths(pr.headRefName, prNumber);
}

export function readRecordedPushIso(repoRoot, headRefOid, stateRelPath) {
  const statePath = path.join(repoRoot, stateRelPath);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (
      state.lastPush?.headRefOid === headRefOid &&
      typeof state.lastPush?.at === 'string'
    ) {
      return state.lastPush.at;
    }
  } catch {
    return null;
  }
  return null;
}

export function silenceWindowStartIso(repoRoot, prNumber, headRefOid, branch) {
  const { state } = reviewPaths(repoRoot, prNumber);
  const recorded = readRecordedPushIso(repoRoot, headRefOid, state);
  if (recorded) {
    return recorded;
  }

  spawnSync('git', ['fetch', 'origin', branch], {
    encoding: 'utf8',
    shell: isWindows,
    cwd: repoRoot,
  });

  // Committer time can predate the actual push; default to now so the
  // silence window is never already expired when we lack a push record.
  return new Date().toISOString();
}

/** @deprecated Use silenceWindowStartIso */
export function remoteHeadPushIso(repoRoot, branch, headRefOid) {
  if (headRefOid) {
    return silenceWindowStartIso(repoRoot, null, headRefOid, branch);
  }
  return (
    spawnSync('git', ['log', '-1', '--format=%cI', `origin/${branch}`], {
      encoding: 'utf8',
      shell: isWindows,
      cwd: repoRoot,
    }).stdout ?? ''
  ).trim();
}

export function buildReviewSnapshot(repoRoot, prNumber) {
  const pr = fetchPrMeta(repoRoot, prNumber);
  const threads = fetchReviewThreads(repoRoot, prNumber);
  const ci = fetchCiChecks(repoRoot, prNumber);

  return {
    at: new Date().toISOString(),
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
    },
    threads: {
      total: threads.total,
      unresolvedCount: threads.unresolved.length,
      unresolved: threads.unresolved.map((t) => ({
        id: t.id,
        path: t.path,
        line: t.line,
        databaseId: t.comments.nodes[0]?.databaseId ?? null,
        author: t.comments.nodes[0]?.author?.login ?? null,
        preview: (t.comments.nodes[0]?.body ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 160),
        body: t.comments.nodes[0]?.body ?? '',
      })),
    },
    ci: {
      total: ci.total,
      excludedCount: ci.excludedCount,
      pending: ci.pending.map((c) => c.name),
      failed: ci.failed.map((c) => ({ name: c.name, link: c.link })),
      light: ci.light.map((c) => ({
        name: c.name,
        bucket: c.bucket,
        link: c.link,
      })),
      ok: ci.ok,
      hasPending: ci.hasPending,
      hasFailure: ci.hasFailure,
    },
  };
}

export function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Keep [lastPush] when snapshot polls overwrite the state file. */
export function mergeRecordedLastPush(statePath, snapshot) {
  const merged = { ...snapshot };
  if (!fs.existsSync(statePath)) {
    return merged;
  }
  try {
    const prior = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (
      prior.lastPush?.headRefOid === snapshot.pr.headRefOid &&
      typeof prior.lastPush?.at === 'string'
    ) {
      merged.lastPush = prior.lastPush;
    }
  } catch {
    return merged;
  }
  return merged;
}

export function writeReviewState(statePath, snapshot) {
  writeJson(statePath, mergeRecordedLastPush(statePath, snapshot));
}

export function evaluateSnapshot(snapshot) {
  if (snapshot.threads.unresolvedCount > 0) {
    return { ok: false, reason: 'threads', exitCode: 2 };
  }
  if (snapshot.ci.hasFailure) {
    return { ok: false, reason: 'ci-fail', exitCode: 3 };
  }
  if (snapshot.ci.hasPending) {
    return { ok: false, reason: 'ci-pending', exitCode: 8 };
  }
  return { ok: true, reason: 'clean', exitCode: 0 };
}

export function runLocalPrepush(repoRoot) {
  const result = spawnSync('pnpm', ['agent-prepush'], {
    encoding: 'utf8',
    cwd: repoRoot,
    shell: isWindows,
    stdio: 'pipe',
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runGitPush(repoRoot, branch) {
  const result = spawnSync('git', ['push', 'origin', `HEAD:${branch}`], {
    encoding: 'utf8',
    cwd: repoRoot,
    shell: isWindows,
    stdio: 'pipe',
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

