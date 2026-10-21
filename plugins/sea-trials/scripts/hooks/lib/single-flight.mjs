/**
 * Machine-wide single-flight lock + change-set coalescing for
 * `agent-validate-changed`.
 *
 * Many agents (shard fan-outs, iteration loops) run agent-validate at
 * the same moment on one laptop. `machine-slots` already caps how many
 * analysis servers run at once, but every waiter still re-spawns the
 * full analyze + test pass against the same tree. This takes an
 * exclusive lock so only ONE agent-validate does heavy work at a time,
 * and — crucially — lets a waiter skip its run entirely when the holder
 * just validated the exact same change set (coalescing).
 *
 * Pure + injectable: all fs / pid / clock access flows through `io`,
 * `now`, and `sleep` so every branch is unit-testable without real
 * processes or timers.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { pidAlive as realPidAlive } from './machine-slots.mjs';

/** Poll interval while waiting for a held lock (~1s per the spec). */
export const DEFAULT_POLL_MS = 1000;

/** Default wait cap before giving up and exiting 75 (EX_TEMPFAIL). */
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;

/** Exit code used when the lock wait cap is exceeded (sysexits EX_TEMPFAIL). */
export const LOCK_TIMEOUT_EXIT = 75;

/** `ST_AGENT_VALIDATE_LOCK=0` disables the lock (documented escape hatch). */
export function singleFlightEnabled(env = process.env) {
  return (env.ST_AGENT_VALIDATE_LOCK ?? '').trim() !== '0';
}

/** `ST_AGENT_VALIDATE_LOCK_WAIT_MS` overrides the wait cap (positive int). */
export function lockWaitMs(env = process.env) {
  const raw = Number.parseInt(
    (env.ST_AGENT_VALIDATE_LOCK_WAIT_MS ?? '').trim(),
    10,
  );
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_WAIT_MS;
}

/** Real filesystem + pid seam; overridden wholesale in tests. */
export const defaultIo = {
  /**
   * Atomic create-if-absent. Returns true when we created it, false when
   * it already existed, and throws on any other error.
   */
  createExclusive(lockPath, contents) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') return false;
      throw err;
    }
    try {
      fs.writeSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  },
  readJson(lockPath) {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      return null;
    }
  },
  remove(lockPath) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone / raced another reclaimer
    }
  },
  readFileBytes(absPath) {
    return fs.readFileSync(absPath);
  },
  writeJsonAtomic(targetPath, text) {
    const tmp = `${targetPath}.${process.pid}.${crypto
      .randomBytes(4)
      .toString('hex')}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, targetPath);
  },
  pidAlive: realPidAlive,
};

/**
 * Content-addressed fingerprint of a change set: the sorted absolute
 * file list, each file's content hash, and the relevant flags. Because
 * it is content-based, a newer edit to any file changes the fingerprint
 * — so coalescing a prior verdict can never mask an unvalidated change.
 *
 * @param {{ files: string[], flags?: string[], io?: typeof defaultIo }} opts
 * @returns {string} hex digest
 */
export function computeFingerprint({ files, flags = [], io = defaultIo }) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ flags: [...flags].sort() }));
  for (const abs of [...files].sort()) {
    let digest;
    try {
      digest = crypto
        .createHash('sha256')
        .update(io.readFileBytes(abs))
        .digest('hex');
    } catch {
      digest = 'missing';
    }
    hash.update('\0');
    hash.update(abs);
    hash.update('\0');
    hash.update(digest);
  }
  return hash.digest('hex');
}

/**
 * Acquire the exclusive lock, blocking (via `sleep`) until the holder
 * exits or its pid is found dead. Prints the single waiting line through
 * `log` the first time it has to wait.
 *
 * @param {{
 *   lockPath: string,
 *   pid?: number,
 *   cwd?: string,
 *   waitMs?: number,
 *   pollMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   io?: typeof defaultIo,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{ acquired: boolean, timedOut?: boolean, waited: boolean,
 *   waitStartedAt: number, release?: () => void }>}
 */
export async function acquireLock({
  lockPath,
  pid = process.pid,
  cwd = process.cwd(),
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  io = defaultIo,
  log = () => {},
}) {
  const waitStartedAt = now();
  const deadline = waitStartedAt + waitMs;
  let announced = false;
  let waited = false;

  for (;;) {
    const payload = JSON.stringify({ pid, startedAt: waitStartedAt, cwd });
    if (io.createExclusive(lockPath, payload)) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        io.remove(lockPath);
      };
      return { acquired: true, waited, waitStartedAt, release };
    }

    // Held — reclaim a dead holder, otherwise wait.
    const holder = io.readJson(lockPath);
    if (!holder || !io.pidAlive(holder.pid)) {
      io.remove(lockPath);
      continue;
    }
    waited = true;
    if (!announced) {
      log(`⏳ waiting for another agent-validate (pid ${holder.pid})`);
      announced = true;
    }
    if (now() >= deadline) {
      return { acquired: false, timedOut: true, waited, waitStartedAt };
    }
    await sleep(pollMs);
  }
}

/**
 * Last-run record (`agent-validate-last.json`) or null when absent.
 *
 * @param {string} lastPath
 * @param {typeof defaultIo} [io]
 * @returns {{ fingerprint?: string, ok?: boolean, finishedAt?: number,
 *   summary?: string } | null}
 */
export function readLastResult(lastPath, io = defaultIo) {
  return io.readJson(lastPath);
}

/**
 * Persist the verdict of a run that held the lock, so a later waiter can
 * coalesce against it. Both passes AND failures are recorded.
 *
 * @param {string} lastPath
 * @param {{ fingerprint: string, ok: boolean, finishedAt: number,
 *   summary?: string }} result
 * @param {typeof defaultIo} [io]
 */
export function writeLastResult(lastPath, result, io = defaultIo) {
  io.writeJsonAtomic(lastPath, `${JSON.stringify(result)}\n`);
}

/**
 * A waiter may skip its own run only when the last verdict is for the
 * identical change set (same content-hash fingerprint) AND it finished
 * at or after the moment this caller began waiting — proving the holder
 * validated the very tree this caller would have, not an older one.
 *
 * @param {{ fingerprint?: string, ok?: boolean, finishedAt?: number } | null} last
 * @param {{ fingerprint: string, waitStartedAt: number }} caller
 * @returns {boolean}
 */
export function canCoalesce(last, { fingerprint, waitStartedAt }) {
  return (
    !!last &&
    last.fingerprint === fingerprint &&
    typeof last.finishedAt === 'number' &&
    last.finishedAt >= waitStartedAt
  );
}
