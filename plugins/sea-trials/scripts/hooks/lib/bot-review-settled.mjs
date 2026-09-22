/**
 * Bot-review "settled" detector — adaptive replacement for the fixed
 * 30-minute silence window.
 *
 * Bot reviewers (Codex, Cursor Bugbot, CodeRabbit, Copilot) each leave a
 * distinct trail: a 👀 reaction when they pick a push up, a check run
 * while they work, a review or issue comment when they finish. Watching
 * those signals lets the loop act within a minute of the last bot
 * comment instead of waiting a flat half hour, while still refusing to
 * act on a review that is only half posted.
 *
 * Everything that decides is pure (`stepMachine`, `deriveSignals`,
 * `selectNewBotComments`, …) and unit-tested with canned GitHub
 * payloads. `createSettledPoller` is the one impure piece: it drives the
 * machine with ETag-conditional REST polls (a 304 is free) and runs the
 * GraphQL thread query only when something actually changed.
 *
 *   PUSHED ─20s─▶ AWAITING_ACK ─ack | 3 min─▶ REVIEWING
 *   REVIEWING ─2 quiet polls | all bots done | 25 min─▶ SETTLED_CHECK
 *   SETTLED_CHECK ─3 min quiet─▶ SETTLED ─▶ ACTING | DONE
 *
 * Any bot activity during SETTLED_CHECK drops back to REVIEWING; a new
 * PR head restarts at PUSHED with a fresh t0. Signals older than t0 or
 * for another head never count.
 */
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

export const STATES = Object.freeze({
  PUSHED: 'PUSHED',
  AWAITING_ACK: 'AWAITING_ACK',
  REVIEWING: 'REVIEWING',
  SETTLED_CHECK: 'SETTLED_CHECK',
  SETTLED: 'SETTLED',
  ACTING: 'ACTING',
  DONE: 'DONE',
});

export const TERMINAL_STATES = new Set([STATES.ACTING, STATES.DONE]);

/**
 * GraphQL logins carry no `[bot]` suffix; REST logins do. Everything
 * here compares through `normalizeLogin`, so both spellings match.
 */
export const BOTS = Object.freeze({
  codex: Object.freeze({
    login: 'chatgpt-codex-connector',
    retrigger: '@codex review',
    checkRun: null,
  }),
  bugbot: Object.freeze({
    login: 'cursor',
    retrigger: 'bugbot run',
    checkRun: 'cursor bugbot',
  }),
  coderabbit: Object.freeze({
    login: 'coderabbitai',
    retrigger: '@coderabbitai review',
    checkRun: 'coderabbit',
  }),
  copilot: Object.freeze({
    login: 'copilot-pull-request-reviewer',
    retrigger: null,
    checkRun: null,
  }),
});

export const BOT_KEYS = Object.freeze(Object.keys(BOTS));

export const SETTLED_DEFAULTS = Object.freeze({
  pushedDelayMs: 20_000,
  ackPollMs: 15_000,
  ackTimeoutMs: 3 * 60_000,
  reviewPollMs: 30_000,
  reviewCapMs: 25 * 60_000,
  quietPollsToSettle: 2,
  settledCheckPollMs: 60_000,
  settledCheckPolls: 2,
  settledCheckWindowMs: 3 * 60_000,
  ciPendingPollMs: 60_000,
  maxSilenceMs: 30 * 60_000,
  rateLimitFloor: 500,
  rateLimitBackoffMs: 60_000,
});

// ==========================================================================
// LOGINS
// ==========================================================================

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
 * Known reviewer bots plus anything GitHub itself marks as an app.
 *
 * @param {string | null | undefined} login
 */
export function isBotLogin(login) {
  if (botKeyForLogin(login)) return true;
  return /\[bot\]$/i.test(String(login ?? '').trim());
}

// ==========================================================================
// TIME + SHA HELPERS
// ==========================================================================

/** @param {string | number | Date | null | undefined} value */
export function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when one sha is a prefix of the other (short vs full).
 *
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export function sameSha(a, b) {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

// ==========================================================================
// REST NORMALISATION
// ==========================================================================

/**
 * @typedef {{
 *   id: string,
 *   login: string,
 *   createdAt: number | null,
 *   commitId: string | null,
 *   body: string,
 *   kind: 'review-comment' | 'review' | 'issue-comment',
 * }} BotComment
 */

/**
 * One shape for review comments, reviews, and issue comments.
 *
 * @param {Record<string, any>} item raw REST object
 * @param {BotComment['kind']} kind
 * @returns {BotComment}
 */
export function normalizeRestComment(item, kind) {
  return {
    id: `${kind}:${item.id ?? item.node_id ?? ''}`,
    login: item.user?.login ?? item.author?.login ?? '',
    createdAt: toMs(item.created_at ?? item.submitted_at ?? item.createdAt),
    commitId: item.commit_id ?? item.original_commit_id ?? null,
    body: String(item.body ?? ''),
    kind,
  };
}

/**
 * Bot comments that belong to this push: authored by a bot, created
 * after t0 (or pinned to the current head), and not yet seen.
 *
 * @param {BotComment[]} comments
 * @param {Iterable<string>} seenIds
 * @param {{ t0: number, head: string }} anchor
 * @returns {BotComment[]}
 */
export function selectNewBotComments(comments, seenIds, { t0, head }) {
  const seen = new Set(seenIds);
  return comments.filter((c) => {
    if (!isBotLogin(c.login)) return false;
    if (seen.has(c.id)) return false;
    const fresh = c.createdAt != null && c.createdAt > t0;
    return fresh || sameSha(c.commitId, head);
  });
}

// ==========================================================================
// SIGNALS
// ==========================================================================

/**
 * @typedef {{
 *   ack: Record<string, boolean>,
 *   complete: Record<string, boolean>,
 *   present: Record<string, boolean>,
 * }} BotSignals
 */

/** @returns {Record<string, boolean>} */
function emptyFlags() {
  const out = {};
  for (const key of BOT_KEYS) out[key] = false;
  return out;
}

/** @returns {BotSignals} */
export function emptySignals() {
  return { ack: emptyFlags(), complete: emptyFlags(), present: emptyFlags() };
}

/**
 * OR-merge: a signal seen once stays seen for this head.
 *
 * @param {BotSignals} prev
 * @param {Partial<BotSignals> | null | undefined} next
 * @returns {BotSignals}
 */
export function mergeSignals(prev, next) {
  const out = emptySignals();
  for (const group of ['ack', 'complete', 'present']) {
    for (const key of BOT_KEYS) {
      out[group][key] = Boolean(prev?.[group]?.[key] || next?.[group]?.[key]);
    }
  }
  return out;
}

/**
 * @param {Array<Record<string, any>>} checkRuns REST `check_runs[]`
 * @param {string} nameNeedle lower-cased substring of `name`
 * @param {string} head
 */
function findCheckRun(checkRuns, nameNeedle, head) {
  return checkRuns.find((run) => {
    const name = String(run.name ?? '').toLowerCase();
    if (!name.includes(nameNeedle)) return false;
    return !run.head_sha || sameSha(run.head_sha, head);
  });
}

/**
 * Turn raw GitHub payloads into ack / complete / present flags anchored
 * to head `H` and push time `t0`. Stale signals from a previous head
 * never count; `present` ignores the anchor because it only answers
 * "does this bot review this PR at all".
 *
 * @param {{
 *   head: string,
 *   t0: number,
 *   reactions?: Array<Record<string, any>>,
 *   reviews?: Array<Record<string, any>>,
 *   reviewComments?: Array<Record<string, any>>,
 *   issueComments?: Array<Record<string, any>>,
 *   checkRuns?: Array<Record<string, any>>,
 *   requestedReviewers?: Array<string | Record<string, any>>,
 *   copilotWasRequested?: boolean,
 * }} input
 * @returns {BotSignals}
 */
export function deriveSignals(input) {
  const {
    head,
    t0,
    reactions = [],
    reviews = [],
    reviewComments = [],
    issueComments = [],
    checkRuns = [],
    requestedReviewers = [],
    copilotWasRequested = false,
  } = input;
  const signals = emptySignals();
  const after = (value) => {
    const ms = toMs(value);
    return ms != null && ms > t0;
  };
  const markPresent = (login) => {
    const key = botKeyForLogin(login);
    if (key) signals.present[key] = true;
  };

  for (const item of [...reviews, ...reviewComments, ...issueComments]) {
    markPresent(item.user?.login ?? item.author?.login);
  }

  // Codex: 👀 = received, review / "Didn't find" comment / 👍 = done.
  for (const reaction of reactions) {
    if (botKeyForLogin(reaction.user?.login) !== 'codex') continue;
    signals.present.codex = true;
    if (!after(reaction.created_at)) continue;
    if (reaction.content === 'eyes') signals.ack.codex = true;
    if (reaction.content === '+1') signals.complete.codex = true;
  }
  for (const review of reviews) {
    if (botKeyForLogin(review.user?.login) !== 'codex') continue;
    const forHead = sameSha(review.commit_id, head);
    if (forHead || after(review.submitted_at)) signals.complete.codex = true;
  }
  for (const comment of issueComments) {
    if (botKeyForLogin(comment.user?.login) !== 'codex') continue;
    const body = String(comment.body ?? '');
    if (!/reviewed commit:/i.test(body)) continue;
    if (body.includes(head.slice(0, 7)) || after(comment.created_at)) {
      signals.complete.codex = true;
    }
  }
  if (signals.complete.codex) signals.ack.codex = true;

  // Bugbot + CodeRabbit: check run on H. queued/in_progress = ack,
  // completed = done (any conclusion — neutral means findings posted).
  for (const key of ['bugbot', 'coderabbit']) {
    const needle = BOTS[key].checkRun;
    if (!needle) continue;
    const anyRun = checkRuns.some((run) =>
      String(run.name ?? '').toLowerCase().includes(needle),
    );
    if (anyRun) signals.present[key] = true;
    const run = findCheckRun(checkRuns, needle, head);
    if (!run) continue;
    if (run.status === 'completed') {
      signals.complete[key] = true;
      signals.ack[key] = true;
    } else if (run.status === 'queued' || run.status === 'in_progress') {
      signals.ack[key] = true;
    }
  }

  // Copilot: in requested_reviewers = working; dropped out = done.
  const requested = requestedReviewers.some(
    (r) => botKeyForLogin(typeof r === 'string' ? r : r?.login) === 'copilot',
  );
  if (requested) {
    signals.present.copilot = true;
    signals.ack.copilot = true;
  } else if (copilotWasRequested) {
    signals.present.copilot = true;
    signals.ack.copilot = true;
    signals.complete.copilot = true;
  }

  return signals;
}

// ==========================================================================
// RATE LIMIT
// ==========================================================================

/**
 * GraphQL throttling comes back as HTTP 200 with a typed error.
 *
 * @param {{ errors?: Array<{ type?: string }> } | null | undefined} response
 */
export function isGraphqlRateLimited(response) {
  return Boolean(
    response?.errors?.some((e) => e?.type === 'RATE_LIMITED'),
  );
}

/**
 * Extra delay to add to the next poll given the last `rateLimit` block.
 *
 * @param {{
 *   rateLimited?: boolean,
 *   rateLimit?: { remaining?: number, resetAt?: string } | null,
 * }} obs
 * @param {number} basePollMs
 * @param {number} now
 * @param {typeof SETTLED_DEFAULTS} cfg
 */
export function applyRateLimitBackoff(obs, basePollMs, now, cfg) {
  let next = basePollMs;
  if (obs.rateLimited) {
    const resetMs = toMs(obs.rateLimit?.resetAt);
    const untilReset = resetMs != null ? resetMs - now : 0;
    next = Math.max(next, untilReset, cfg.rateLimitBackoffMs);
  } else if (
    typeof obs.rateLimit?.remaining === 'number'
    && obs.rateLimit.remaining < cfg.rateLimitFloor
  ) {
    next = Math.max(next * 2, cfg.rateLimitBackoffMs);
  }
  return next;
}

// ==========================================================================
// MACHINE
// ==========================================================================

/**
 * @typedef {{
 *   state: string,
 *   head: string,
 *   t0: number,
 *   enteredAt: number,
 *   pollsInState: number,
 *   quietPolls: number,
 *   codexRetriggered: boolean,
 *   lastBotActivityAt: number | null,
 *   seenBotCommentIds: string[],
 *   signals: BotSignals,
 *   enabledBots: string[] | null,
 *   unresolvedThreads: number | null,
 *   unresolvedBotThreads: number | null,
 *   threadsAt: number | null,
 *   ciPending: boolean,
 *   ciFailed: boolean,
 * }} SettledMachine
 */

/**
 * @typedef {{
 *   now: number,
 *   head?: string | null,
 *   botComments?: BotComment[],
 *   signals?: Partial<BotSignals> | null,
 *   unresolvedThreads?: number | null,
 *   unresolvedBotThreads?: number | null,
 *   ciPending?: boolean,
 *   ciFailed?: boolean,
 *   rateLimited?: boolean,
 *   rateLimit?: { remaining?: number, resetAt?: string } | null,
 * }} SettledObservation
 */

/**
 * @param {{
 *   head: string,
 *   t0: number,
 *   enabledBots?: string[] | null,
 * }} init
 * @returns {SettledMachine}
 */
export function createMachine({ head, t0, enabledBots = null }) {
  return {
    state: STATES.PUSHED,
    head,
    t0,
    enteredAt: t0,
    pollsInState: 0,
    quietPolls: 0,
    codexRetriggered: false,
    lastBotActivityAt: null,
    seenBotCommentIds: [],
    signals: emptySignals(),
    enabledBots: enabledBots ? [...enabledBots] : null,
    unresolvedThreads: null,
    unresolvedBotThreads: null,
    threadsAt: null,
    ciPending: false,
    ciFailed: false,
  };
}

/**
 * Explicit `--bots` list wins; otherwise every bot seen on this PR.
 *
 * @param {SettledMachine} m
 * @returns {string[]}
 */
export function enabledBotsOf(m) {
  if (m.enabledBots) return m.enabledBots;
  return BOT_KEYS.filter((key) => m.signals.present[key]);
}

/**
 * Thread counts are trustworthy only when read after the last bot
 * activity — otherwise a bot may have posted since the last query.
 *
 * @param {SettledMachine} m
 */
export function threadsAreFresh(m) {
  if (m.threadsAt == null || m.unresolvedThreads == null) return false;
  if (m.threadsAt < m.t0) return false;
  return m.lastBotActivityAt == null || m.threadsAt >= m.lastBotActivityAt;
}

/**
 * @param {SettledMachine} m
 * @param {typeof SETTLED_DEFAULTS} c
 * @param {number} now
 */
function basePollMs(m, c, now) {
  switch (m.state) {
    case STATES.PUSHED:
      return Math.max(0, m.t0 + c.pushedDelayMs - now);
    case STATES.AWAITING_ACK:
      return c.ackPollMs;
    case STATES.REVIEWING:
      return m.ciPending
        ? Math.max(c.reviewPollMs, c.ciPendingPollMs)
        : c.reviewPollMs;
    case STATES.SETTLED_CHECK:
      return c.settledCheckPollMs;
    case STATES.SETTLED:
      return c.ciPendingPollMs;
    default:
      return 0;
  }
}

/**
 * One transition. Pure: returns a new machine plus the actions the
 * caller must perform (`post-codex-retrigger`, `refresh-threads`,
 * `head-changed`).
 *
 * @param {SettledMachine} prev
 * @param {SettledObservation} obs
 * @param {Partial<typeof SETTLED_DEFAULTS>} [cfgOverrides]
 * @returns {{ machine: SettledMachine, nextPollMs: number, actions: string[] }}
 */
export function stepMachine(prev, obs, cfgOverrides = {}) {
  const c = { ...SETTLED_DEFAULTS, ...cfgOverrides };
  const now = obs.now;
  /** @type {string[]} */
  const actions = [];

  if (obs.head && obs.head !== prev.head) {
    const machine = createMachine({
      head: obs.head,
      t0: now,
      enabledBots: prev.enabledBots,
    });
    return {
      machine,
      nextPollMs: c.pushedDelayMs,
      actions: ['head-changed'],
    };
  }

  /** @type {SettledMachine} */
  const m = {
    ...prev,
    seenBotCommentIds: [...prev.seenBotCommentIds],
    signals: mergeSignals(prev.signals, obs.signals),
    pollsInState: prev.pollsInState + 1,
    ciPending: Boolean(obs.ciPending ?? prev.ciPending),
    ciFailed: Boolean(obs.ciFailed ?? prev.ciFailed),
  };

  const fresh = selectNewBotComments(
    obs.botComments ?? [],
    m.seenBotCommentIds,
    { t0: m.t0, head: m.head },
  );
  for (const comment of fresh) m.seenBotCommentIds.push(comment.id);
  const activity = fresh.length > 0;
  if (activity) m.lastBotActivityAt = now;

  if (obs.unresolvedThreads != null) {
    m.unresolvedThreads = obs.unresolvedThreads;
    m.unresolvedBotThreads = obs.unresolvedBotThreads ?? 0;
    m.threadsAt = now;
  }

  const enabled = enabledBotsOf(m);
  const acked = enabled.some((b) => m.signals.ack[b]);
  const allComplete =
    enabled.length > 0 && enabled.every((b) => m.signals.complete[b]);
  const inFlight = enabled.some(
    (b) => m.signals.ack[b] && !m.signals.complete[b],
  );
  const capped = now - m.t0 >= c.maxSilenceMs;

  const go = (state) => {
    m.state = state;
    m.enteredAt = now;
    m.pollsInState = 0;
  };

  if (capped && !TERMINAL_STATES.has(m.state)) {
    go(STATES.SETTLED);
  }

  switch (m.state) {
    case STATES.PUSHED:
      if (now - m.t0 >= c.pushedDelayMs) go(STATES.AWAITING_ACK);
      break;

    case STATES.AWAITING_ACK:
      if (acked || activity || allComplete) {
        go(STATES.REVIEWING);
      } else if (now - m.enteredAt >= c.ackTimeoutMs) {
        if (enabled.includes('codex') && !m.codexRetriggered) {
          actions.push('post-codex-retrigger');
          m.codexRetriggered = true;
        }
        go(STATES.REVIEWING);
      }
      break;

    case STATES.REVIEWING: {
      m.quietPolls = activity ? 0 : m.quietPolls + 1;
      const reviewCapped = now - m.t0 >= c.reviewCapMs;
      const quiet = m.quietPolls >= c.quietPollsToSettle && !inFlight;
      if (allComplete && !threadsAreFresh(m)) {
        // Bots are done; decide on a thread count read after their
        // last comment, not on a stale one.
        actions.push('refresh-threads');
      } else if (allComplete || reviewCapped || quiet) {
        const botsDoneWithFindings =
          allComplete && (m.unresolvedThreads ?? 0) > 0;
        go(botsDoneWithFindings ? STATES.ACTING : STATES.SETTLED_CHECK);
      }
      break;
    }

    case STATES.SETTLED_CHECK:
      if (activity) {
        m.quietPolls = 0;
        go(STATES.REVIEWING);
      } else if (
        m.pollsInState >= c.settledCheckPolls
        && now - m.enteredAt >= c.settledCheckWindowMs
      ) {
        go(STATES.SETTLED);
      }
      break;

    default:
      break;
  }

  if (m.state === STATES.SETTLED) {
    if (activity && !capped) {
      m.quietPolls = 0;
      go(STATES.REVIEWING);
    } else if (!threadsAreFresh(m)) {
      actions.push('refresh-threads');
    } else if ((m.unresolvedThreads ?? 0) > 0) {
      go(STATES.ACTING);
    } else if (m.ciPending && !capped) {
      actions.push('await-ci');
    } else {
      go(STATES.DONE);
    }
  }

  const nextPollMs = applyRateLimitBackoff(obs, basePollMs(m, c, now), now, c);
  return { machine: m, nextPollMs, actions };
}

/**
 * Compact `--json` view.
 *
 * @param {SettledMachine} m
 * @param {number} nextPollMs
 */
export function machineSnapshot(m, nextPollMs) {
  return {
    state: m.state,
    head: m.head,
    t0: new Date(m.t0).toISOString(),
    enteredAt: new Date(m.enteredAt).toISOString(),
    unresolvedThreads: m.unresolvedThreads,
    unresolvedBotThreads: m.unresolvedBotThreads,
    signals: {
      ack: { ...m.signals.ack },
      complete: { ...m.signals.complete },
      enabled: enabledBotsOf(m),
    },
    quietPolls: m.quietPolls,
    codexRetriggered: m.codexRetriggered,
    ciPending: m.ciPending,
    ciFailed: m.ciFailed,
    nextPollMs,
  };
}

// ==========================================================================
// gh api -i PARSING
// ==========================================================================

/**
 * Parse `gh api -i` output: status line, headers, blank line, body.
 * A 304 has no body and gh exits 1 for it, so callers must not gate on
 * the exit code alone.
 *
 * @param {string} raw
 * @returns {{
 *   status: number,
 *   headers: Record<string, string>,
 *   etag: string | null,
 *   body: unknown,
 * } | null}
 */
export function parseGhHttpResponse(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const statusMatch = text.match(/^HTTP\/[\d.]+\s+(\d{3})/m);
  if (!statusMatch) return null;
  const statusLineEnd = text.indexOf('\n', statusMatch.index ?? 0);
  const rest = statusLineEnd >= 0 ? text.slice(statusLineEnd + 1) : '';
  const split = rest.indexOf('\n\n');
  const headerBlock = split >= 0 ? rest.slice(0, split) : rest;
  const bodyText = split >= 0 ? rest.slice(split + 2).trim() : '';

  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of headerBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }

  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  return {
    status: Number(statusMatch[1]),
    headers,
    etag: headers.etag ?? null,
    body,
  };
}

// ==========================================================================
// gh ADAPTER (impure)
// ==========================================================================

/**
 * @typedef {{
 *   get: (path: string, opts?: { etag?: string | null }) =>
 *     { status: number, etag: string | null, body: unknown },
 *   post: (path: string, fields: Record<string, string>) => unknown,
 *   graphql: (query: string, variables: Record<string, string | number>) =>
 *     unknown,
 * }} GhAdapter
 */

/**
 * `gh`-backed adapter. `spawn` is injectable so tests never hit GitHub.
 *
 * @param {string} repoRoot
 * @param {{ spawn?: typeof spawnSync }} [deps]
 * @returns {GhAdapter}
 */
export function createGhAdapter(repoRoot, { spawn = spawnSync } = {}) {
  const run = (args) =>
    spawn('gh', args, {
      encoding: 'utf8',
      cwd: repoRoot,
      shell: isWindows,
      maxBuffer: 64 * 1024 * 1024,
    });

  return {
    get(path, { etag = null } = {}) {
      const args = ['api', '-i', path, '-H', 'Accept: application/vnd.github+json'];
      if (etag) args.push('-H', `If-None-Match: ${etag}`);
      const res = run(args);
      const parsed = parseGhHttpResponse(res.stdout ?? '');
      if (!parsed) {
        throw new Error(
          `gh api ${path} failed: ${res.stderr?.trim() || res.stdout?.trim() || res.status}`,
        );
      }
      if (parsed.status >= 400) {
        throw new Error(`gh api ${path} → HTTP ${parsed.status}`);
      }
      return { status: parsed.status, etag: parsed.etag, body: parsed.body };
    },
    post(path, fields) {
      const args = ['api', '--method', 'POST', path];
      for (const [key, value] of Object.entries(fields)) {
        args.push('-f', `${key}=${value}`);
      }
      const res = run(args);
      if (res.status !== 0) {
        throw new Error(
          `gh api POST ${path} failed: ${res.stderr?.trim() || res.status}`,
        );
      }
      return res.stdout ? JSON.parse(res.stdout) : null;
    },
    graphql(query, variables) {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        args.push('-F', `${key}=${value}`);
      }
      const res = run(args);
      const text = (res.stdout ?? '').trim();
      if (!text) {
        throw new Error(
          `gh api graphql failed: ${res.stderr?.trim() || res.status}`,
        );
      }
      return JSON.parse(text);
    },
  };
}

// ==========================================================================
// POLLER (impure, but everything injectable)
// ==========================================================================

/**
 * Endpoints polled with `If-None-Match`. Each `since` is fixed at t0 so
 * the ETag stays comparable across polls.
 *
 * @param {{ owner: string, name: string }} repo
 * @param {number} prNumber
 * @param {string} head
 * @param {number} t0
 */
export function pollEndpoints(repo, prNumber, head, t0) {
  const base = `repos/${repo.owner}/${repo.name}`;
  const since = new Date(t0).toISOString();
  return {
    reviewComments:
      `${base}/pulls/${prNumber}/comments?per_page=100&since=${since}`,
    reviews: `${base}/pulls/${prNumber}/reviews?per_page=100`,
    issueComments:
      `${base}/issues/${prNumber}/comments?per_page=100&since=${since}`,
    reactions: `${base}/issues/${prNumber}/reactions?per_page=100`,
    checkRuns: `${base}/commits/${head}/check-runs?per_page=100`,
    pull: `${base}/pulls/${prNumber}`,
  };
}

/**
 * @param {{
 *   repo: { owner: string, name: string },
 *   prNumber: number,
 *   head: string,
 *   t0: number,
 *   adapter: GhAdapter,
 *   refreshThreads: () => {
 *     head?: string,
 *     unresolvedThreads: number,
 *     unresolvedBotThreads: number,
 *     ciPending?: boolean,
 *     ciFailed?: boolean,
 *     rateLimited?: boolean,
 *     rateLimit?: { remaining?: number, resetAt?: string } | null,
 *   },
 *   enabledBots?: string[] | null,
 *   cfg?: Partial<typeof SETTLED_DEFAULTS>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} opts
 */
export function createSettledPoller(opts) {
  const {
    repo,
    prNumber,
    adapter,
    refreshThreads,
    cfg = {},
    now = Date.now,
    log = () => {},
  } = opts;
  const c = { ...SETTLED_DEFAULTS, ...cfg };

  let machine = createMachine({
    head: opts.head,
    t0: opts.t0,
    enabledBots: opts.enabledBots ?? null,
  });
  /** @type {Record<string, string | null>} */
  let etags = {};
  /** @type {Record<string, unknown>} */
  let cache = {};
  let copilotWasRequested = false;
  let lastRefreshAt = 0;
  let lastNextPollMs = 0;
  let endpoints = pollEndpoints(repo, prNumber, machine.head, machine.t0);

  /**
   * Conditional GET; on 304 returns the cached body and `changed: false`.
   *
   * @param {string} key
   */
  const fetchConditional = (key) => {
    const res = adapter.get(endpoints[key], { etag: etags[key] ?? null });
    if (res.status === 304) {
      return { changed: false, body: cache[key] ?? null };
    }
    etags[key] = res.etag ?? null;
    cache[key] = res.body;
    return { changed: true, body: res.body };
  };

  const asArray = (value) => (Array.isArray(value) ? value : []);

  /** @returns {SettledObservation} */
  const observe = () => {
    const at = now();
    const state = machine.state;
    const obs = { now: at, botComments: [] };

    if (state === STATES.PUSHED && at - machine.t0 < c.pushedDelayMs) {
      return obs;
    }

    const comments = fetchConditional('reviewComments');
    const reviews = fetchConditional('reviews');
    const issues = fetchConditional('issueComments');
    const checks = fetchConditional('checkRuns');
    const needAck =
      state === STATES.AWAITING_ACK || !machine.signals.complete.codex;
    const reactions = needAck
      ? fetchConditional('reactions')
      : { changed: false, body: cache.reactions ?? null };
    const pull = fetchConditional('pull');

    const reviewList = asArray(reviews.body);
    const commentList = asArray(comments.body);
    const issueList = asArray(issues.body);
    const checkRuns = asArray(checks.body?.check_runs ?? checks.body);
    const requested = asArray(pull.body?.requested_reviewers).map(
      (r) => r?.login ?? r,
    );

    obs.head = pull.body?.head?.sha ?? null;
    obs.botComments = [
      ...commentList.map((c) => normalizeRestComment(c, 'review-comment')),
      ...reviewList.map((r) => normalizeRestComment(r, 'review')),
      ...issueList.map((c) => normalizeRestComment(c, 'issue-comment')),
    ];
    obs.signals = deriveSignals({
      head: machine.head,
      t0: machine.t0,
      reactions: asArray(reactions.body),
      reviews: reviewList,
      reviewComments: commentList,
      issueComments: issueList,
      checkRuns,
      requestedReviewers: requested,
      copilotWasRequested,
    });
    if (obs.signals.ack.copilot && !obs.signals.complete.copilot) {
      copilotWasRequested = true;
    }

    const restChanged =
      comments.changed || reviews.changed || issues.changed;
    const settling =
      state === STATES.SETTLED_CHECK || state === STATES.SETTLED;
    const ciDue =
      machine.ciPending && at - lastRefreshAt >= c.ciPendingPollMs;
    if (restChanged || settling || ciDue || lastRefreshAt === 0) {
      Object.assign(obs, refreshThreads());
      lastRefreshAt = at;
    }
    return obs;
  };

  const applyActions = (actions) => {
    for (const action of actions) {
      if (action === 'post-codex-retrigger') {
        log(`codex: no ack within window — posting "${BOTS.codex.retrigger}"`);
        adapter.post(
          `repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
          { body: BOTS.codex.retrigger },
        );
      } else if (action === 'head-changed') {
        etags = {};
        cache = {};
        lastRefreshAt = 0;
        copilotWasRequested = false;
        endpoints = pollEndpoints(repo, prNumber, machine.head, machine.t0);
        log(`head changed → ${machine.head.slice(0, 7)}; restart at PUSHED`);
      } else if (action === 'refresh-threads') {
        const refreshed = refreshThreads();
        lastRefreshAt = now();
        const step = stepMachine(machine, { now: now(), ...refreshed }, c);
        machine = step.machine;
        lastNextPollMs = step.nextPollMs;
      }
    }
  };

  return {
    /** One network round + one transition. */
    poll() {
      const before = machine.state;
      const obs = observe();
      const step = stepMachine(machine, obs, c);
      machine = step.machine;
      lastNextPollMs = step.nextPollMs;
      applyActions(step.actions);
      if (machine.state !== before) {
        log(`${before} → ${machine.state}`);
      }
      return {
        machine,
        nextPollMs: lastNextPollMs,
        actions: step.actions,
        observation: obs,
      };
    },
    /** Restart the machine for a new head (e.g. after our own push). */
    reset(head, t0 = now()) {
      machine = createMachine({ head, t0, enabledBots: machine.enabledBots });
      applyActions(['head-changed']);
    },
    snapshot() {
      return machineSnapshot(machine, lastNextPollMs);
    },
    get machine() {
      return machine;
    },
  };
}

// ==========================================================================
// WEBHOOK FAST PATH (opt-in, degrades to polling)
// ==========================================================================

export const WEBHOOK_EVENTS = Object.freeze([
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'issue_comment',
  'check_run',
]);

/**
 * Tiny receiver for `gh webhook forward`. Any POST wakes the poller; we
 * never trust the payload itself — the next poll re-reads GitHub.
 *
 * @param {{
 *   onEvent: (event: string) => void,
 *   port?: number,
 *   host?: string,
 * }} opts
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export async function startWebhookReceiver({
  onEvent,
  port = 0,
  host = '127.0.0.1',
}) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    req.resume();
    req.on('end', () => {
      res.statusCode = 204;
      res.end();
      onEvent(String(req.headers['x-github-event'] ?? 'unknown'));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = /** @type {{ port: number }} */ (server.address());
  return {
    port: address.port,
    url: `http://${host}:${address.port}/webhook`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Build the `gh webhook forward` argv for a repo + receiver URL.
 *
 * @param {{ owner: string, name: string }} repo
 * @param {string} url
 */
export function webhookForwardArgs(repo, url) {
  return [
    'webhook',
    'forward',
    `--repo=${repo.owner}/${repo.name}`,
    `--events=${WEBHOOK_EVENTS.join(',')}`,
    `--url=${url}`,
  ];
}

/**
 * Spawn the forwarder. Missing extension (`gh: unknown command
 * "webhook"`), no admin rights, or a dropped connection all resolve to
 * `{ ok: false }` — the caller keeps polling either way.
 *
 * @param {{
 *   repo: { owner: string, name: string },
 *   url: string,
 *   spawnFn?: typeof import('node:child_process').spawn,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ ok: boolean, reason?: string, stop: () => void }>}
 */
export async function spawnWebhookForwarder({ repo, url, spawnFn, log = () => {} }) {
  const spawnImpl = spawnFn ?? (await import('node:child_process')).spawn;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnImpl('gh', webhookForwardArgs(repo, url), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, stop });
    };
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      if (/forwarding/i.test(text)) finish({ ok: true });
    });
    child.on('error', (err) => finish({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      log(`webhook forwarder exited (${code}); polling continues`);
      finish({
        ok: false,
        reason: stderr.trim() || `gh webhook forward exited ${code}`,
      });
    });
    // gh prints nothing on success until the first event on some
    // versions; a live child after a short grace period counts as up.
    setTimeout(() => {
      if (child.exitCode == null && !child.killed) finish({ ok: true });
    }, 3_000).unref?.();
  });
}

// ==========================================================================
// WAKEABLE SLEEP (webhook fast path)
// ==========================================================================

/**
 * A sleep that a webhook (or any event) can cut short.
 *
 * @param {{ setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout }} [deps]
 */
export function createWakeableSleep({
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  /** @type {(() => void) | null} */
  let pendingWake = null;
  let wakeRequested = false;
  return {
    sleep(ms) {
      if (wakeRequested) {
        wakeRequested = false;
        return Promise.resolve('woken');
      }
      return new Promise((resolve) => {
        const timer = setTimeoutFn(() => {
          pendingWake = null;
          resolve('timeout');
        }, ms);
        pendingWake = () => {
          clearTimeoutFn(timer);
          pendingWake = null;
          resolve('woken');
        };
      });
    },
    wake() {
      if (pendingWake) {
        pendingWake();
      } else {
        wakeRequested = true;
      }
    },
  };
}
