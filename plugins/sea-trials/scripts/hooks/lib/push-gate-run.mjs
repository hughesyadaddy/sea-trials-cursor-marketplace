/**
 * Execute push-gate task groups with maximum in-process parallelism.
 */
import { runParallelLimited } from './parallel.mjs';
import { taskToRunnable } from './push-gate-tasks.mjs';

/**
 * @param {Awaited<ReturnType<import('./push-gate-tasks.mjs').buildPushGatePlan>>} plan
 * @param {string} repoRoot
 */
export async function runPushGatePlan(plan, repoRoot) {
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

  /** @type {Array<{ label: string, code: number, stdout: string, stderr: string }>} */
  const allFailures = [];

  for (const group of plan.groups) {
    const runnable = group.tasks.map((task) =>
      taskToRunnable(task, repoRoot),
    );
    const budget = group.parallel ? undefined : 1;
    const { failures } = await runParallelLimited(runnable, budget);
    if (failures.length > 0) {
      return {
        ok: false,
        failedGroup: group,
        failures,
        groupCount: plan.groups.length,
      };
    }
  }

  return { ok: true, failures: [], groupCount: plan.groups.length };
}
