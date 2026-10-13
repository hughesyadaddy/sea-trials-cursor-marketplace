/**
 * GitHub CLI / REST rate-limit aware retry helpers for review-loop polls.
 */
import { spawnSync } from 'node:child_process';

/** @param {string} text */
export function isGhRateLimitMessage(text) {
  const msg = (text ?? '').toLowerCase();
  if (!msg) return false;
  if (
    msg.includes('rate limit')
    || msg.includes('rate_limit')
    || msg.includes('secondary rate limit')
    || msg.includes('abuse detection')
    || msg.includes('429')
  ) {
    return true;
  }
  if (msg.includes('403') && msg.includes('ratelimit')) {
    return true;
  }
  return false;
}

/**
 * Parse a Unix reset epoch (seconds) from gh / API error text when present.
 *
 * @param {string} text
 * @returns {number | null} ms since epoch
 */
export function parseRateLimitResetMs(text) {
  const raw = text ?? '';
  const headerMatch = raw.match(/x-ratelimit-reset:\s*(\d+)/i);
  if (headerMatch) {
    return Number(headerMatch[1]) * 1000;
  }
  const resetIn = raw.match(/rate limit reset[^0-9]*(\d{9,13})/i);
  if (resetIn) {
    const n = Number(resetIn[1]);
    return n > 1e12 ? n : n * 1000;
  }
  return null;
}

/**
 * @param {{
 *   attempt: number,
 *   resetAtMs?: number | null,
 *   now?: number,
 *   baseMs?: number,
 *   maxMs?: number,
 * }} opts
 */
export function computeGhRetryDelayMs(opts) {
  const now = opts.now ?? Date.now();
  const baseMs = opts.baseMs ?? 2_000;
  const maxMs = opts.maxMs ?? 120_000;
  const resetAtMs = opts.resetAtMs ?? null;
  const resetWait =
    resetAtMs != null && resetAtMs > now
      ? Math.min(maxMs, resetAtMs - now + 1_000)
      : 0;
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, opts.attempt - 1));
  return Math.max(baseMs, resetWait, exp);
}

/** @param {number} ms */
export function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Blocking sleep for synchronous gh polling (pre-push / snapshot builds).
 *
 * @param {number} ms
 */
export function blockingSleepMs(ms) {
  if (ms <= 0) return;
  const sec = Math.max(1, Math.ceil(ms / 1000));
  if (process.platform === 'win32') {
    spawnSync('timeout', ['/t', String(sec), '/nobreak'], {
      stdio: 'ignore',
      shell: true,
    });
    return;
  }
  spawnSync('sleep', [String(sec)]);
}
