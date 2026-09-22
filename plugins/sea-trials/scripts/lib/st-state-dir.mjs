/**
 * Per-user state directory shared by every Sea Trials script.
 *
 *   ~/.cache/sea-trials/<sub>        (override root with ST_STATE_DIR)
 *
 * Sub-directories in use (keep this list current when adding one):
 *   gate-cache/       content-hash → verdict cache for format/lint/analyze
 *   telemetry/        gate-runs.jsonl — one JSON object per task run
 *   host/             capabilities.json written by st-model-probe
 *   quarantine/       flaky-test ledger written by st-flake-quarantine
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} [sub] sub-directory name
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [opts]
 * @returns {string} absolute directory path (created if missing)
 */
export function stateDir(sub, opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? os.homedir();
  const root = env.ST_STATE_DIR
    ? path.resolve(env.ST_STATE_DIR)
    : path.join(home, '.cache', 'sea-trials');
  const dir = sub ? path.join(root, sub) : root;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path of the shared telemetry JSONL (see gate-telemetry.mjs). */
export function telemetryPath(opts) {
  return path.join(stateDir('telemetry', opts), 'gate-runs.jsonl');
}

/** Path of the host capabilities probe output (see st-model-probe.mjs). */
export function hostCapabilitiesPath(opts) {
  return path.join(stateDir('host', opts), 'capabilities.json');
}
