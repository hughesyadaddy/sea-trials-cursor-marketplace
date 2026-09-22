/**
 * Machine-wide weighted slots for gate tasks run by independent
 * processes.
 *
 * `runParallelLimited` throttles tasks inside ONE process. Subagent
 * fan-out runs every `run-gate-task` in its own process, so sixteen
 * workers can each start a `dart analyze` at the same moment on the
 * same laptop. Slots are lock files under the OS temp dir keyed by the
 * repo; a task holding `weight` slots blocks others until it exits.
 * Dead holders (pid gone) are reclaimed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLL_MS = 400;

/** @param {number} pid */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * @param {string} repoRoot
 * @param {string} [tmpDir]
 */
export function slotDir(repoRoot, tmpDir = os.tmpdir()) {
  const key = crypto
    .createHash('sha1')
    .update(path.resolve(repoRoot))
    .digest('hex')
    .slice(0, 12);
  return path.join(tmpDir, `st-gate-slots-${key}`);
}

/** Default budget mirrors `runParallelLimited`. */
export function defaultBudget(cpuCount = os.cpus().length) {
  return Math.max(cpuCount, 2);
}

/**
 * @param {string} dir
 * @param {number} index
 * @param {number} pid
 * @returns {boolean} true when the slot was taken
 */
function tryTakeSlot(dir, index, pid) {
  const file = path.join(dir, `slot-${index}.lock`);
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, String(pid));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }
  let holder = NaN;
  try {
    holder = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  } catch {
    holder = NaN;
  }
  if (!pidAlive(holder)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // raced another reclaimer
    }
    return tryTakeSlot(dir, index, pid);
  }
  return false;
}

/**
 * Block until `weight` slots are held. Returns a release function.
 * Never waits longer than `timeoutMs`; on timeout it proceeds anyway
 * (a slow gate beats a deadlocked one) and reports `timedOut: true`.
 *
 * @param {{
 *   repoRoot: string,
 *   weight: number,
 *   budget?: number,
 *   timeoutMs?: number,
 *   pid?: number,
 *   tmpDir?: string,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 */
export async function acquireSlots({
  repoRoot,
  weight,
  budget = defaultBudget(),
  timeoutMs = 15 * 60 * 1000,
  pid = process.pid,
  tmpDir,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const need = Math.max(1, Math.min(Math.floor(weight) || 1, budget));
  const dir = slotDir(repoRoot, tmpDir);
  fs.mkdirSync(dir, { recursive: true });

  /** @type {number[]} */
  const held = [];
  const release = () => {
    for (const index of held.splice(0)) {
      try {
        fs.unlinkSync(path.join(dir, `slot-${index}.lock`));
      } catch {
        // already gone
      }
    }
  };

  const deadline = Date.now() + timeoutMs;
  let waitedMs = 0;
  for (;;) {
    for (let i = 0; i < budget && held.length < need; i += 1) {
      if (held.includes(i)) continue;
      if (tryTakeSlot(dir, i, pid)) held.push(i);
    }
    if (held.length >= need) {
      return { release, held: [...held], waitedMs, timedOut: false };
    }
    if (Date.now() >= deadline) {
      return { release, held: [...held], waitedMs, timedOut: true };
    }
    await sleep(POLL_MS);
    waitedMs += POLL_MS;
  }
}
