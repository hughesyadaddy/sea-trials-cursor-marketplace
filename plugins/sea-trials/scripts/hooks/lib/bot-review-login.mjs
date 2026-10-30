/**
 * Bot login helpers for vendored pr-review-lib (plugin ships full settled poller).
 */
export const BOTS = Object.freeze({
  aireview: Object.freeze({ login: 'github-actions' }),
  bugbot: Object.freeze({ login: 'cursor' }),
  coderabbit: Object.freeze({ login: 'coderabbitai' }),
  copilot: Object.freeze({ login: 'copilot-pull-request-reviewer' }),
});

const BOT_KEYS = Object.freeze(Object.keys(BOTS));

/**
 * @param {string | null | undefined} login
 * @returns {string}
 */
export function normalizeLogin(login) {
  return String(login ?? '')
    .trim()
    .replace(/\[bot\]$/i, '')
    .toLowerCase();
}

/**
 * @param {string | null | undefined} login
 * @returns {keyof typeof BOTS | null}
 */
export function botKeyForLogin(login) {
  const norm = normalizeLogin(login);
  if (!norm) return null;
  for (const key of BOT_KEYS) {
    if (BOTS[key].login === norm) return key;
  }
  return null;
}

/**
 * @param {string | null | undefined} login
 */
export function isBotLogin(login) {
  if (botKeyForLogin(login)) return true;
  return /\[bot\]$/i.test(String(login ?? '').trim());
}
