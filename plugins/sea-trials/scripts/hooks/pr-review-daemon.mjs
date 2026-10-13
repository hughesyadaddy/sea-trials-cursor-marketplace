#!/usr/bin/env node
/**
 * 24h PR review daemon — never exits on handoff; wakes the parent agent
 * via deduped sentinels and signal files.
 *
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs --pr <n>
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs --pr <n> --no-webhook
 *   node $ST_PLUGIN_ROOT/scripts/hooks/pr-review-daemon.mjs --pr <n> --duration 24h
 *
 * Sentinels (grep / Await-friendly):
 *   >>> ACTION: ci-fail|threads …
 *   >>> WAIT: …
 *   >>> GREEN: …
 *
 * Artifacts (docs/code-review/<scope>/):
 *   pr-<n>-acting.signal, pr-<n>-monitor-last.txt,
 *   pr-<n>-handoff.ack, pr-<n>-daemon-log.txt, .pr-<n>-daemon.pid
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createGhAdapter,
  createSettledPoller,
  createWakeableSleep,
} from './lib/bot-review-settled.mjs';
import {
  acquirePidLock,
  classifyMonitorState,
  clearHandoffAck,
  createDedupEmitter,
  daemonArtifactPaths,
  daemonPathsAbs,
  formatStatusDetail,
  hasHandoffAck,
  releasePidLock,
} from './lib/pr-review-daemon-lib.mjs';
import {
  buildReviewSnapshot,
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
const argv = process.argv.slice(2).filter((a) => a !== '--');

function parseDurationMs(raw) {
  if (!raw) return 24 * 60 * 60_000;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`invalid --duration: ${raw}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'h').toLowerCase();
  const mult =
    unit === 'ms' ? 1
      : unit === 's' ? 1000
        : unit === 'm' ? 60_000
          : unit === 'h' ? 3_600_000
            : 86_400_000;
  return n * mult;
}

const noWebhook = argv.includes('--no-webhook');
const durationFlag = argv.indexOf('--duration');
const durationMs = durationFlag >= 0
  ? parseDurationMs(argv[durationFlag + 1])
  : 24 * 60 * 60_000;

const args = parsePrArgs(argv, { silence: 30, interval: 15 });
const { prNumber, json } = args;
const webhookEnabled = !noWebhook;

/** @type {ReturnType<typeof reviewPaths>} */
let artifactRel;
/** @type {ReturnType<typeof daemonPathsAbs>} */
let paths;

function initPaths() {
  artifactRel = reviewPaths(repoRoot, prNumber);
  const scope = path.basename(artifactRel.artifactDir);
  const daemonRel = daemonArtifactPaths(scope, prNumber);
  paths = {
    ...daemonPathsAbs(repoRoot, daemonRel),
    queue: path.join(repoRoot, artifactRel.queue),
    state: path.join(repoRoot, artifactRel.state),
  };
}

function logLine(line) {
  const row = `[${new Date().toISOString()}] ${line}`;
  fs.mkdirSync(path.dirname(paths.daemonLog), { recursive: true });
  fs.appendFileSync(paths.daemonLog, `${row}\n`);
  process.stdout.write(`${row}\n`);
}

async function main() {
  initPaths();
  const lock = acquirePidLock(paths.pid);
  if (!lock.ok) {
    logLine(`refusing start: daemon already running (pid ${lock.pid})`);
    process.exit(1);
  }

  const releaseLock = () => {
    releasePidLock(paths.pid);
  };
  process.on('exit', releaseLock);
  process.once('SIGINT', () => {
    releaseLock();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    releaseLock();
    process.exit(143);
  });

  const writeQueue = createWriteQueue({
    prNumber,
    queuePath: paths.queue,
    logLine,
  });

  const fullSnapshot = createFullSnapshot({
    buildReviewSnapshot,
    repoRoot,
    prNumber,
    statePath: paths.state,
  });

  const emitter = createDedupEmitter({
    signalFile: paths.signal,
    monitorLastFile: paths.monitorLast,
    log: logLine,
  });

  const repo = resolveGithubOwnerRepo(repoRoot);
  const pruned = pruneClosedReviewArtifacts(repoRoot, {
    activePrNumbers: [prNumber],
  });
  if (pruned.pruned.length > 0) {
    logLine(`pruned stale review artifacts for PR(s): ${pruned.pruned.join(', ')}`);
  }
  const cfg = settledConfigFromArgs(args);
  const sleeper = createWakeableSleep();
  const deadline = Date.now() + durationMs;

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

  let latest = initial;
  let rateLimitedUntil = 0;
  /** @type {string | null} */
  let pendingHandoff = null;

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
    enabled: webhookEnabled,
    webhookPort: args.webhookPort,
    repo,
    wake: () => sleeper.wake(),
    logLine,
    webhookLogLabel: 'poll now',
  });

  logLine(
    `DAEMON pr=${prNumber} head=${initial.pr.headRefOid.slice(0, 7)} `
      + `duration=${Math.round(durationMs / 3_600_000)}h `
      + `webhook=${Boolean(webhook)} repo=${repoRoot}`,
  );
  logLine(`log: ${paths.daemonLog}`);
  logLine(`signal: ${paths.signal}`);

  while (Date.now() < deadline) {
    if (pendingHandoff && hasHandoffAck(paths.handoffAck)) {
      logLine(`handoff ack received (${pendingHandoff}); resuming watch`);
      clearHandoffAck(paths.handoffAck);
      pendingHandoff = null;
      emitter.emit('WAIT', formatStatusDetail(latest, 'handoff-resumed'), 'WAIT');
    }

    let result;
    let machine;
    try {
      result = pollerRef.current.poll();
      ({ machine } = result);
      latest = fullSnapshot(pollerRef.current);
    } catch (err) {
      logLine(`poll-error: ${err.message} — retry in 60s`);
      await sleeper.sleep(60_000);
      continue;
    }

    if (json) {
      process.stdout.write(`${JSON.stringify(pollerRef.current.snapshot())}\n`);
    }

    const classified = classifyMonitorState(latest, machine.state);
    const detail = formatStatusDetail(latest, machine.state);

    if (
      classified.kind === 'ACTION'
      && (!pendingHandoff || classified.reason === 'ci-fail')
    ) {
      if (classified.reason === 'ci-fail') {
        writeQueue(latest, 'ci-fail', { failed: latest.ci.failed });
      } else if (classified.reason === 'threads') {
        writeQueue(latest, 'threads', {
          threads: latest.threads.unresolved,
        });
      }
      emitter.emit('ACTION', `${classified.reason} ${detail}`, classified.signal);
      pendingHandoff = classified.reason;
    } else if (classified.kind === 'GREEN' && !pendingHandoff) {
      emitter.emit('GREEN', detail, 'GREEN');
      if (fs.existsSync(paths.queue)) {
        try {
          fs.unlinkSync(paths.queue);
        } catch {
          // ignore
        }
      }
    } else if (!pendingHandoff) {
      emitter.emit('WAIT', detail, 'WAIT');
    }

    const nextSec = Math.round(result.nextPollMs / 1000);
    logLine(
      `${machine.state} ${detail} next=${nextSec}s `
        + `handoff=${pendingHandoff ?? 'none'}`,
    );

    let waitMs = Math.max(result.nextPollMs, 1_000);
    if (latest.ci.hasFailure || latest.ci.hasPending) {
      waitMs = Math.min(waitMs, 15_000);
    }
    if (pendingHandoff) {
      waitMs = Math.min(waitMs, 15_000);
    }
    if (rateLimitedUntil > Date.now()) {
      waitMs = Math.max(waitMs, rateLimitedUntil - Date.now());
    }

    await sleeper.sleep(waitMs);
  }

  await webhook?.stop();
  logLine(`duration cap reached (${Math.round(durationMs / 3_600_000)}h); stopping`);
  releasePidLock(paths.pid);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`pr-review-daemon: ${err.message}\n`);
  releasePidLock(paths?.pid);
  process.exit(2);
});
