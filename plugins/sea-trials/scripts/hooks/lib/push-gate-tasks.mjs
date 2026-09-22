/**
 * Push-gate task planner — self-contained plugin runtime.
 *
 * Dirty/prepush planners and every CI lane runner ship in this plugin.
 * The only CI input read from the checkout at runtime is its lane
 * registry (`scripts/ci/pr-lane-registry.mjs`, data only).
 */
import * as dirty from './dirty-tree-tasks.mjs';
import * as prepush from './prepush-tasks.mjs';
import * as ci from '../pr-local-ci.mjs';
import { readCapabilities, resolveModel } from './host-capabilities.mjs';

export const PHASE_DIRTY = 'dirty';
export const PHASE_PREPUSH = 'prepush';
export const PHASE_CI = 'ci';

/**
 * Model routing for fan-out workers. Running a gate command and fixing
 * a format/lint/analyze failure is mechanical work: pin it to the cheap,
 * fast tier on each host. Reviewers and planners stay on `inherit`.
 *
 * Delegates to `resolveModel({ tier: 'mechanical' })`: env overrides
 * (`ST_SHARD_MODEL_MECHANICAL[_CLAUDE]`, `ST_WORKER_MODEL[_CLAUDE]`)
 * win, then the slugs `st-model-probe.mjs` saw on this machine, then a
 * static default flagged `modelVerified: false`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, any>|null} [caps] probe output; `undefined`
 *   reads `hostCapabilitiesPath()`, `null` skips the read
 */
export function workerModelHints(env = process.env, caps) {
  const r = resolveModel({ tier: 'mechanical', env, caps });
  return {
    model: r.model,
    claudeModel: r.claudeModel,
    modelVerified: r.verified,
    modelSource: r.source,
  };
}

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
 *   env?: NodeJS.ProcessEnv,
 *   caps?: Record<string, unknown> | null,
 * }} ctx `env` / `caps` are forwarded to `workerModelHints`
 */
export function serializePushGateTask({
  phase,
  group,
  parallel,
  task,
  repoRoot,
  index,
  env,
  caps,
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
    subagent_type: 'generalPurpose',
    ...workerModelHints(env, caps),
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
 *   granularity?: string,
 * }} opts
 */
export async function buildPushGatePlan(opts) {
  const repoRoot = opts.repoRoot;
  const phases = opts.phases ?? new Set([PHASE_DIRTY, PHASE_PREPUSH, PHASE_CI]);
  const granularity = opts.granularity;
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
        granularity,
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
      const prepushTasks = prepush.buildPrepushTasks(repoRoot, ctx, {
        granularity,
      });
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
  // Read the probe file once: every line shares the same snapshot.
  const caps = readCapabilities();
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
        caps,
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
