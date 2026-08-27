#!/usr/bin/env node
/**
 * PR review loop — instant polls for threads + CI after each push.
 *
 *   pnpm pr-review-loop
 *   pnpm pr-review-loop -- --once
 *   pnpm pr-review-loop -- --interval 15 --silence 30
 *
 * Exit codes:
 *   0 — silence window met, zero threads, CI green on HEAD
 *   2 — open review threads (queue written)
 *   3 — CI failures on HEAD
 *   8 — CI still pending (watch mode continues)
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildReviewSnapshot,
  evaluateSnapshot,
  getRepoRoot,
  parsePrArgs,
  reviewPaths,
  silenceWindowStartIso,
  writeJson,
  writeReviewState,
} from './lib/pr-review-lib.mjs';

const repoRoot = getRepoRoot();
const { once, prNumber, intervalSec, silenceMin } = parsePrArgs(
  process.argv.slice(2),
);

const artifactPaths = reviewPaths(repoRoot, prNumber);
const logPath = path.join(repoRoot, artifactPaths.loopLog);
const queuePath = path.join(repoRoot, artifactPaths.queue);
const statePath = path.join(repoRoot, artifactPaths.state);

function logLine(line) {
  const row = `[${new Date().toISOString()}] ${line}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${row}\n`);
  process.stdout.write(`${row}\n`);
}

function pollOnce() {
  const snapshot = buildReviewSnapshot(repoRoot, prNumber);
  const verdict = evaluateSnapshot(snapshot);
  writeReviewState(statePath, snapshot);

  logLine(
    `instant: head=${snapshot.pr.headRefOid.slice(0, 7)} `
      + `threads=${snapshot.threads.unresolvedCount} `
      + `ci pending=${snapshot.ci.pending.length} `
      + `fail=${snapshot.ci.failed.length}`,
  );

  if (snapshot.threads.unresolvedCount > 0) {
    writeJson(queuePath, {
      pr: prNumber,
      at: snapshot.at,
      kind: 'threads',
      threads: snapshot.threads.unresolved,
    });
    logLine(`queue: ${queuePath}`);
    return { snapshot, verdict, abort: true };
  }

  if (snapshot.ci.hasFailure) {
    writeJson(queuePath, {
      pr: prNumber,
      at: snapshot.at,
      kind: 'ci-fail',
      failed: snapshot.ci.failed,
    });
    logLine('ABORT — CI failures on HEAD');
    for (const row of snapshot.ci.failed) {
      logLine(`  FAIL ${row.name} ${row.link}`);
    }
    return { snapshot, verdict, abort: true };
  }

  if (snapshot.ci.hasPending) {
    logLine(
      `WAIT — CI pending: ${snapshot.ci.pending.slice(0, 5).join(', ')}`
        + (snapshot.ci.pending.length > 5 ? '…' : ''),
    );
    return { snapshot, verdict, abort: false, pending: true };
  }

  return { snapshot, verdict, abort: false, pending: false };
}

async function main() {
  if (once) {
    const { verdict } = pollOnce();
    process.exit(verdict.exitCode);
  }

  const initial = buildReviewSnapshot(repoRoot, prNumber);
  let pushIso = silenceWindowStartIso(
    repoRoot,
    prNumber,
    initial.pr.headRefOid,
    initial.pr.headRefName,
  );
  let endAt = new Date(new Date(pushIso).getTime() + silenceMin * 60 * 1000);
  let trackedHead = initial.pr.headRefOid;

  logLine(
    `WATCH interval=${intervalSec}s silence=${silenceMin}m `
      + `push_at=${pushIso} end_at=${endAt.toISOString()} head=${trackedHead.slice(0, 7)}`,
  );

  while (true) {
    while (Date.now() < endAt.getTime()) {
      const result = pollOnce();

      const head = result.snapshot.pr.headRefOid;
      if (head !== trackedHead) {
        trackedHead = head;
        pushIso = silenceWindowStartIso(
          repoRoot,
          prNumber,
          head,
          result.snapshot.pr.headRefName,
        );
        endAt = new Date(new Date(pushIso).getTime() + silenceMin * 60 * 1000);
        logLine(
          `NEW PUSH head=${head.slice(0, 7)} — reset silence to ${endAt.toISOString()}`,
        );
      }

      if (result.abort) {
        process.exit(result.verdict.exitCode);
      }

      const remaining = Math.ceil((endAt.getTime() - Date.now()) / 60000);
      if (remaining <= 0) {
        break;
      }
      const status = result.pending ? 'ci-pending' : 'clean';
      logLine(`${status}; ${remaining}m until silence window closes`);
      await delay(intervalSec * 1000);
    }

    const final = pollOnce();
    const head = final.snapshot.pr.headRefOid;
    if (head !== trackedHead) {
      trackedHead = head;
      pushIso = silenceWindowStartIso(
        repoRoot,
        prNumber,
        head,
        final.snapshot.pr.headRefName,
      );
      endAt = new Date(new Date(pushIso).getTime() + silenceMin * 60 * 1000);
      logLine(
        `NEW PUSH head=${head.slice(0, 7)} — reset silence to ${endAt.toISOString()}`,
      );
      continue;
    }

    if (final.abort) {
      process.exit(final.verdict.exitCode);
    }
    if (final.pending) {
      logLine('TIMEOUT — CI still pending at silence window end');
      process.exit(8);
    }

    logLine('COMPLETE — threads clear, CI green, silence window met');
    process.exit(0);
  }
}

await main();
