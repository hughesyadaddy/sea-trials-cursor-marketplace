/**
 * Shared helpers for pr-review-daemon — PID lock, deduped sentinels,
 * signal files, and handoff ack protocol.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Repo-relative daemon artifact paths for one PR.
 *
 * @param {string} headRefName
 * @param {number} prNumber
 */
export function daemonArtifactPaths(headRefName, prNumber) {
  const scope = (headRefName ?? `pr-${prNumber}`).replace(/\//g, '-');
  const artifactDir = path.join('docs', 'code-review', scope);
  return {
    artifactDir,
    signal: path.join(artifactDir, `pr-${prNumber}-acting.signal`),
    monitorLast: path.join(artifactDir, `pr-${prNumber}-monitor-last.txt`),
    handoffAck: path.join(artifactDir, `pr-${prNumber}-handoff.ack`),
    daemonLog: path.join(artifactDir, `pr-${prNumber}-daemon-log.txt`),
    pid: path.join(artifactDir, `.pr-${prNumber}-daemon.pid`),
  };
}

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof daemonArtifactPaths>} rel
 */
export function daemonPathsAbs(repoRoot, rel) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(rel)) {
    out[key] = path.join(repoRoot, value);
  }
  return out;
}

/**
 * @param {string} pidFile
 * @returns {{ ok: true } | { ok: false, reason: string, pid?: number }}
 */
export function acquirePidLock(pidFile) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  if (fs.existsSync(pidFile)) {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const existing = Number(raw);
    if (Number.isInteger(existing) && existing > 0) {
      try {
        process.kill(existing, 0);
        return { ok: false, reason: 'already running', pid: existing };
      } catch {
        // stale
      }
    }
  }
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  return { ok: true };
}

/** @param {string} pidFile */
export function releasePidLock(pidFile) {
  try {
    if (fs.existsSync(pidFile)) {
      const raw = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (raw === process.pid) {
        fs.unlinkSync(pidFile);
      }
    }
  } catch {
    // best effort
  }
}

/**
 * Deduped stdout + signal writer (chat monitor pattern).
 *
 * @param {{ signalFile: string, monitorLastFile: string, log: (line: string) => void }} opts
 */
export function createDedupEmitter({ signalFile, monitorLastFile, log }) {
  let lastLine = '';
  try {
    if (fs.existsSync(monitorLastFile)) {
      lastLine = fs.readFileSync(monitorLastFile, 'utf8').trim();
    }
  } catch {
    lastLine = '';
  }

  /**
   * @param {'ACTION'|'WAIT'|'GREEN'} kind
   * @param {string} detail
   * @param {string} [signalKind]
   */
  const emit = (kind, detail, signalKind = kind) => {
    const line = `>>> ${kind}: ${detail}`;
    if (line === lastLine) {
      return false;
    }
    lastLine = line;
    fs.mkdirSync(path.dirname(monitorLastFile), { recursive: true });
    fs.writeFileSync(monitorLastFile, `${line}\n`);
    const iso = new Date().toISOString();
    fs.writeFileSync(signalFile, `${signalKind} ${iso} ${detail}\n`);
    log(line);
    return true;
  };

  return { emit, lastLine: () => lastLine };
}

/**
 * @param {string} ackFile
 * @returns {boolean}
 */
export function hasHandoffAck(ackFile) {
  return fs.existsSync(ackFile);
}

/** @param {string} ackFile */
export function clearHandoffAck(ackFile) {
  try {
    if (fs.existsSync(ackFile)) {
      fs.unlinkSync(ackFile);
    }
  } catch {
    // ignore
  }
}

/**
 * Format the compact status suffix used in monitor lines.
 *
 * @param {import('./pr-review-lib.mjs').ReturnType<typeof import('./pr-review-lib.mjs').buildReviewSnapshot>} snapshot
 * @param {string} [settledState]
 */
export function formatStatusDetail(snapshot, settledState) {
  const threads = snapshot.threads.unresolvedCount;
  const bot = snapshot.threads.unresolvedBotCount;
  const ci = snapshot.ci ?? {};
  const pending = ci.pending ?? [];
  const failed = ci.failed ?? [];
  const pendingN = pending.length;
  const failN = failed.length;
  const passN = Math.max(0, (ci.total ?? 0) - pendingN - failN);
  const ciPart =
    `ci total=${ci.total ?? 0} pass=${passN} `
    + `pending=${pendingN} fail=${failN}`;
  const settled = settledState ? ` settled=${settledState}` : '';
  return `threads=${threads} unresolved=${threads} (bot=${bot}) | ${ciPart}${settled}`;
}

/**
 * Classify the monitor state for one poll.
 *
 * Matches the proven chat monitor: CI fail and open threads are always
 * ACTION (fix immediately — never wait for the next Codex pass). WAIT
 * only when threads are clear but CI is still running or bots are still
 * reviewing. GREEN when threads=0 and CI is green.
 *
 * @param {ReturnType<typeof import('./pr-review-lib.mjs').buildReviewSnapshot>} snapshot
 * @param {string} machineState
 */
export function classifyMonitorState(snapshot, machineState) {
  if (snapshot.ci.hasFailure) {
    return { kind: 'ACTION', signal: 'CI_FAIL', reason: 'ci-fail' };
  }
  if (snapshot.threads.unresolvedCount > 0) {
    return { kind: 'ACTION', signal: 'THREADS', reason: 'threads' };
  }
  if (
    snapshot.threads.unresolvedCount === 0
    && !snapshot.ci.hasPending
    && !snapshot.ci.hasFailure
  ) {
    return { kind: 'GREEN', signal: 'GREEN', reason: 'green' };
  }
  if (snapshot.ci.hasPending) {
    return { kind: 'WAIT', signal: 'WAIT', reason: 'ci-pending' };
  }
  return { kind: 'WAIT', signal: 'WAIT', reason: machineState.toLowerCase() };
}
