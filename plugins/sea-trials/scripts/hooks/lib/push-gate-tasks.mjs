/**
 * Push-gate task planner — self-contained plugin runtime.
 *
 * Dirty/prepush planners ship in this plugin. CI lanes load lane registry
 * from the checkout's scripts/ci/ at runtime (repo config only).
 */
import * as dirty from './dirty-tree-tasks.mjs';
import * as prepush from './prepush-tasks.mjs';
import * as ci from '../pr-local-ci.mjs';

const PHASE_DIRTY = 'dirty';
const PHASE_PREPUSH = 'prepush';
const PHASE_CI = 'ci';

/**
 * @param {Record<string, unknown>} task
 * @param {string} repoRoot
 */
export function taskToRunnable(task, repoRoot) {
  const options = task.options && typeof task.options === 'object'
    ? task.options
    : {};
  const envOverrides = options.envOverrides ?? {};
  const { envOverrides: _drop, ...safeOptions } = options;
  const cwd = safeOptions.cwd ?? repoRoot;
  return {
    label: String(task.label ?? 'task'),
    cmd: String(task.cmd),
    args: Array.isArray(task.args) ? task.args : [],
    weight: typeof task.weight === 'number' ? task.weight : 1,
    options: {
      ...safeOptions,
      cwd,
      env: { ...process.env, ...envOverrides },
    },
  };
}

/**
 * @param {{
 *   phase: string,
 *   group: number,
 *   parallel: boolean,
 *   task: Record<string, unknown>,
 *   repoRoot: string,
 *   index: number,
 * }} ctx
 */
export function serializePushGateTask({
  phase,
  group,
  parallel,
  task,
  repoRoot,
  index,
}) {
  const runnable = taskToRunnable(task, repoRoot);
  const id = `${phase}-${index}`;
  return {
    source: 'push-gate',
    phase,
    group,
    parallel,
    id,
    label: runnable.label,
    cmd: runnable.cmd,
    args: runnable.args,
    cwd: runnable.options.cwd,
    weight: runnable.weight,
    kind: task.kind ?? task.lane ?? undefined,
  };
}

/**
 * @param {{
 *   repoRoot: string,
 *   prNumber?: number | null,
 *   base?: string | null,
 *   phases?: Set<string>,
 *   analyzeOnly?: boolean,
 *   testsOnly?: boolean,
 * }} opts
 */
export async function buildPushGatePlan(opts) {
  const repoRoot = opts.repoRoot;
  const phases = opts.phases ?? new Set([PHASE_DIRTY, PHASE_PREPUSH, PHASE_CI]);
  /** @type {Array<{ id: string, phase: string, parallel: boolean, tasks: Array<Record<string, unknown>> }>} */
  const groups = [];
  /** @type {string[]} */
  const reminders = [];
  const meta = {
    dirtyFileCount: 0,
    prepushFileCount: 0,
    ciLaneCount: 0,
  };

  let groupIndex = 0;

  if (phases.has(PHASE_DIRTY)) {
    const prep = dirty.prepareDirtyTreeGate({ repoRoot });
    if (!prep.ok) {
      return { ok: false, error: prep.message, groups, reminders, meta };
    }
    const changed = prep.changed;
    meta.dirtyFileCount = changed.length;
    if (changed.length > 0) {
      const dirtyTasks = dirty.buildDirtyTreeTasks({
        repoRoot,
        changed,
        analyzeOnly: opts.analyzeOnly,
        testsOnly: opts.testsOnly,
      });
      if (dirtyTasks.length > 0) {
        groupIndex += 1;
        groups.push({
          id: `g${groupIndex}`,
          phase: PHASE_DIRTY,
          parallel: true,
          tasks: dirtyTasks,
        });
      }
    }
  }

  if (phases.has(PHASE_PREPUSH)) {
    const prep = prepush.preparePrepushGate(repoRoot);
    if (!prep.ok) {
      return { ok: false, error: prep.message, groups, reminders, meta };
    }
    const { ctx } = prep;
    meta.prepushFileCount = ctx.changed.length;
    if (ctx.changed.length > 0) {
      const prepushTasks = prepush.buildPrepushTasks(repoRoot, ctx);
      if (prepushTasks.length > 0) {
        groupIndex += 1;
        groups.push({
          id: `g${groupIndex}`,
          phase: PHASE_PREPUSH,
          parallel: true,
          tasks: prepushTasks,
        });
      }
    }
  }

  if (phases.has(PHASE_CI)) {
    const base = ci.resolveBaseRef({
      prNumber: opts.prNumber ?? null,
      base: opts.base ?? null,
    });
    const { tasks, reminders: ciReminders, eligible } =
      await ci.buildPrLocalCiTasks({ base, repoRoot });
    meta.ciLaneCount = eligible.length;
    reminders.push(...ciReminders);

    const bootstrap = tasks.filter((t) => t.lane === 'bootstrap');
    const parallel = tasks.filter((t) => t.lane !== 'bootstrap');

    if (bootstrap.length > 0) {
      groupIndex += 1;
      groups.push({
        id: `g${groupIndex}`,
        phase: PHASE_CI,
        parallel: false,
        tasks: bootstrap,
      });
    }

    if (parallel.length > 0) {
      groupIndex += 1;
      groups.push({
        id: `g${groupIndex}`,
        phase: PHASE_CI,
        parallel: true,
        tasks: parallel,
      });
    }
  }

  return { ok: true, groups, reminders, meta };
}

/**
 * @param {Awaited<ReturnType<typeof buildPushGatePlan>>} plan
 * @param {string} repoRoot
 */
export function emitPushGateTaskLines(plan, repoRoot) {
  let index = 0;
  for (const [groupIdx, group] of plan.groups.entries()) {
    for (const task of group.tasks) {
      index += 1;
      const line = serializePushGateTask({
        phase: group.phase,
        group: groupIdx + 1,
        parallel: group.parallel,
        task,
        repoRoot,
        index,
      });
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
  }
  for (const message of plan.reminders) {
    process.stdout.write(
      `${JSON.stringify({
        source: 'push-gate',
        phase: PHASE_CI,
        kind: 'reminder',
        label: message,
      })}\n`,
    );
  }
}

export { PHASE_DIRTY, PHASE_PREPUSH, PHASE_CI };
