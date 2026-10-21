import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireLock,
  canCoalesce,
  computeFingerprint,
  LOCK_TIMEOUT_EXIT,
  lockWaitMs,
  readLastResult,
  singleFlightEnabled,
  writeLastResult,
} from './single-flight.mjs';

const LOCK = '/tmp/agent-validate.lock';

/** In-memory io seam so every branch runs without a real fs or pids. */
function fakeIo(seedFiles = {}) {
  const files = new Map(Object.entries(seedFiles));
  const alive = new Set();
  return {
    files,
    alive,
    createExclusive(p, contents) {
      if (files.has(p)) return false;
      files.set(p, contents);
      return true;
    },
    readJson(p) {
      try {
        return JSON.parse(files.get(p));
      } catch {
        return null;
      }
    },
    remove(p) {
      files.delete(p);
    },
    readFileBytes(p) {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return Buffer.from(files.get(p));
    },
    writeJsonAtomic(p, text) {
      files.set(p, text);
    },
    pidAlive(pid) {
      return alive.has(pid);
    },
  };
}

const neverSleep = async () => {};

test('acquireLock takes a free lock and writes the holder payload', async () => {
  const io = fakeIo();
  const res = await acquireLock({
    lockPath: LOCK,
    pid: 42,
    cwd: '/repo',
    now: () => 1000,
    sleep: neverSleep,
    io,
  });
  assert.equal(res.acquired, true);
  assert.equal(res.waited, false);
  assert.equal(res.waitStartedAt, 1000);
  const holder = JSON.parse(io.files.get(LOCK));
  assert.equal(holder.pid, 42);
  assert.equal(holder.cwd, '/repo');

  // release removes the lock and is idempotent.
  res.release();
  res.release();
  assert.equal(io.files.has(LOCK), false);
});

test('acquireLock reclaims a lock whose holder pid is dead', async () => {
  const io = fakeIo({ [LOCK]: JSON.stringify({ pid: 999, cwd: '/old' }) });
  // 999 is NOT in alive -> treated as dead and reclaimed.
  const res = await acquireLock({
    lockPath: LOCK,
    pid: 7,
    now: () => 5,
    sleep: neverSleep,
    io,
  });
  assert.equal(res.acquired, true);
  assert.equal(res.waited, false);
  assert.equal(JSON.parse(io.files.get(LOCK)).pid, 7);
});

test('acquireLock waits for a live holder, then acquires on release', async () => {
  const io = fakeIo({ [LOCK]: JSON.stringify({ pid: 999, cwd: '/held' }) });
  io.alive.add(999);
  let announced = 0;
  let slept = 0;
  const res = await acquireLock({
    lockPath: LOCK,
    pid: 7,
    waitMs: 10_000,
    now: () => 1000,
    sleep: async () => {
      slept += 1;
      if (slept === 1) io.remove(LOCK); // holder exits mid-wait
    },
    io,
    log: () => {
      announced += 1;
    },
  });
  assert.equal(res.acquired, true);
  assert.equal(res.waited, true);
  assert.equal(slept, 1);
  assert.equal(announced, 1, 'the waiting line prints exactly once');
});

test('acquireLock times out while a live holder keeps the lock (=> exit 75)', async () => {
  const io = fakeIo({ [LOCK]: JSON.stringify({ pid: 999 }) });
  io.alive.add(999);
  let clock = 0;
  const res = await acquireLock({
    lockPath: LOCK,
    pid: 7,
    waitMs: 0, // deadline == waitStartedAt, so the first check expires
    now: () => clock++,
    sleep: neverSleep,
    io,
  });
  assert.equal(res.acquired, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.waited, true);
  assert.equal(LOCK_TIMEOUT_EXIT, 75);
});

test('computeFingerprint is content-addressed over files and flags', () => {
  const io = fakeIo({ '/a.dart': 'void a() {}', '/b.dart': 'void b() {}' });
  const base = computeFingerprint({ files: ['/a.dart', '/b.dart'], io });

  // Order-independent.
  assert.equal(
    computeFingerprint({ files: ['/b.dart', '/a.dart'], io }),
    base,
  );
  // A content edit changes it (so a newer edit can never be coalesced away).
  io.files.set('/a.dart', 'void a() { return; }');
  assert.notEqual(computeFingerprint({ files: ['/a.dart', '/b.dart'], io }), base);
  // A flag change changes it.
  io.files.set('/a.dart', 'void a() {}');
  assert.notEqual(
    computeFingerprint({ files: ['/a.dart', '/b.dart'], flags: ['tests-only'], io }),
    base,
  );
  // A missing file is distinct from a present one but still deterministic.
  const missing = computeFingerprint({ files: ['/gone.dart'], io });
  assert.equal(computeFingerprint({ files: ['/gone.dart'], io }), missing);
});

test('canCoalesce requires same fingerprint AND a fresh-enough result', () => {
  const fp = 'deadbeef';
  const waitStartedAt = 1000;
  // Match: same fp, finished at/after we began waiting.
  assert.equal(
    canCoalesce({ fingerprint: fp, ok: true, finishedAt: 1500 }, { fingerprint: fp, waitStartedAt }),
    true,
  );
  // Also coalesces a FAILURE with the same fingerprint.
  assert.equal(
    canCoalesce({ fingerprint: fp, ok: false, finishedAt: 1000 }, { fingerprint: fp, waitStartedAt }),
    true,
  );
  // Different fingerprint -> no coalesce.
  assert.equal(
    canCoalesce({ fingerprint: 'other', ok: true, finishedAt: 2000 }, { fingerprint: fp, waitStartedAt }),
    false,
  );
  // Stale result (finished before we started waiting) -> no coalesce.
  assert.equal(
    canCoalesce({ fingerprint: fp, ok: true, finishedAt: 999 }, { fingerprint: fp, waitStartedAt }),
    false,
  );
  // No prior result -> no coalesce.
  assert.equal(canCoalesce(null, { fingerprint: fp, waitStartedAt }), false);
});

test('writeLastResult / readLastResult round-trip', () => {
  const io = fakeIo();
  const result = { fingerprint: 'abc', ok: false, finishedAt: 42, pid: 7, summary: 'x' };
  writeLastResult('/tmp/last.json', result, io);
  assert.deepEqual(readLastResult('/tmp/last.json', io), result);
  assert.equal(readLastResult('/tmp/missing.json', io), null);
});

test('env toggles', () => {
  assert.equal(singleFlightEnabled({}), true);
  assert.equal(singleFlightEnabled({ ST_AGENT_VALIDATE_LOCK: '0' }), false);
  assert.equal(singleFlightEnabled({ ST_AGENT_VALIDATE_LOCK: '1' }), true);

  assert.equal(lockWaitMs({}), 30 * 60 * 1000);
  assert.equal(lockWaitMs({ ST_AGENT_VALIDATE_LOCK_WAIT_MS: '5000' }), 5000);
  assert.equal(lockWaitMs({ ST_AGENT_VALIDATE_LOCK_WAIT_MS: 'nope' }), 30 * 60 * 1000);
  assert.equal(lockWaitMs({ ST_AGENT_VALIDATE_LOCK_WAIT_MS: '-5' }), 30 * 60 * 1000);
});
