/**
 * Shared settled-watch helpers for pr-review-loop and pr-review-daemon.
 */
import {
  spawnWebhookForwarder,
  startWebhookReceiver,
} from './bot-review-settled.mjs';
import { GraphqlRateLimitedError, writeJson, writeReviewState } from './pr-review-lib.mjs';

export { DEFAULT_SILENCE_MIN, settledConfigFromArgs } from './review-loop-config.mjs';

/**
 * @param {{
 *   prNumber: number,
 *   queuePath: string,
 *   logLine: (line: string) => void,
 * }} ctx
 */
export function createWriteQueue(ctx) {
  return (snapshot, kind, extra) => {
    writeJson(ctx.queuePath, {
      pr: ctx.prNumber,
      at: snapshot.at,
      head: snapshot.pr.headRefOid,
      kind,
      ...extra,
    });
    ctx.logLine(`queue: ${ctx.queuePath}`);
  };
}

/**
 * @param {{
 *   buildReviewSnapshot: typeof import('./pr-review-lib.mjs').buildReviewSnapshot,
 *   repoRoot: string,
 *   prNumber: number,
 *   statePath: string,
 * }} ctx
 */
export function createFullSnapshot(ctx) {
  /** @param {ReturnType<import('./bot-review-settled.mjs').createSettledPoller> | null} poller */
  return (poller) => {
    const snapshot = ctx.buildReviewSnapshot(ctx.repoRoot, ctx.prNumber);
    if (poller) snapshot.settled = poller.snapshot();
    writeReviewState(ctx.statePath, snapshot);
    return snapshot;
  };
}

/**
 * @param {{
 *   fullSnapshot: ReturnType<typeof createFullSnapshot>,
 *   pollerRef: { current: ReturnType<import('./bot-review-settled.mjs').createSettledPoller> | null },
 *   onSnapshot: (snapshot: ReturnType<ReturnType<typeof createFullSnapshot>>) => void,
 *   onRateLimited?: (untilMs: number) => void,
 *   logLine?: (line: string) => void,
 * }} ctx
 */
export function createRefreshThreads(ctx) {
  return () => {
    try {
      const latest = ctx.fullSnapshot(ctx.pollerRef.current);
      ctx.onSnapshot(latest);
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
        const rateLimitedUntil = resetAt
          ? new Date(resetAt).getTime()
          : Date.now() + 60_000;
        ctx.onRateLimited?.(rateLimitedUntil);
        if (ctx.logLine) {
          const untilIso = new Date(rateLimitedUntil).toISOString();
          ctx.logLine(`graphql rate limited; backing off until ${untilIso}`);
        }
        return { rateLimited: true, rateLimit: err.rateLimit ?? null };
      }
      throw err;
    }
  };
}

/**
 * @param {{
 *   enabled: boolean,
 *   webhookPort?: number,
 *   repo: { owner: string, name: string },
 *   wake: () => void,
 *   logLine: (line: string) => void,
 *   webhookLogLabel?: string,
 * }} opts
 */
export async function startReviewWebhook(opts) {
  if (!opts.enabled) return null;
  try {
    const receiver = await startWebhookReceiver({
      port: opts.webhookPort ?? 0,
      onEvent: (event) => {
        const label = opts.webhookLogLabel ?? 'polling now';
        opts.logLine(`webhook: ${event} → ${label}`);
        opts.wake();
      },
    });
    const forwarder = await spawnWebhookForwarder({
      repo: opts.repo,
      url: receiver.url,
      log: opts.logLine,
    });
    if (!forwarder.ok) {
      opts.logLine(`webhook unavailable (${forwarder.reason}); polling only`);
      await receiver.close();
      return null;
    }
    opts.logLine(
      `webhook: forwarding ${opts.repo.owner}/${opts.repo.name} → `
        + `${receiver.url}`,
    );
    return {
      stop: async () => {
        forwarder.stop();
        await receiver.close();
      },
    };
  } catch (err) {
    opts.logLine(`webhook setup failed (${err.message}); polling only`);
    return null;
  }
}
