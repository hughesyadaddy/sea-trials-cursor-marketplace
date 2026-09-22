/**
 * Execute push-gate task groups with maximum in-process parallelism.
 */
import { runParallelLimited } from './parallel.mjs';
import { taskToRunnable } from './push-gate-tasks.mjs';

/**
 * Stable identity for a runnable: same binary, same args, same cwd.
 *
 * @param {ReturnType<typeof taskToRunnable>} runnable
 */
export function runnableFingerprint(runnable) {
  return JSON.stringify([
    runnable.cmd,
    runnable.args,
    runnable.options?.cwd ?? '',
  ]);
}

/**
 * Collapse the plan into execution pools.
 *
 * Every `parallel: true` group runs against the working tree, so the
 * dirty-tree and committed-diff phases can share one pool instead of
 * waiting on each other (the old runner drained dirty → prepush → CI
 * strictly, even though `dart analyze` reads the same files in both).
 * A `parallel: false` group (CI bootstrap) is a barrier: everything
 * before it finishes first, and it runs alone.
 *
 * Identical commands that appear in more than one group — the same
 * analyze chunk planned by dirty and prepush — run once.
 *
 * @param {Array<{ id: string, phase: string, parallel: boolean,
 *   tasks: Array<Record<string, unknown>> }>} groups
 * @param {string} repoRoot
 * @returns {Array<{ parallel: boolean, phases: string[],
 *   tasks: Array<ReturnType<typeof taskToRunnable> & { phase: string }> }>}
 */
export function coalesceGroups(groups, repoRoot) {
  const seen = new Set();
  /** @type {ReturnType<typeof coalesceGroups>} */
  const pools = [];
  let dedupedCount = 0;

  for (const group of groups) {
    const tasks = [];
    for (const task of group.tasks) {
      const runnable = taskToRunnable(task, repoRoot);
      const key = runnableFingerprint(runnable);
      if (seen.has(key)) {
        dedupedCount += 1;
        continue;
      }
      seen.add(key);
      tasks.push({ ...runnable, phase: group.phase });
    }
    if (tasks.length === 0) continue;

    const last = pools[pools.length - 1];
    if (group.parallel && last && last.parallel) {
      last.tasks.push(...tasks);
      if (!last.phases.includes(group.phase)) last.phases.push(group.phase);
    } else {
      pools.push({ parallel: group.parallel, phases: [group.phase], tasks });
    }
  }

  return Object.assign(pools, { dedupedCount });
}

/**
 * @param {Awaited<ReturnType<import('./push-gate-tasks.mjs').buildPushGatePlan>>} plan
 * @param {string} repoRoot
 * @param {{ failFast?: boolean }} [opts]
 */
export async function runPushGatePlan(plan, repoRoot, opts = {}) {
  if (!plan.ok) {
    return {
      ok: false,
      error: plan.error,
      failedGroup: null,
      failures: [],
    };
  }

  if (plan.groups.length === 0) {
    return { ok: true, failures: [], groupCount: 0 };
  }

  const pools = coalesceGroups(plan.groups, repoRoot);
  if (pools.dedupedCount > 0) {
    process.stderr.write(
      `♻️  skipped ${pools.dedupedCount} duplicate task(s) planned by ` +
        'more than one phase\n',
    );
  }

  for (const pool of pools) {
    const budget = pool.parallel ? undefined : 1;
    const { failures } = await runParallelLimited(pool.tasks, budget, opts);
    if (failures.length > 0) {
      const failedLabels = new Set(failures.map((f) => f.label));
      const failedPhase =
        pool.tasks.find((t) => failedLabels.has(t.label))?.phase ??
        pool.phases[0];
      return {
        ok: false,
        failedGroup: { phase: failedPhase, phases: pool.phases },
        failures,
        groupCount: plan.groups.length,
      };
    }
  }

  return { ok: true, failures: [], groupCount: plan.groups.length };
}
