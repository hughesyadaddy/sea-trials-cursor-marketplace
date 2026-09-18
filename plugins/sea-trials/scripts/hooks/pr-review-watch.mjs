#!/usr/bin/env node
/**
 * Continuous PR review watcher — never exits on new Codex threads.
 *
 * Polls GitHub for unresolved review threads + CI on HEAD. On each new
 * thread (or count increase), writes pr-review-queue.json and pings the
 * operator (stdout sentinel + optional macOS notification).
 *
 *   pnpm pr-review-watch -- --pr 1606
 *   pnpm pr-review-watch -- --pr 1606 --interval 30 --notify
 *
 * Sentinel line (grep-friendly):
 *   [CODEX-ALERT] pr=1606 threads=N head=abcdef1
 *
 * Artifacts:
 *   docs/code-review/feat-std-2720-admin-qa-fixtures/pr-review-queue.json
 *   docs/code-review/feat-std-2720-admin-qa-fixtures/pr-<n>-watch-log.txt
 *   docs/code-review/feat-std-2720-admin-qa-fixtures/CODEX_ALERT.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildReviewSnapshot,
  getRepoRoot,
  resolvePrNumberFromBranch,
  reviewPaths,
  writeJson,
  writeReviewState,
} from './lib/pr-review-lib.mjs';

const repoRoot = getRepoRoot();
const argv = process.argv.slice(2).filter((a) => a !== '--');
const notify = argv.includes('--notify');
const filteredArgv = argv.filter((a) => a !== '--notify');

function parsePositiveSeconds(raw, flagName) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive number of seconds.`);
  }
  return value;
}

function parsePositivePrNumber(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('--pr must be a positive integer.');
  }
  return value;
}

function parseWatchArgs(watchArgv) {
  const intervalFlag = watchArgv.indexOf('--interval');
  const prFlag = watchArgv.indexOf('--pr');
  const intervalSec = intervalFlag >= 0
    ? parsePositiveSeconds(watchArgv[intervalFlag + 1], '--interval')
    : 30;
  return {
    prFromFlag: prFlag >= 0 ? parsePositivePrNumber(watchArgv[prFlag + 1]) : null,
    intervalSec,
  };
}

const { prFromFlag, intervalSec } = parseWatchArgs(filteredArgv);

const bootstrapLogPath = path.join(
  repoRoot,
  'docs',
  'code-review',
  'pr-watch-bootstrap',
  'pr-watch-log.txt',
);

/** @type {number | null} */
let prNumber = prFromFlag;

/** @type {Set<string>} */
const seenThreadIds = new Set();
/** @type {Map<string, number | null>} */
const seenThreadCommentIds = new Map();
let lastCount = -1;
/** @type {Set<string>} */
let lastUnresolvedIds = new Set();
let logPath = bootstrapLogPath;
/** @type {string | null} */
let queuePath = null;
/** @type {string | null} */
let statePath = null;
/** @type {string | null} */
let alertPath = null;

function logLine(line) {
  const row = `[${new Date().toISOString()}] ${line}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${row}\n`);
  process.stdout.write(`${row}\n`);
}

async function resolvePrNumber() {
  if (prNumber != null) {
    return prNumber;
  }
  while (true) {
    try {
      prNumber = resolvePrNumberFromBranch(repoRoot);
      return prNumber;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(`pr-error: ${message} — retrying in ${intervalSec}s`);
      await delay(intervalSec * 1000);
    }
  }
}

async function resolveWatcherPaths() {
  while (true) {
    try {
      const artifactPaths = reviewPaths(repoRoot, prNumber);
      const artifactDir = path.dirname(artifactPaths.queue);
      return {
        logPath: path.join(artifactDir, `pr-${prNumber}-watch-log.txt`),
        queuePath: path.join(repoRoot, artifactPaths.queue),
        statePath: path.join(repoRoot, artifactPaths.state),
        alertPath: path.join(repoRoot, artifactDir, 'CODEX_ALERT.txt'),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(`meta-error: ${message} — retrying in ${intervalSec}s`);
      await delay(intervalSec * 1000);
    }
  }
}

function macNotify(title, message) {
  if (!notify || process.platform !== 'darwin') return;
  const script =
    `display notification ${JSON.stringify(message)} `
    + `with title ${JSON.stringify(title)}`;
  spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
}

function clearAlertArtifacts() {
  if (queuePath == null || alertPath == null) {
    return;
  }
  if (fs.existsSync(queuePath)) {
    fs.unlinkSync(queuePath);
  }
  if (fs.existsSync(alertPath)) {
    fs.unlinkSync(alertPath);
  }
}

function markThreadsSeen(unresolved) {
  for (const t of unresolved) {
    seenThreadIds.add(t.id);
    seenThreadCommentIds.set(
      t.id,
      t.latestDatabaseId ?? t.databaseId ?? null,
    );
  }
}

function emitAlert(snapshot) {
  if (queuePath == null || alertPath == null) {
    throw new Error('watcher paths not initialized');
  }
  const head = snapshot.pr.headRefOid.slice(0, 7);
  const count = snapshot.threads.unresolvedCount;
  const lines = [
    `at=${snapshot.at}`,
    `pr=${prNumber}`,
    `head=${head}`,
    `threads=${count}`,
    '',
    ...snapshot.threads.unresolved.map(
      (t) => `${t.id} ${t.path}:${t.line ?? 0} ${t.preview ?? ''}`,
    ),
  ];
  fs.mkdirSync(path.dirname(alertPath), { recursive: true });
  fs.writeFileSync(alertPath, `${lines.join('\n')}\n`);
  writeQueueSnapshot(snapshot);
  const sentinel = `[CODEX-ALERT] pr=${prNumber} threads=${count} head=${head}`;
  logLine(sentinel);
  logLine(`queue: ${queuePath}`);
  logLine(`alert: ${alertPath}`);
  macNotify(
    `PR #${prNumber}: ${count} Codex thread(s)`,
    `head ${head} — see CODEX_ALERT.txt`,
  );
}

function writeQueueSnapshot(snapshot) {
  if (queuePath == null) {
    throw new Error('watcher paths not initialized');
  }
  writeJson(queuePath, {
    pr: prNumber,
    at: snapshot.at,
    kind: 'threads',
    threads: snapshot.threads.unresolved,
  });
}

function unresolvedSetChanged(currentUnresolvedIds) {
  if (currentUnresolvedIds.length !== lastUnresolvedIds.size) {
    return true;
  }
  return currentUnresolvedIds.some((id) => !lastUnresolvedIds.has(id));
}

function pollOnce() {
  if (statePath == null) {
    throw new Error('watcher paths not initialized');
  }
  const snapshot = buildReviewSnapshot(repoRoot, prNumber);
  writeReviewState(statePath, snapshot);
  const count = snapshot.threads.unresolvedCount;
  const head = snapshot.pr.headRefOid.slice(0, 7);
  const ci =
    snapshot.ci.hasFailure
      ? `fail=${snapshot.ci.failed.length}`
      : snapshot.ci.hasPending
        ? `pending=${snapshot.ci.pending.length}`
        : 'green';

  const currentUnresolvedIds = snapshot.threads.unresolved.map((t) => t.id);
  const newlyUnresolved = currentUnresolvedIds.filter(
    (id) => !lastUnresolvedIds.has(id),
  );

  const replyUpdates = snapshot.threads.unresolved.filter((t) => {
    if (!seenThreadIds.has(t.id)) {
      return false;
    }
    const latestId = t.latestDatabaseId ?? t.databaseId;
    const priorId = seenThreadCommentIds.get(t.id);
    return priorId != null && latestId != null && latestId !== priorId;
  });

  const countIncreased = lastCount >= 0 && count > lastCount;
  const shouldAlert =
    newlyUnresolved.length > 0 || countIncreased || replyUpdates.length > 0;
  const setChanged = unresolvedSetChanged(currentUnresolvedIds);

  if (shouldAlert) {
    emitAlert(snapshot);
    lastCount = count;
    markThreadsSeen(snapshot.threads.unresolved);
  } else {
    if (setChanged) {
      if (count === 0) {
        clearAlertArtifacts();
      } else {
        writeQueueSnapshot(snapshot);
        logLine(`queue-refresh: head=${head} threads=${count}`);
      }
    } else {
      logLine(
        `poll: head=${head} threads=${count} ci=${ci}`,
      );
    }
    markThreadsSeen(snapshot.threads.unresolved);
    lastCount = count;
  }

  lastUnresolvedIds = new Set(currentUnresolvedIds);

  if (count === 0) {
    clearAlertArtifacts();
  }

  if (
    count === 0
    && !snapshot.ci.hasPending
    && !snapshot.ci.hasFailure
  ) {
    logLine('READY — zero threads, CI green (merge candidate)');
  }

  return snapshot;
}

function pollOnceSafe() {
  try {
    return pollOnce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`poll-error: ${message} — retrying next interval`);
    return null;
  }
}

async function main() {
  await resolvePrNumber();
  const paths = await resolveWatcherPaths();
  logPath = paths.logPath;
  queuePath = paths.queuePath;
  statePath = paths.statePath;
  alertPath = paths.alertPath;

  logLine(
    `WATCH pr=${prNumber} interval=${intervalSec}s notify=${notify} `
      + `repo=${repoRoot}`,
  );
  logLine(`log: ${logPath}`);
  pollOnceSafe();

  while (true) {
    await delay(intervalSec * 1000);
    pollOnceSafe();
  }
}

await main();
