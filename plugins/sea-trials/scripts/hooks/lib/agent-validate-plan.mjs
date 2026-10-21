/**
 * Pure planner for `agent-validate-changed`.
 *
 * Turns resolved package groups into three ordered phases — `flutter pub
 * get`, `dart analyze`, `flutter test` — with the weights, timeouts and
 * slot metadata the runner needs. No git, no spawning, no process exit:
 * the script owns those and this stays unit-testable.
 *
 * Shape decisions that keep the machine light (see the hook header):
 *   - ONE merged `dart analyze` per flutter root (not one per file), so a
 *     10-file diff spawns a single analysis server instead of ten.
 *   - Each analyze task takes the WHOLE budget as its weight, so at most
 *     one analyzer runs at a time within this process; `machine-slots`
 *     extends that cap across every agent-validate on the box.
 *   - Analyze carries `kind: 'analyze'` so the content-hash gate cache
 *     skips an identical set already proven green.
 */
import { buildMergedAnalyzeChunks } from './flutter-packages.mjs';

/** Merge up to this many changed files into one analyze invocation. */
export const ANALYZE_CHUNK_SIZE = 40;

/** Hard cap on concurrent weighted work; never derived from core count. */
export const DEFAULT_BUDGET = 4;

/** `dart analyze` timeout — a timeout is a failure (exit 124), never a pass. */
export const DEFAULT_ANALYZE_TIMEOUT_MS = 180_000;

/** `flutter test` timeout. */
export const DEFAULT_TEST_TIMEOUT_MS = 300_000;

/** @param {string} raw @param {number} fallback */
function positiveIntOr(raw, fallback) {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** `ST_AGENT_VALIDATE_BUDGET` (positive int) or {@link DEFAULT_BUDGET}. */
export function parseBudget(env = process.env) {
  return positiveIntOr(env.ST_AGENT_VALIDATE_BUDGET, DEFAULT_BUDGET);
}

/** `ST_AGENT_VALIDATE_ANALYZE_TIMEOUT_MS` or {@link DEFAULT_ANALYZE_TIMEOUT_MS}. */
export function parseAnalyzeTimeoutMs(env = process.env) {
  return positiveIntOr(
    env.ST_AGENT_VALIDATE_ANALYZE_TIMEOUT_MS,
    DEFAULT_ANALYZE_TIMEOUT_MS,
  );
}

/** `ST_AGENT_VALIDATE_TEST_TIMEOUT_MS` or {@link DEFAULT_TEST_TIMEOUT_MS}. */
export function parseTestTimeoutMs(env = process.env) {
  return positiveIntOr(
    env.ST_AGENT_VALIDATE_TEST_TIMEOUT_MS,
    DEFAULT_TEST_TIMEOUT_MS,
  );
}

/** Short, stable label for a flutter root (its parent repo dir name). */
function rootLabel(flutterRoot) {
  const parts = flutterRoot.replace(/[\\/]+$/, '').split(/[\\/]/);
  // flutter root is `<repo>/flutter`; name it after the repo so two
  // worktrees are distinguishable in the progress printer.
  return parts.length >= 2 ? parts[parts.length - 2] : flutterRoot;
}

/**
 * Build the phased task plan.
 *
 * @param {object} opts
 * @param {Array<{
 *   flutterRoot: string, repoRoot: string, pkgRel: string, pkgCwd: string,
 *   lib: string[], test: string[], pubspecChanged: boolean,
 * }>} opts.groups normalized package groups. `lib` holds analyze paths
 *   relative to `flutterRoot`; `test` holds test paths relative to
 *   `pkgCwd`.
 * @param {{ analyzeOnly?: boolean, testsOnly?: boolean }} [opts.flags]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.chunkSize]
 * @returns {{ budget: number, phases: { name: string, tasks: object[] }[] }}
 */
export function buildAgentValidatePlan({
  groups,
  flags = {},
  env = process.env,
  chunkSize = ANALYZE_CHUNK_SIZE,
}) {
  const budget = parseBudget(env);
  const analyzeTimeoutMs = parseAnalyzeTimeoutMs(env);
  const testTimeoutMs = parseTestTimeoutMs(env);
  const { analyzeOnly = false, testsOnly = false } = flags;

  /** @type {object[]} */
  const pubGetTasks = [];
  /** @type {object[]} */
  const analyzeTasks = [];
  /** @type {object[]} */
  const testTasks = [];

  // ---- phase 1: flutter pub get (pubspec changed) --------------------
  for (const g of groups) {
    if (!g.pubspecChanged) continue;
    pubGetTasks.push({
      label: `flutter pub get (${g.pkgRel})`,
      cmd: 'flutter',
      args: ['pub', 'get'],
      options: { cwd: g.pkgCwd, slotWeight: 1, slotRepoRoot: g.repoRoot },
      weight: 1,
    });
  }

  // ---- phase 2: dart analyze (one merged process per flutter root) ---
  // Grouping by flutter root means every package under a checkout folds
  // into a single analysis server; cwd is the flutter root and paths are
  // flutter-relative, matching the shape prepush already uses.
  if (!testsOnly) {
    /** @type {Map<string, { repoRoot: string, fileGroups: string[][] }>} */
    const byRoot = new Map();
    for (const g of groups) {
      if (g.lib.length === 0) continue;
      let entry = byRoot.get(g.flutterRoot);
      if (!entry) {
        entry = { repoRoot: g.repoRoot, fileGroups: [] };
        byRoot.set(g.flutterRoot, entry);
      }
      entry.fileGroups.push(g.lib);
    }

    for (const [flutterRoot, { repoRoot, fileGroups }] of byRoot) {
      const chunks = buildMergedAnalyzeChunks({ fileGroups, chunkSize });
      chunks.forEach((c, i) => {
        analyzeTasks.push({
          kind: 'analyze',
          label:
            `dart analyze --fatal-infos (${rootLabel(flutterRoot)}` +
            `${chunks.length > 1 ? `, chunk ${i + 1}/${chunks.length}` : ''}` +
            `, ${c.fileCount} file(s))`,
          cmd: 'dart',
          args: ['analyze', '--fatal-infos', ...c.paths],
          // Whole budget: only one analyzer at a time per process.
          weight: budget,
          timeoutMs: analyzeTimeoutMs,
          options: {
            cwd: flutterRoot,
            slotWeight: budget,
            slotRepoRoot: repoRoot,
          },
        });
      });
    }
  }

  // ---- phase 3: flutter test (changed test files only) ---------------
  if (!analyzeOnly) {
    for (const g of groups) {
      if (g.test.length === 0) continue;
      testTasks.push({
        // No `kind`: tests are never cached (non-deterministic by nature).
        label: `flutter test (${g.pkgRel}, ${g.test.length} file(s))`,
        cmd: 'flutter',
        args: ['test', '--concurrency=2', '--reporter', 'compact', ...g.test],
        weight: 2,
        timeoutMs: testTimeoutMs,
        options: { cwd: g.pkgCwd, slotWeight: 2, slotRepoRoot: g.repoRoot },
      });
    }
  }

  return {
    budget,
    phases: [
      { name: 'flutter pub get', tasks: pubGetTasks },
      { name: 'dart analyze', tasks: analyzeTasks },
      { name: 'flutter test', tasks: testTasks },
    ],
  };
}
