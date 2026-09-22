#!/usr/bin/env node
/**
 * PR review loop — adaptive "bot review settled" watch after each push.
 *
 *   pnpm pr-review-loop -- --pr <n>
 *   pnpm pr-review-loop -- --pr <n> --once
 *   pnpm pr-review-loop -- --pr <n> --json          # snapshot per poll
 *   pnpm pr-review-loop -- --pr <n> --webhook       # gh webhook fast path
 *   pnpm pr-review-loop -- --pr <n> --bots codex,bugbot
 *   pnpm pr-review-loop -- --pr <n> --silence 30    # hard cap (minutes)
 *   pnpm pr-review-loop -- --pr <n> --interval 30   # REVIEWING poll (s)
 *
 * Replaces the flat 30-minute silence window with the settled machine
 * in lib/bot-review-settled.mjs: 20s grace → wait for a bot ack (≤3 min,
 * re-poke Codex once) → ETag-conditional REST every 30s (GraphQL only
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
  spawnWebhookForwarder,
  startWebhookReceiver,
} from './lib/bot-review-settled.mjs';
import {
  GraphqlRateLimitedError,
  buildReviewSnapshot,
  evaluateSnapshot,
  getRepoRoot,
  parsePrArgs,
  resolveGithubOwnerRepo,
  reviewPaths,
  silenceWindowStartIso,
  writeJson,
  writeReviewState,
} from './lib/pr-review-lib.mjs';

const repoRoot = getRepoRoot();
const args = parsePrArgs(process.argv.slice(2));
const { once, prNumber, json } = args;

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

/** Machine overrides derived from legacy flags. */
function settledConfig() {
  /** @type {Record<string, number>} */
  const cfg = {};
  if (args.silenceExplicit && Number.isFinite(args.silenceMin)) {
    cfg.maxSilenceMs = args.silenceMin * 60_000;
    cfg.reviewCapMs = Math.min(25 * 60_000, cfg.maxSilenceMs);
  }
  if (args.intervalExplicit && Number.isFinite(args.intervalSec)) {
    cfg.reviewPollMs = args.intervalSec * 1000;
    cfg.ackPollMs = Math.min(15_000, cfg.reviewPollMs);
  }
  return cfg;
}

function writeQueue(snapshot, kind, extra) {
  writeJson(queuePath, {
    pr: prNumber,
    at: snapshot.at,
    head: snapshot.pr.headRefOid,
    kind,
    ...extra,
  });
  logLine(`queue: ${queuePath}`);
}

/**
 * Full GraphQL + CI read. Persisted to the state file with the settled
 * snapshot so `pr-review-status --json` can show where the loop is.
 *
 * @param {ReturnType<typeof createSettledPoller> | null} poller
 */
function fullSnapshot(poller) {
  const snapshot = buildReviewSnapshot(repoRoot, prNumber);
  if (poller) snapshot.settled = poller.snapshot();
  writeReviewState(statePath, snapshot);
  return snapshot;
}

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

async function startWebhook(repo, wake) {
  if (!args.webhook) return null;
  try {
    const receiver = await startWebhookReceiver({
      port: args.webhookPort ?? 0,
      onEvent: (event) => {
        logLine(`webhook: ${event} → polling now`);
        wake();
      },
    });
    const forwarder = await spawnWebhookForwarder({
      repo,
      url: receiver.url,
      log: logLine,
    });
    if (!forwarder.ok) {
      logLine(`webhook unavailable (${forwarder.reason}); polling only`);
      await receiver.close();
      return null;
    }
    logLine(
      `webhook: forwarding ${repo.owner}/${repo.name} → ${receiver.url}`,
    );
    return {
      stop: async () => {
        forwarder.stop();
        await receiver.close();
      },
    };
  } catch (err) {
    logLine(`webhook setup failed (${err.message}); polling only`);
    return null;
  }
}

async function main() {
  if (once) {
    const { verdict } = pollOnce();
    process.exit(verdict.exitCode);
  }

  const repo = resolveGithubOwnerRepo(repoRoot);
  const initial = fullSnapshot(null);
  const pushIso = silenceWindowStartIso(
    repoRoot,
    prNumber,
    initial.pr.headRefOid,
    initial.pr.headRefName,
  );
  const t0 = new Date(pushIso).getTime();
  const cfg = settledConfig();
  const sleeper = createWakeableSleep();

  let latest = initial;
  let rateLimitedUntil = 0;
  /** @type {ReturnType<typeof createSettledPoller> | null} */
  let poller = null;

  const refreshThreads = () => {
    try {
      latest = fullSnapshot(poller);
      return {
        head: latest.pr.headRefOid,
        unresolvedThreads: latest.threads.unresolvedCount,
        unresolvedBotThreads: latest.threads.unresolvedBotCount,
        ciPending: latest.ci.hasPending,
        ciFailed: latest.ci.hasFailure,
        rateLimit: latest.rateLimit ?? null,
      };
    } catch (err) {
      if (err instanceof GraphqlRateLimitedError) {
        const resetAt = err.rateLimit?.resetAt;
        rateLimitedUntil = resetAt
          ? new Date(resetAt).getTime()
          : Date.now() + 60_000;
        const untilIso = new Date(rateLimitedUntil).toISOString();
        logLine(`graphql rate limited; backing off until ${untilIso}`);
        return { rateLimited: true, rateLimit: err.rateLimit ?? null };
      }
      throw err;
    }
  };

  poller = createSettledPoller({
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

  const webhook = await startWebhook(repo, () => sleeper.wake());

  logLine(
    `WATCH pr=${prNumber} head=${initial.pr.headRefOid.slice(0, 7)} `
      + `t0=${pushIso} cap=${(cfg.maxSilenceMs ?? 30 * 60_000) / 60_000}m `
      + `bots=${args.bots?.join(',') ?? 'auto'} webhook=${Boolean(webhook)}`,
  );

  if (initial.ci.hasFailure) {
    exitForSnapshot(initial, 'initial poll');
  }

  while (true) {
    let result;
    try {
      result = poller.poll();
    } catch (err) {
      logLine(`poll-error: ${err.message} — retrying in 60s`);
      await sleeper.sleep(60_000);
      continue;
    }
    const { machine } = result;
    if (json) {
      process.stdout.write(`${JSON.stringify(poller.snapshot())}\n`);
    }

    if (latest.ci.hasFailure) {
      await webhook?.stop();
      exitForSnapshot(latest, machine.state);
    }

    if (machine.state === STATES.ACTING || machine.state === STATES.DONE) {
      await webhook?.stop();
      // Final authoritative read before handing off.
      latest = fullSnapshot(poller);
      exitForSnapshot(latest, machine.state.toLowerCase());
    }

    const remainingCapMin = Math.max(
      0,
      Math.ceil(
        (machine.t0 + (cfg.maxSilenceMs ?? 30 * 60_000) - Date.now()) / 60_000,
      ),
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
