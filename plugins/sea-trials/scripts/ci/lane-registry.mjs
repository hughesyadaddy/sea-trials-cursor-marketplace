/**
 * Load the consuming repo's PR lane registry (config, not plugin code).
 *
 * The registry is pure data — `PR_LANES`, `PR_LANE_EXEMPT`,
 * `LANE_REQUIRED_INPUTS` — that each app repo ships at
 * `scripts/ci/pr-lane-registry.mjs`. Every helper that used to sit next
 * to that data (`laneById`, `registryLanes`) lives here instead, so the
 * repo file stays free of logic and the plugin stays the single owner of
 * how lanes are interpreted.
 *
 * Resolution order:
 *   1. `ST_LANE_REGISTRY` — absolute or repo-relative path to a registry
 *      module (tests, non-standard layouts)
 *   2. `<repoRoot>/scripts/ci/pr-lane-registry.mjs`
 *   3. `null` — the checkout has no PR lanes (dirty + prepush phases
 *      still apply; callers keep their "no registry" reminder)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LANE_REGISTRY_REL = 'scripts/ci/pr-lane-registry.mjs';

/**
 * @typedef {{
 *   cmd: string,
 *   args?: string[],
 *   cwd?: string,
 *   shell?: boolean,
 *   pluginScript?: string,
 * }} LocalRun
 *
 * `pluginScript` is a plugin-root-relative path (`scripts/ci/x.sh`).
 * The planner resolves it to an absolute path inside the installed
 * plugin and inserts it after any leading `-` flags in `args`, so
 * `{ cmd: 'bash', pluginScript: 'scripts/ci/x.sh', args: ['{base}'] }`
 * spawns `bash /plugin/scripts/ci/x.sh origin/dev` and
 * `{ cmd: 'node', pluginScript: 'scripts/ci/y.test.mjs', args: ['--test', 'a.test.mjs'] }`
 * spawns `node --test /plugin/scripts/ci/y.test.mjs a.test.mjs`.
 */

/**
 * @typedef {{
 *   id: string,
 *   paths: string[],
 *   dartLane?: 'static' | 'analyze' | 'test',
 *   localRun?: LocalRun | null,
 *   reminder?: string,
 *   skipWhenEnvUnset?: string,
 * }} PrLane
 */

/**
 * @typedef {{
 *   PR_LANES: PrLane[],
 *   PR_LANE_EXEMPT: Set<string>,
 *   LANE_REQUIRED_INPUTS: Record<string, string[]>,
 *   registryLanes: () => PrLane[],
 *   laneById: (id: string) => PrLane | undefined,
 *   path: string,
 * }} LaneRegistry
 */

/**
 * Path the registry would be loaded from, or null when none exists.
 *
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveLaneRegistryPath(repoRoot, env = process.env) {
  const override = env.ST_LANE_REGISTRY?.trim();
  if (override) {
    const abs = path.isAbsolute(override)
      ? override
      : path.join(repoRoot, override);
    return fs.existsSync(abs) ? abs : null;
  }
  const standard = path.join(repoRoot, LANE_REGISTRY_REL);
  return fs.existsSync(standard) ? standard : null;
}

/**
 * Wrap loaded registry data with the helpers the planner uses.
 *
 * @param {{ PR_LANES?: PrLane[], PR_LANE_EXEMPT?: Iterable<string>, LANE_REQUIRED_INPUTS?: Record<string, string[]> }} data
 * @param {string} registryPath
 * @returns {LaneRegistry}
 */
export function wrapLaneRegistry(data, registryPath) {
  const lanes = Array.isArray(data.PR_LANES) ? data.PR_LANES : [];
  return {
    PR_LANES: lanes,
    PR_LANE_EXEMPT: new Set(data.PR_LANE_EXEMPT ?? []),
    LANE_REQUIRED_INPUTS: data.LANE_REQUIRED_INPUTS ?? {},
    /** Lanes eligible for local path filtering. */
    registryLanes: () => lanes,
    laneById: (id) => lanes.find((lane) => lane.id === id),
    path: registryPath,
  };
}

/**
 * @param {string} repoRoot
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<LaneRegistry | null>}
 */
export async function loadLaneRegistry(repoRoot, opts = {}) {
  const registryPath = resolveLaneRegistryPath(
    repoRoot,
    opts.env ?? process.env,
  );
  if (!registryPath) return null;
  const mod = await import(pathToFileURL(registryPath).href);
  return wrapLaneRegistry(mod, registryPath);
}

/**
 * Resolve a `localRun` descriptor into the argv the planner spawns.
 *
 * @param {LocalRun} localRun
 * @param {{ base: string, repoRoot: string, pluginRoot: string }} ctx
 */
export function expandLocalRun(localRun, { base, repoRoot, pluginRoot }) {
  const args = (localRun.args ?? []).map((arg) =>
    arg.replaceAll('{base}', base),
  );
  if (localRun.pluginScript) {
    if (path.isAbsolute(localRun.pluginScript)) {
      throw new Error(
        `localRun.pluginScript must be plugin-relative: ${localRun.pluginScript}`,
      );
    }
    const script = path.join(pluginRoot, localRun.pluginScript);
    let insertAt = 0;
    while (insertAt < args.length && args[insertAt].startsWith('-')) {
      insertAt += 1;
    }
    args.splice(insertAt, 0, script);
  }
  return {
    cmd: localRun.cmd,
    args,
    cwd: localRun.cwd ? path.join(repoRoot, localRun.cwd) : repoRoot,
    shell: localRun.shell ?? false,
  };
}
