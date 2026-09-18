#!/usr/bin/env node
/**
 * Local PR CI parity gate — path-filtered PR Checks lanes before push.
 *
 * Contract: NEVER `git push` until this passes (via `pnpm pr-review-push`).
 *
 * Usage:
 *   pnpm pr-local-ci -- --pr 1640
 *   pnpm pr-local-ci -- --base origin/dev
 *   pnpm pr-local-ci -- --pr 1640 --list-tasks
 *   pnpm pr-local-ci -- --pr 1640 --lane dart-static
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolvePromotionBaseRef } from './lib/check-plan.mjs';
import { runParallelLimited } from './lib/parallel.mjs';

const isWindows = process.platform === 'win32';

function resolveRepoRoot() {
  if (process.env.ST_REPO_ROOT?.trim()) {
    return path.resolve(process.env.ST_REPO_ROOT.trim());
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (top.status === 0) return (top.stdout ?? '').trim();
  return process.cwd();
}

const repoRoot = resolveRepoRoot();
const repoCiRoot = path.join(repoRoot, 'scripts/ci');

const { matchLanePaths } = await import(
  pathToFileURL(path.join(repoCiRoot, 'pr-lane-paths.mjs')).href
);
const { emptyPassCache, parsePassCache } = await import(
  pathToFileURL(path.join(repoCiRoot, 'pass-cache.mjs')).href
);
const { PR_LANES, registryLanes } = await import(
  pathToFileURL(path.join(repoCiRoot, 'pr-lane-registry.mjs')).href
);
const {
  emptyTimingCache,
  parseTimingCache,
  TIMING_CACHE_FILE,
} = await import(
  pathToFileURL(path.join(repoCiRoot, 'test-shard-timing.mjs')).href
);

const flutterRoot = path.join(repoRoot, 'flutter');
const runLaneScript = path.join(repoRoot, 'scripts/ci/run-lane.mjs');
const testShardsScript = path.join(repoRoot, 'scripts/ci/test-shards.mjs');
const guardrailsAnalyzeScript = path.join(
  repoRoot,
  'scripts/ci/guardrails-analyze-packages.mjs',
);

/**
 * @param {string[]} argv
 */
export function parsePrLocalCiArgs(argv) {
  const out = {
    prNumber: null,
    base: null,
    lane: null,
    listTasks: false,
    skipBootstrap: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pr') {
      out.prNumber = Number(argv[++i]);
    } else if (arg === '--base') {
      out.base = argv[++i];
    } else if (arg === '--lane') {
      out.lane = argv[++i];
    } else if (arg === '--list-tasks') {
      out.listTasks = true;
    } else if (arg === '--skip-bootstrap') {
      out.skipBootstrap = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

/**
 * @param {{ prNumber?: number | null, base?: string | null }} opts
 */
export function resolveBaseRef({ prNumber, base }) {
  if (base) return base;
  if (prNumber) {
    capture('git', ['fetch', 'origin', '-q']);
    const pr = capture('gh', [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'baseRefName',
    ]);
    if (pr.status !== 0) {
      throw new Error(pr.stderr || `gh pr view ${prNumber} failed`);
    }
    const meta = JSON.parse(pr.stdout ?? '{}');
    const baseBranch = meta.baseRefName ?? 'dev';
    return `origin/${baseBranch}`;
  }
  return 'origin/dev';
}

/**
 * @param {string} base
 * @param {string} [root]
 */
export function changedFilesVsBase(base, root = repoRoot) {
  capture('git', ['fetch', 'origin', '-q'], { cwd: root });
  const mergeBase = capture(
    'git',
    ['merge-base', base, 'HEAD'],
    { cwd: root },
  );
  if (mergeBase.status !== 0) {
    throw new Error(mergeBase.stderr || `merge-base ${base} failed`);
  }
  const mb = (mergeBase.stdout ?? '').trim();
  const diff = capture(
    'git',
    ['diff', '--name-only', '--no-renames', mb, 'HEAD'],
    { cwd: root },
  );
  if (diff.status !== 0) {
    throw new Error(diff.stderr || `git diff vs ${base} failed`);
  }
  return (diff.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} changedFiles
 * @param {typeof PR_LANES} [lanes]
 */
export function filterEligibleLanes(changedFiles, lanes = registryLanes()) {
  return lanes.filter((lane) => matchLanePaths(changedFiles, lane.paths));
}

/**
 * @param {import('../ci/pr-lane-registry.mjs').LocalRun} localRun
 * @param {{ base: string, repoRoot: string }} ctx
 */
export function expandLocalRun(localRun, { base, repoRoot: root }) {
  const args = (localRun.args ?? []).map((arg) =>
    arg.replaceAll('{base}', base),
  );
  return {
    cmd: localRun.cmd,
    args,
    cwd: localRun.cwd ? path.join(root, localRun.cwd) : root,
    shell: localRun.shell ?? false,
  };
}

function capture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: isWindows,
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.stdio ?? 'pipe',
  });
}

/**
 * run-lane treats stg/main bases as push-scoped (HEAD commit only) outside
 * GitHub Actions. Local promotion runs need the cumulative merge-base diff
 * that lane eligibility already used — pass the SHA, not the branch ref.
 *
 * @param {string} base
 * @param {string} root
 */
export function laneBaseForRunLane(base, root = repoRoot) {
  if (!resolvePromotionBaseRef({ base })) return base;
  const mergeBase = capture(
    'git',
    ['merge-base', base, 'HEAD'],
    { cwd: root },
  );
  if (mergeBase.status !== 0) return base;
  const mb = (mergeBase.stdout ?? '').trim();
  return mb || base;
}

function scopeNamesFromContext(ctx) {
  const names = [];
  for (const dir of ctx.testPackageDirs) {
    const name = ctx.graph.nameByDir.get(dir);
    if (name) names.push(name);
  }
  return [...new Set(names)].sort();
}

function bootstrapTask(scopeNames, root) {
  const scopeArgs = scopeNames.flatMap((n) => ['--scope', n]);
  return {
    lane: 'bootstrap',
    label: `melos bootstrap (${scopeNames.length} scope(s))`,
    cmd: 'melos',
    args: ['bootstrap', '--include-dependencies', ...scopeArgs],
    weight: 2,
    options: { cwd: path.join(root, 'flutter') },
  };
}

function architectureFullTreeTask(root, base) {
  return {
    lane: 'dart-static-architecture',
    label: 'pr-local-ci:architecture-lint-full-tree',
    cmd: 'bash',
    args: ['scripts/ci/run-dart-static-architecture-local.sh', base],
    weight: 1,
    options: { cwd: root },
  };
}

function dartAnalyzeExtrasTask(base, root) {
  return {
    lane: 'dart-analyze-extras',
    label: 'pr-local-ci:dart-analyze-extras',
    cmd: 'bash',
    args: ['scripts/ci/run-dart-analyze-extras-local.sh', base],
    weight: 1,
    options: { cwd: root },
  };
}

function runLaneTask({ lane, base, packages, root }) {
  const laneBase = laneBaseForRunLane(base, root);
  const args = [runLaneScript, '--lane', lane, '--base', laneBase];
  if (packages) args.push('--packages', packages);
  return {
    lane: `dart-${lane}`,
    label: packages
      ? `pr-local-ci:test-shard (${packages})`
      : `pr-local-ci:${lane}`,
    cmd: 'node',
    args,
    weight: lane === 'analyze' ? 2 : 4,
    options: { cwd: root },
  };
}

/**
 * Package-wide analyze — matches pr-checks.yml dart-analyze shard
 * (guardrails-analyze-packages.mjs), not file-scoped run-lane analyze.
 *
 * @param {string[]} packages flutter-relative package dirs
 * @param {string} root
 */
function guardrailsAnalyzeTask(packages, root) {
  if (packages.length === 0) return null;
  return {
    lane: 'dart-analyze',
    label:
      `pr-local-ci:guardrails-analyze (${packages.length} package(s))`,
    cmd: 'node',
    args: [
      guardrailsAnalyzeScript,
      '--packages',
      packages.join(','),
    ],
    weight: 2,
    options: { cwd: path.join(root, 'flutter') },
  };
}

function localRunTask(laneId, localRun, ctx, env) {
  const expanded = expandLocalRun(localRun, ctx);
  /** @type {Record<string, string>} */
  const envOverrides = {};
  if (
    laneId === 'validate-sync-config'
    && env.POWERSYNC_ADMIN_TOKEN?.trim()
    && !env.PS_ADMIN_TOKEN?.trim()
  ) {
    envOverrides.PS_ADMIN_TOKEN = env.POWERSYNC_ADMIN_TOKEN;
  }
  return {
    lane: laneId,
    label: `pr-local-ci:${laneId}`,
    cmd: expanded.cmd,
    args: expanded.args,
    weight: 1,
    options: {
      cwd: expanded.cwd,
      // Descriptors with shell:true already carry `bash -c`; Node's
      // shell:true would concatenate argv and break set -euo pipefail.
      shell: expanded.shell ? false : undefined,
      envOverrides,
    },
  };
}

/**
 * @param {Record<string, unknown> | undefined} options
 */
function resolveTaskOptions(options = {}) {
  const { envOverrides, ...rest } = options;
  if (!envOverrides || Object.keys(envOverrides).length === 0) {
    return rest;
  }
  return {
    ...rest,
    env: { ...process.env, ...envOverrides },
  };
}

/**
 * @param {Record<string, unknown>} task
 */
function serializeTaskForList(task) {
  const { options, ...rest } = task;
  if (!options || typeof options !== 'object') {
    return rest;
  }
  const { envOverrides, env, ...safeOptions } = options;
  const serialized = { ...rest, options: safeOptions };
  if (envOverrides && Object.keys(envOverrides).length > 0) {
    serialized.options = {
      ...safeOptions,
      envKeys: Object.keys(envOverrides),
    };
  }
  return serialized;
}

/**
 * @param {{
 *   base: string,
 *   repoRoot?: string,
 *   laneFilter?: string | null,
 *   skipBootstrap?: boolean,
 *   changedFiles?: string[],
 *   lanes?: typeof PR_LANES,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 */
export async function buildPrLocalCiTasks(opts) {
  const root = opts.repoRoot ?? repoRoot;
  const base = opts.base;
  const changed =
    opts.changedFiles ?? changedFilesVsBase(base, root);
  const eligible = filterEligibleLanes(changed, opts.lanes ?? registryLanes());
  const laneFilter = opts.laneFilter;
  const selected = laneFilter
    ? eligible.filter((lane) => lane.id === laneFilter)
    : eligible;

  if (laneFilter && selected.length === 0) {
    const known = registryLanes().map((l) => l.id).join(', ');
    throw new Error(
      `Lane '${laneFilter}' not path-eligible or unknown. ` +
        `Eligible: ${eligible.map((l) => l.id).join(', ') || '(none)'}. ` +
        `Known: ${known}`,
    );
  }

  /** @type {Array<Record<string, unknown>>} */
  const tasks = [];
  /** @type {string[]} */
  const reminders = [];
  const ctx = { base, repoRoot: root };
  const env = opts.env ?? process.env;

  const laneBase = laneBaseForRunLane(base, root);
  let testCtx = null;
  const needsTest = selected.some((lane) => lane.dartLane === 'test');
  if (needsTest) {
    const mod = await import(pathToFileURL(runLaneScript).href);
    testCtx = mod.collectTestLaneContext({ base: laneBase, repoRoot: root });
  }

  for (const lane of selected) {
    if (lane.skipWhenEnvUnset && !env[lane.skipWhenEnvUnset]?.trim()) {
      reminders.push(
        `${lane.id}: skipped (${lane.skipWhenEnvUnset} unset)`,
      );
      continue;
    }

    if (lane.dartLane === 'static' || lane.dartLane === 'analyze') {
      if (lane.dartLane === 'static') {
        tasks.push(runLaneTask({ lane: 'static', base, root }));
        tasks.push(architectureFullTreeTask(root, laneBase));
      }
      if (lane.dartLane === 'analyze') {
        const laneMod = await import(pathToFileURL(runLaneScript).href);
        const plan = laneMod.buildLanePlan({
          lane: 'analyze',
          base: laneBase,
          repoRoot: root,
        });
        const analyzeTask = guardrailsAnalyzeTask(
          plan.meta.analyzePackageDirs ?? [],
          root,
        );
        if (analyzeTask) {
          tasks.push(analyzeTask);
        } else {
          reminders.push(`${lane.id}: no packages to analyze (skip)`);
        }
      }
      if (lane.id === 'dart-analyze-plan') {
        tasks.push(dartAnalyzeExtrasTask(laneBase, root));
      }
      continue;
    }

    if (lane.dartLane === 'test') {
      if (!testCtx) continue;
      const scopeNames = scopeNamesFromContext(testCtx);
      if (scopeNames.length === 0) {
        reminders.push(`${lane.id}: no packages to test (skip)`);
        continue;
      }
      if (!opts.skipBootstrap) {
        tasks.push(bootstrapTask(scopeNames, root));
      }

      const shardMod = await import(pathToFileURL(testShardsScript).href);
      const hasTestDir = (dir) =>
        fs.existsSync(path.join(root, 'flutter', dir, 'test'));
      const withTests = shardMod.filterPackagesWithTests(
        testCtx.testPackageDirs,
        hasTestDir,
      );
      const ls = capture('git', ['ls-files', '-s', '--', 'flutter'], {
        cwd: root,
      });
      if (ls.status !== 0) {
        throw new Error(ls.stderr || 'git ls-files failed');
      }
      const hashes = shardMod.hashPackagesFromLsFiles({
        lsFilesS: ls.stdout ?? '',
        packageDirs: withTests,
        graph: testCtx.graph,
      });
      const cachePath = path.join(root, '.cache/dart-test-pass.json');
      const cache = fs.existsSync(cachePath)
        ? parsePassCache(fs.readFileSync(cachePath, 'utf8'))
        : emptyPassCache();
      const timingPath = path.join(root, TIMING_CACHE_FILE);
      const timingCache = fs.existsSync(timingPath)
        ? parseTimingCache(fs.readFileSync(timingPath, 'utf8'))
        : emptyTimingCache();
      const planned = shardMod.planTestShards({
        candidateDirs: withTests,
        hasTestDir: () => true,
        hashes,
        cache,
        nameByDir: testCtx.graph.nameByDir,
        repoRoot: root,
        timingCache,
      });
      if (!planned.hasWork || planned.shards.length === 0) {
        reminders.push(`${lane.id}: ${planned.skipLog || 'nothing to test'}`);
        continue;
      }
      for (const shard of planned.shards) {
        tasks.push(
          runLaneTask({
            lane: 'test',
            base,
            packages: shard.join(','),
            root,
          }),
        );
      }
      continue;
    }

    if (lane.localRun) {
      tasks.push(localRunTask(lane.id, lane.localRun, ctx, env));
      continue;
    }

    if (lane.reminder) {
      reminders.push(`${lane.id}: ${lane.reminder}`);
    }
  }

  return { tasks, reminders, changedFiles: changed, eligible };
}

function emitListTasks(tasks, reminders) {
  let sawBootstrap = false;
  for (const task of tasks) {
    if (task.lane === 'bootstrap') {
      sawBootstrap = true;
      continue;
    }
    process.stdout.write(`${JSON.stringify(serializeTaskForList(task))}\n`);
  }
  if (sawBootstrap) {
    process.stdout.write(
      `${JSON.stringify({
        lane: 'bootstrap',
        label:
          'pr-local-ci: melos bootstrap (serial — run before fan-out)',
        kind: 'serial',
      })}\n`,
    );
  }
  for (const message of reminders) {
    process.stdout.write(
      `${JSON.stringify({ lane: 'reminder', label: message, kind: 'reminder' })}\n`,
    );
  }
}

function printHelp() {
  process.stdout.write(`\
Local PR CI parity (path-filtered PR Checks lanes).

  pnpm pr-local-ci -- --pr <n>
  pnpm pr-local-ci -- --base origin/dev
  pnpm pr-local-ci -- --pr <n> --list-tasks

Push only via pnpm pr-review-push.
`);
}

async function main() {
  const args = parsePrLocalCiArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const base = resolveBaseRef(args);
  const { tasks, reminders, eligible } = await buildPrLocalCiTasks({
    base,
    laneFilter: args.lane,
    skipBootstrap: args.skipBootstrap,
  });

  if (args.listTasks) {
    emitListTasks(tasks, reminders);
    process.exit(0);
  }

  process.stdout.write(
    `🔎 pr-local-ci: ${eligible.length} eligible lane(s), ` +
      `${tasks.length} task(s) vs ${base}\n`,
  );
  for (const message of reminders) {
    process.stdout.write(`ℹ️  ${message}\n`);
  }

  if (tasks.length === 0) {
    process.stdout.write('✅ pr-local-ci: no runnable tasks (path skip)\n');
    process.exit(0);
  }

  const runnable = tasks.map((task) => ({
    ...task,
    options: resolveTaskOptions(task.options),
  }));
  const bootstrap = runnable.filter((t) => t.lane === 'bootstrap');
  const parallel = runnable.filter((t) => t.lane !== 'bootstrap');

  if (bootstrap.length > 0) {
    const boot = await runParallelLimited(bootstrap, 1);
    if (boot.failures.length > 0) {
      process.exit(boot.failures[0].code ?? 1);
    }
  }

  const { failures } = await runParallelLimited(parallel);
  if (failures.length > 0) {
    process.exit(failures[0].code ?? 1);
  }

  process.stdout.write('\n✅ pr-local-ci: all tasks passed\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`pr-local-ci: ${err.message}\n`);
    process.exit(2);
  });
}
