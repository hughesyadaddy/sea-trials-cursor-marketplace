/** Default cap when --silence is omitted (minutes). */
export const DEFAULT_SILENCE_MIN = 30;

/**
 * @param {ReturnType<import('./pr-review-lib.mjs').parsePrArgs>} args
 * @param {{ defaultSilenceMin?: number }} [opts]
 */
export function settledConfigFromArgs(args, opts = {}) {
  /** @type {Record<string, number>} */
  const cfg = {};
  if (args.silenceExplicit && Number.isFinite(args.silenceMin)) {
    cfg.maxSilenceMs = args.silenceMin * 60_000;
    cfg.reviewCapMs = Math.min(25 * 60_000, cfg.maxSilenceMs);
  } else {
    const fallbackMin = opts.defaultSilenceMin ?? DEFAULT_SILENCE_MIN;
    cfg.maxSilenceMs = fallbackMin * 60_000;
  }
  if (args.intervalExplicit && Number.isFinite(args.intervalSec)) {
    cfg.reviewPollMs = args.intervalSec * 1000;
    cfg.ackPollMs = Math.min(15_000, cfg.reviewPollMs);
  }
  return cfg;
}
