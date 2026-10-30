#!/usr/bin/env node
/**
 * PR review loop — adaptive "bot review settled" watch after each push.
 *
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs --pr <n>
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs --pr <n> --once
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs --pr <n> --json          # snapshot per poll
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs --pr <n> --webhook       # gh webhook fast path
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs --pr <n> --bots aireview,bugbot
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs --pr <n> --silence 30    # hard cap (minutes)
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs --pr <n> --interval 30   # REVIEWING poll (s)
 *
 * Replaces the flat 30-minute silence window with the settled machine
 * in lib/bot-review-settled.mjs: 20s grace → wait for a bot ack (≤3 min,
 * e.g. the AI Review (advisory) `review` job starting; never re-pokes a
 * bot) → ETag-conditional REST every 30s (GraphQL only
 * when something changed; 60s while CI is pending) → two quiet polls →
 * 3-minute quiet window → act or finish. `--silence` remains the
 * absolute cap so nothing waits longer than before.
 *
 * Exit codes:
 *   0 — settled, zero threads, CI green on HEAD
 *   2 — open review threads (queue written)
 *   3 — CI failures on HEAD
 *   8 — CI still pending at the silence cap
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  STATES,
  createGhAdapter,
  createSettledPoller,
  createWakeableSleep,
} from './lib/bot-review-settled.mjs';
import { recordRun } from './lib/gate-telemetry.mjs';
import {
  buildReviewSnapshot,
  evaluateSnapshot,
  getRepoRoot,
  parsePrArgs,
  pruneClosedReviewArtifacts,
  resolveGithubOwnerRepo,
  reviewPaths,
  silenceWindowStartIso,
} from './lib/pr-review-lib.mjs';
import {
  createFullSnapshot,
  createRefreshThreads,
  createWriteQueue,
  settledConfigFromArgs,
  startReviewWebhook,
} from './lib/review-loop-watch.mjs';

const repoRoot = getRepoRoot();
const args = parsePrArgs(process.argv.slice(2));
const { once, prNumber, json } = args;

/** Set when the watch starts; the terminal telemetry row measures from it. */
let watchStartedAt = Date.now();

/**
 * Telemetry row per loop iteration (kind `review-loop`). `ok` means no
 * unresolved bot thread and no CI failure at the end of the iteration.
 *
 * @param {ReturnType<typeof buildReviewSnapshot>} snapshot
 * @param {{ task: string, phase: string, ms: number }} fields
 */
function tellIteration(snapshot, fields) {
  recordRun({
    kind: 'review-loop',
    task: fields.task,
    phase: fields.phase,
    ms: fields.ms,
    ok:
      (snapshot?.threads?.unresolvedBotCount ?? 0) === 0 &&
      !snapshot?.ci?.hasFailure,
    pr: prNumber,
    repoRoot,
  });
}

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

const writeQueue = createWriteQueue({ prNumber, queuePath, logLine });

const fullSnapshot = createFullSnapshot({
  buildReviewSnapshot,
  repoRoot,
  prNumber,
  statePath,
});

function pollOnce() {
  const snapshot = fullSnapshot(null);
  const verdict = evaluateSnapshot(snapshot);

  logLine(
    `instant: head=${snapshot.pr.headRefOid.slice(0, 7)} `
      + `threads=${snapshot.threads.unresolvedCount} `
      + `(bot=${snapshot.threads.unresolvedBotCount}) `
      + `ci pending=${snapshot.ci.pending.length} `
      + `fail=${snapshot.ci.failed.length}`,
  );

  if (snapshot.threads.unresolvedCount > 0) {
    writeQueue(snapshot, 'threads', { threads: snapshot.threads.unresolved });
  } else if (snapshot.ci.hasFailure) {
    writeQueue(snapshot, 'ci-fail', { failed: snapshot.ci.failed });
    for (const row of snapshot.ci.failed) {
      logLine(`  FAIL ${row.name} ${row.link}`);
    }
  }
  if (json) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  return { snapshot, verdict };
}

/**
 * Terminal handoff: queue + exit code from the last full snapshot.
 *
 * @param {ReturnType<typeof buildReviewSnapshot>} snapshot
 * @param {string} reason
 */
function exitForSnapshot(snapshot, reason) {
  const verdict = evaluateSnapshot(snapshot);
  tellIteration(snapshot, {
    task: 'final',
    phase: reason,
    ms: Date.now() - watchStartedAt,
  });
  if (snapshot.threads.unresolvedCount > 0) {
    writeQueue(snapshot, 'threads', { threads: snapshot.threads.unresolved });
    logLine(
      `ACT — ${snapshot.threads.unresolvedCount} unresolved thread(s) `
        + `(${snapshot.threads.unresolvedBotCount} bot) after ${reason}`,
    );
    process.exit(2);
  }
  if (snapshot.ci.hasFailure) {
    writeQueue(snapshot, 'ci-fail', { failed: snapshot.ci.failed });
    logLine('ABORT — CI failures on HEAD');
    for (const row of snapshot.ci.failed) {
      logLine(`  FAIL ${row.name} ${row.link}`);
    }
    process.exit(3);
  }
  if (snapshot.ci.hasPending) {
    logLine(`TIMEOUT — CI still pending (${reason})`);
    process.exit(8);
  }
  logLine(`COMPLETE — threads clear, CI green, bots settled (${reason})`);
  process.exit(verdict.exitCode);
}

async function main() {
  if (once) {
    const { verdict } = pollOnce();
    process.exit(verdict.exitCode);
  }

  const repo = resolveGithubOwnerRepo(repoRoot);
  const pruned = pruneClosedReviewArtifacts(repoRoot, {
    activePrNumbers: [prNumber],
  });
  if (pruned.pruned.length > 0) {
    logLine(`pruned stale review artifacts for PR(s): ${pruned.pruned.join(', ')}`);
  }
  const cfg = settledConfigFromArgs(args);
  const sleeper = createWakeableSleep();

  /** @type {ReturnType<typeof fullSnapshot>} */
  let initial;
  while (true) {
    try {
      initial = fullSnapshot(null);
      break;
    } catch (err) {
      logLine(
        `initial-snapshot-error: ${err.message} — retry in 60s`,
      );
      await sleeper.sleep(60_000);
    }
  }

  const pushIso = silenceWindowStartIso(
    repoRoot,
    prNumber,
    initial.pr.headRefOid,
    initial.pr.headRefName,
  );
  const t0 = new Date(pushIso).getTime();
  watchStartedAt = Date.now();

  let latest = initial;
  let rateLimitedUntil = 0;
  /** @type {ReturnType<typeof createSettledPoller> | null} */
  const pollerRef = { current: null };

  const refreshThreads = createRefreshThreads({
    fullSnapshot,
    pollerRef,
    onSnapshot: (snap) => {
      latest = snap;
    },
    onRateLimited: (untilMs) => {
      rateLimitedUntil = untilMs;
    },
    logLine,
  });

  pollerRef.current = createSettledPoller({
    repo,
    prNumber,
    head: initial.pr.headRefOid,
    t0,
    adapter: createGhAdapter(repoRoot),
    refreshThreads,
    enabledBots: args.bots,
    cfg,
    log: logLine,
  });

  const webhook = await startReviewWebhook({
    enabled: args.webhook,
    webhookPort: args.webhookPort,
    repo,
    wake: () => sleeper.wake(),
    logLine,
    webhookLogLabel: 'polling now',
  });

  logLine(
    `WATCH pr=${prNumber} head=${initial.pr.headRefOid.slice(0, 7)} `
      + `t0=${pushIso} cap=${cfg.maxSilenceMs / 60_000}m `
      + `bots=${args.bots?.join(',') ?? 'auto'} webhook=${Boolean(webhook)}`,
  );

  if (initial.ci.hasFailure) {
    exitForSnapshot(initial, 'initial poll');
  }

  let iterationStartedAt = Date.now();
  while (true) {
    let result;
    try {
      result = pollerRef.current.poll();
    } catch (err) {
      logLine(`poll-error: ${err.message} — retrying in 60s`);
      await sleeper.sleep(60_000);
      continue;
    }
    const { machine } = result;
    if (json) {
      process.stdout.write(`${JSON.stringify(pollerRef.current.snapshot())}\n`);
    }
    tellIteration(latest, {
      task: 'iteration',
      phase: String(machine.state).toLowerCase(),
      ms: Date.now() - iterationStartedAt,
    });
    iterationStartedAt = Date.now();

    if (latest.ci.hasFailure) {
      await webhook?.stop();
      exitForSnapshot(latest, machine.state);
    }

    if (machine.state === STATES.ACTING || machine.state === STATES.DONE) {
      await webhook?.stop();
      try {
        latest = fullSnapshot(pollerRef.current);
      } catch (err) {
        logLine(
          `terminal-snapshot-error: ${err.message} — retry in 60s`,
        );
        await sleeper.sleep(60_000);
        continue;
      }
      exitForSnapshot(latest, machine.state.toLowerCase());
    }

    const remainingCapMin = Math.max(
      0,
      Math.ceil((machine.t0 + cfg.maxSilenceMs - Date.now()) / 60_000),
    );
    const nextSec = Math.round(result.nextPollMs / 1000);
    logLine(
      `${machine.state} threads=${machine.unresolvedThreads ?? '?'} `
        + `ci=${machine.ciPending ? 'pending' : 'ok'} `
        + `next=${nextSec}s cap_in=${remainingCapMin}m`,
    );

    let waitMs = Math.max(result.nextPollMs, 1_000);
    if (rateLimitedUntil > Date.now()) {
      waitMs = Math.max(waitMs, rateLimitedUntil - Date.now());
    }
    await sleeper.sleep(waitMs);
  }
}

main().catch((err) => {
  logLine(`pr-review-loop: ${err.message}`);
  process.exit(2);
});
