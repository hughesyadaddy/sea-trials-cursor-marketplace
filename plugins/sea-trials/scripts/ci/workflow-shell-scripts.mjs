/**
 * Script paths invoked from workflow `run:` steps.
 *
 * Import closure misses these entirely — dart-full-audit shells out to
 * resolve-flutter-channel-head.mjs (which feeds sdk_revision into the
 * pass-cache key) and lint-source-key.mjs without importing either.
 *
 * Two shapes are recognised: repo-relative `node scripts/...` (files the
 * checkout still owns) and plugin-hosted
 * `node "$ST_PLUGIN_ROOT/scripts/..."` / `bash "$ST_PLUGIN_ROOT/scripts/..."`
 * (files this plugin ships, keyed into caches through plugin_sha).
 */

/** @param {string} raw */
function cleanToken(raw) {
  let path = raw.replace(/^['"]|['"]$/g, '');
  path = path.replace(/[)'"]+$/, '');
  return path;
}

/** @param {string} run */
export function nodeScriptsFromRun(run) {
  const scripts = new Set();
  for (const match of run.matchAll(/\bnode\s+([^\s|;&]+)/g)) {
    const path = cleanToken(match[1]);
    if (path.startsWith('scripts/')) scripts.add(path);
  }
  return [...scripts].sort();
}

/**
 * Plugin-relative paths of every `$ST_PLUGIN_ROOT/...` script a `run:`
 * step invokes via node or bash, e.g. `scripts/ci/run-lane.mjs`.
 *
 * @param {string} run
 */
export function pluginScriptsFromRun(run) {
  const scripts = new Set();
  const re =
    /\b(?:node|bash|sh|source)\s+["']?\$\{?ST_PLUGIN_ROOT\}?["']?\/([^\s|;&"']+)/g;
  for (const match of run.matchAll(re)) {
    scripts.add(cleanToken(match[1]));
  }
  return [...scripts].sort();
}

/**
 * @param {{ steps?: { run?: string }[] }} job
 * @returns {string[]}
 */
export function shellScriptsFromJob(job) {
  const scripts = new Set();
  for (const step of job.steps ?? []) {
    for (const path of nodeScriptsFromRun(String(step.run ?? ''))) {
      scripts.add(path);
    }
  }
  return [...scripts].sort();
}

/**
 * @param {{ steps?: { run?: string }[] }} job
 * @returns {string[]} plugin-relative script paths
 */
export function pluginScriptsFromJob(job) {
  const scripts = new Set();
  for (const step of job.steps ?? []) {
    for (const path of pluginScriptsFromRun(String(step.run ?? ''))) {
      scripts.add(path);
    }
  }
  return [...scripts].sort();
}
