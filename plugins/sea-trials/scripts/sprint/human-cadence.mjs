#!/usr/bin/env node
/**
 * Human cadence for Jira writes.
 *
 * A person creating a sprint in Jira makes the epic, then a story, then
 * its subtasks, pauses to think every handful of cards, occasionally
 * goes back to fix a typo, and does all of it during working hours. A
 * burst of thirty creates in thirty seconds is none of those things.
 * This module plans the timing and supplies the small pieces of free
 * text a person types repeatedly, so the Jira activity stream reads as
 * one person's afternoon.
 *
 * The MCP calls themselves are made by the caller (a skill or agent);
 * this file only produces the schedule, waits for it, and varies text.
 *
 * Usage:
 *   node human-cadence.mjs plan payload.json [--seed N] [--median-gap 12s]
 *        [--fast] [--edit-field labels] [--json]
 *   node human-cadence.mjs vary <kind> [--n 5] [--seed N] [--field summary]
 *   node human-cadence.mjs window [--hours 08:00-19:30] [--weekends]
 *        [--tz <IANA zone>] [--ignore-hours]
 *   node human-cadence.mjs wait --start <iso|epoch ms> --offset <ms|12s>
 *        [window flags]
 *   node human-cadence.mjs check "<text>" | check -   (reads stdin)
 *
 * `plan` exits 0. `window` exits 0 when writes are allowed now and 3
 * when the caller should wait (it prints how long). `wait` blocks until
 * `start + offset` and then until the activity window is open, so an
 * uploader can run it before each write. `check` exits 1 when the text
 * would fail the contract's banned-phrasing rules.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { diffAgainstState } from './parse-sprint-folder.mjs';

// ===========================================================================
// CONSTANTS
// ===========================================================================

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Tunables. Everything is overridable through `opts`. */
export const DEFAULTS = Object.freeze({
  medianGapMs: 12 * SECOND,
  minGapMs: 3 * SECOND,
  maxGapMs: 45 * SECOND,
  // Log-normal spread. 0.55 keeps ~95% of raw samples in 4-35 s.
  gapSigma: 0.55,
  thinkEveryMin: 6,
  thinkEveryMax: 10,
  thinkMinMs: 60 * SECOND,
  thinkMaxMs: 180 * SECOND,
  editChance: 0.1,
  editMinMs: 20 * SECOND,
  editMaxMs: 90 * SECOND,
  hours: '08:00-19:30',
  weekends: false,
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ===========================================================================
// SEEDED RANDOM
// ===========================================================================

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  // FNV-1a over the string form so `--seed sprint-12` is stable.
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * mulberry32: small, fast, deterministic. Returns a `() => number` in
 * [0, 1).
 *
 * @param {number|string} seed
 */
export function seededRandom(seed) {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function gaussian(rng) {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Integer in [lo, hi]. */
function intBetween(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Millisecond value in [lo, hi]. */
function msBetween(rng, lo, hi) {
  return Math.round(lo + rng() * (hi - lo));
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * One inter-card gap: log-normal around the median, clamped so a person
 * never appears faster than 3 s or slower than 45 s between cards.
 */
export function sampleGap(rng, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const raw = o.medianGapMs * Math.exp(o.gapSigma * gaussian(rng));
  return clamp(Math.round(raw), o.minGapMs, o.maxGapMs);
}

// ===========================================================================
// DURATIONS
// ===========================================================================

/**
 * `12s`, `2m`, `1.5h`, `500ms`, or a bare number (seconds by default).
 *
 * @param {string|number} value
 * @param {'ms'|'s'|'m'|'h'} [defaultUnit]
 */
export function parseDuration(value, defaultUnit = 's') {
  if (typeof value === 'number') return value;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(value));
  if (!m) throw new Error(`bad duration "${value}" (use 12s, 2m, 500ms)`);
  const unit = (m[2] ?? defaultUnit).toLowerCase();
  const mult = { ms: 1, s: SECOND, m: MINUTE, h: 60 * MINUTE }[unit];
  return Math.round(Number(m[1]) * mult);
}

/** `765000` -> `12m 45s`; `0` -> `0s`. */
export function formatDuration(ms) {
  const total = Math.round(ms / SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/** `+m:ss` (or `+h:mm:ss`) for schedule tables. */
export function formatOffset(ms) {
  const total = Math.round(ms / SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `+${h}:${String(m).padStart(2, '0')}:${s}` : `+${m}:${s}`;
}

// ===========================================================================
// ITEMS
// ===========================================================================

/**
 * @typedef {object} CadenceItem
 * @property {string} id            card id (`epic`, `3`, `3.2`)
 * @property {'epic'|'story'|'subtask'} [kind]  default `story`
 * @property {string} [epicId]      group key; default `epic`
 * @property {string} [storyId]     parent story for subtasks
 * @property {'create'|'update'} [action]  default `create`
 * @property {{ field: string }} [edit]  a one-field edit the executor
 *   can defer to a follow-up write (typo fix). Absent means no edit
 *   is available and none is planned.
 */

function normalizeItem(raw) {
  if (!raw || raw.id === undefined || raw.id === null) {
    throw new Error('every cadence item needs an id');
  }
  return {
    ...raw,
    id: String(raw.id),
    kind: raw.kind ?? 'story',
    epicId: raw.epicId ?? 'epic',
    storyId: raw.storyId === undefined ? null : String(raw.storyId),
    action: raw.action ?? 'create',
  };
}

/**
 * Human order: one epic at a time; the epic card first; stories in the
 * order given; each story's subtasks right after it. Subtasks whose
 * story is not in the list (story unchanged, subtask edited) keep their
 * relative position among the stories.
 *
 * @param {CadenceItem[]} items
 */
export function orderItems(items) {
  const all = items.map(normalizeItem);
  const groups = new Map();
  for (const it of all) {
    if (!groups.has(it.epicId)) groups.set(it.epicId, []);
    groups.get(it.epicId).push(it);
  }

  const out = [];
  for (const group of groups.values()) {
    out.push(...group.filter((it) => it.kind === 'epic'));
    const rest = group.filter((it) => it.kind !== 'epic');
    const placed = new Set();
    const place = (it) => {
      if (placed.has(it)) return;
      placed.add(it);
      out.push(it);
    };
    for (const it of rest) {
      if (placed.has(it)) continue;
      const storyId = it.kind === 'subtask' ? it.storyId : it.id;
      if (storyId === null) {
        place(it);
        continue;
      }
      const story = rest.find((s) => s.kind === 'story' && s.id === storyId);
      if (story) place(story);
      for (const sub of rest) {
        if (sub.kind === 'subtask' && sub.storyId === storyId) place(sub);
      }
      place(it);
    }
  }
  return out;
}

/**
 * Cards that need a write, in document order, from a
 * `parse-sprint-folder.mjs --out` payload. Unchanged cards are skipped
 * unless `opts.includeUnchanged`. With `opts.editField`, every create
 * carries an available one-field edit for the planner's typo pass.
 *
 * @param {object} payload
 * @param {{ editField?: string, includeUnchanged?: boolean }} [opts]
 * @returns {CadenceItem[]}
 */
export function itemsFromPayload(payload, opts = {}) {
  const sprint = {
    ...payload,
    stories: payload.stories ?? [],
    state: { stories: {}, ...(payload.state ?? {}) },
  };
  sprint.state.stories ??= {};
  const diff = diffAgainstState(sprint);
  const bucketOf = new Map();
  for (const bucket of ['create', 'update', 'unchanged']) {
    for (const e of diff[bucket]) {
      bucketOf.set(`${e.kind}:${e.id}`, { bucket, key: e.key ?? null });
    }
  }

  const items = [];
  const push = (kind, id, extra) => {
    const b = bucketOf.get(`${kind}:${id}`);
    if (!b) return;
    if (b.bucket === 'unchanged' && !opts.includeUnchanged) return;
    const action = b.bucket === 'update' ? 'update' : 'create';
    const item = { id: String(id), kind, epicId: 'epic', action, ...extra };
    if (b.key) item.key = b.key;
    if (action === 'create' && opts.editField) {
      item.edit = { field: opts.editField };
    }
    items.push(item);
  };

  if (sprint.epic) push('epic', 'epic', { summary: sprint.epic.summary });
  for (const story of sprint.stories) {
    push('story', story.id, { summary: story.summary });
    for (const sub of story.subtasks ?? []) {
      push('subtask', sub.id, {
        storyId: String(story.id),
        summary: sub.summary,
      });
    }
  }
  return items;
}

// ===========================================================================
// SCHEDULE
// ===========================================================================

/**
 * @typedef {object} ScheduleEntry
 * @property {string} id            `3.2` for a card, `3.2#edit` for its
 *   follow-up edit
 * @property {string} [targetId]    card id an edit applies to
 * @property {'epic'|'story'|'subtask'} kind
 * @property {'create'|'update'|'edit'} action
 * @property {string} [field]       the one field an `edit` touches
 * @property {string|null} [deferField]  on a create: leave this field
 *   out and let the planned `edit` set it
 * @property {number} startOffsetMs offset from the run start
 * @property {number} batch         1-based; increments at each think pause
 */

/**
 * Plan when each write happens. Deterministic for a given `opts.seed`.
 *
 * Rules: one epic at a time; epic card first; stories in order; subtasks
 * right after their story; log-normal gap (median `opts.medianGapMs`,
 * clamped 3-45 s); a 60-180 s think pause after every 6-10 cards; a
 * one-field edit 20-90 s after roughly one in ten creates that offer
 * one (`item.edit`); never two writes in the same second. `opts.fast`
 * collapses every gap to 0 for dry runs and tests.
 *
 * @param {CadenceItem[]} items
 * @param {Partial<typeof DEFAULTS> & { seed?: number|string,
 *   fast?: boolean }} [opts]
 * @returns {ScheduleEntry[]}
 */
export function planSchedule(items, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rng = seededRandom(o.seed ?? Date.now());
  const ordered = orderItems(items);
  const fast = Boolean(o.fast);

  const cards = [];
  const edits = [];
  let offset = 0;
  let batch = 1;
  let inBatch = 0;
  let batchSize = intBetween(rng, o.thinkEveryMin, o.thinkEveryMax);

  ordered.forEach((item, i) => {
    if (i > 0 && !fast) offset += sampleGap(rng, o);
    const entry = {
      id: item.id,
      kind: item.kind,
      action: item.action,
      epicId: item.epicId,
      storyId: item.storyId,
      key: item.key ?? null,
      summary: item.summary ?? null,
      deferField: null,
      startOffsetMs: offset,
      batch,
    };
    cards.push(entry);

    const editField = item.edit?.field;
    if (editField && item.action === 'create' && rng() < o.editChance) {
      entry.deferField = editField;
      const delay = fast ? 0 : msBetween(rng, o.editMinMs, o.editMaxMs);
      edits.push({
        id: `${item.id}#edit`,
        targetId: item.id,
        kind: item.kind,
        action: 'edit',
        epicId: item.epicId,
        storyId: item.storyId,
        key: item.key ?? null,
        field: editField,
        startOffsetMs: offset + delay,
        batch,
      });
    }

    inBatch += 1;
    const more = i < ordered.length - 1;
    if (inBatch >= batchSize && more) {
      if (!fast) offset += msBetween(rng, o.thinkMinMs, o.thinkMaxMs);
      batch += 1;
      inBatch = 0;
      batchSize = intBetween(rng, o.thinkEveryMin, o.thinkEveryMax);
    }
  });

  // Stable sort: on a tie the create stays ahead of any edit.
  const schedule = [...cards, ...edits]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.startOffsetMs - b.e.startOffsetMs || a.i - b.i)
    .map(({ e }) => e);

  if (!fast) {
    let lastSecond = -1;
    for (const e of schedule) {
      let second = Math.floor(e.startOffsetMs / SECOND);
      if (second <= lastSecond) {
        second = lastSecond + 1;
        e.startOffsetMs = second * SECOND + (e.startOffsetMs % SECOND);
      }
      lastSecond = second;
    }
  }
  return schedule;
}

/**
 * Totals for a schedule: writes by action, batches, think pauses (gaps
 * longer than the max card gap), and total duration.
 *
 * @param {ScheduleEntry[]} schedule
 */
export function summarizeSchedule(schedule, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const counts = { create: 0, update: 0, edit: 0 };
  let thinkPauses = 0;
  let batches = 0;
  let prevCard = null;
  for (const e of schedule) {
    counts[e.action] = (counts[e.action] ?? 0) + 1;
    batches = Math.max(batches, e.batch);
    if (e.action !== 'edit') {
      if (prevCard && e.startOffsetMs - prevCard.startOffsetMs > o.maxGapMs) {
        thinkPauses += 1;
      }
      prevCard = e;
    }
  }
  const last = schedule.length ? schedule[schedule.length - 1] : null;
  return {
    writes: schedule.length,
    creates: counts.create,
    updates: counts.update,
    edits: counts.edit,
    batches,
    thinkPauses,
    totalMs: last ? last.startOffsetMs : 0,
  };
}

// ===========================================================================
// ACTIVITY WINDOW
// ===========================================================================

const formatters = new Map();

function localParts(ms, tz) {
  const key = tz ?? '';
  if (!formatters.has(key)) {
    formatters.set(
      key,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  }
  const parts = {};
  for (const p of formatters.get(key).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    weekday: WEEKDAYS.indexOf(parts.weekday),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

/** `08:00-19:30` or `['08:00', '19:30']` -> minutes since midnight. */
export function parseHours(hours) {
  const pair = Array.isArray(hours) ? hours : String(hours).split('-');
  if (pair.length !== 2) throw new Error(`bad hours "${hours}" (HH:MM-HH:MM)`);
  const toMin = (s) => {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s);
    if (!m) throw new Error(`bad time "${s}" in hours "${hours}"`);
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const start = toMin(pair[0]);
  const end = toMin(pair[1]);
  if (end <= start) throw new Error(`hours "${hours}" must end after start`);
  return { start, end };
}

/**
 * May we write to Jira right now, and if not, when?
 *
 * @param {number|Date} [now]
 * @param {{ hours?: string|string[], weekends?: boolean, tz?: string,
 *   ignoreHours?: boolean }} [opts]
 * @returns {{ allowed: boolean, nextAllowed: number, waitMs: number }}
 *   `nextAllowed` is an epoch ms; equals `now` when allowed.
 */
export function activityWindow(now = Date.now(), opts = {}) {
  const t = typeof now === 'number' ? now : new Date(now).getTime();
  if (opts.ignoreHours) return { allowed: true, nextAllowed: t, waitMs: 0 };
  const { start, end } = parseHours(opts.hours ?? DEFAULTS.hours);
  const weekends = Boolean(opts.weekends);

  let candidate = t;
  for (let step = 0; step < 32; step += 1) {
    const p = localParts(candidate, opts.tz);
    const dayOk = weekends || (p.weekday !== 0 && p.weekday !== 6);
    if (dayOk && p.minutes >= start && p.minutes < end) {
      return {
        allowed: candidate === t,
        nextAllowed: candidate,
        waitMs: candidate - t,
      };
    }
    const minuteFloor = candidate - (candidate % MINUTE);
    if (dayOk && p.minutes < start) {
      candidate = minuteFloor + (start - p.minutes) * MINUTE;
    } else {
      candidate = minuteFloor + (1440 - p.minutes) * MINUTE;
    }
  }
  throw new Error('no activity window found; check hours and weekends');
}

// ===========================================================================
// RUNNING
// ===========================================================================

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sleep until `startedAt + entry.startOffsetMs`. Returns the ms slept.
 *
 * @param {ScheduleEntry} entry
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   startedAt?: number }} [io]
 */
export async function waitFor(entry, io = {}) {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? realSleep;
  const base = io.startedAt ?? now();
  const delay = Math.max(0, base + entry.startOffsetMs - now());
  if (delay > 0) await sleep(delay);
  return delay;
}

/**
 * Execute `executor(entry, record)` for each schedule entry at its
 * offset, inside the activity window, recording actual times. Stops at
 * the first executor error and returns the partial log.
 *
 * @param {CadenceItem[]} items
 * @param {(entry: ScheduleEntry, record: object) => Promise<unknown>} executor
 * @param {object} [opts] planSchedule opts plus `schedule`, `sleep`,
 *   `now`, `hours`, `weekends`, `tz`, `ignoreHours`
 */
export async function runWithCadence(items, executor, opts = {}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const schedule = opts.schedule ?? planSchedule(items, opts);
  const startedAt = now();
  let base = startedAt;
  const log = [];

  for (let i = 0; i < schedule.length; i += 1) {
    const entry = schedule[i];
    await waitFor(entry, { sleep, now, startedAt: base });
    let windowWaitMs = 0;
    const w = activityWindow(now(), opts);
    if (!w.allowed) {
      windowWaitMs = w.waitMs;
      base += windowWaitMs;
      await sleep(windowWaitMs);
    }
    const at = now();
    const record = {
      id: entry.id,
      action: entry.action,
      plannedOffsetMs: entry.startOffsetMs,
      actualOffsetMs: at - startedAt,
      windowWaitMs,
      at,
    };
    try {
      record.result = await executor(entry, record);
      log.push(record);
    } catch (error) {
      record.error = error?.message ?? String(error);
      log.push(record);
      return {
        ok: false,
        error,
        log,
        schedule,
        startedAt,
        finishedAt: now(),
        remaining: schedule.slice(i + 1),
      };
    }
  }
  return {
    ok: true,
    log,
    schedule,
    startedAt,
    finishedAt: now(),
    remaining: [],
  };
}

// ===========================================================================
// FORBIDDEN LANGUAGE (contract section 5 plus the voice rules)
// ===========================================================================

const FORBIDDEN_RULES = [
  // Lint group.
  ['vague', /\bmaybe\b/i],
  ['vague', /\bconsider\b/i],
  ['vague', /\bmight want to\b/i],
  ['vague', /\bexplore whether\b/i],
  ['vague', /\binvestigate if\b/i],
  ['vague', /\bTBD\b/],
  ['vague', /TODO:/],
  ['vague', /\blook into\b/i],
  ['ai-tell', /\bClaude\b/],
  ['ai-tell', /\bCursor\b/],
  ['ai-tell', /\bChatGPT\b/i],
  ['ai-tell', /\bCopilot\b/],
  ['ai-tell', /\bAs an AI\b/i],
  ['ai-tell', /\bLLMs?\b/],
  ['ai-tell', /\bsubagents?\b/i],
  ['ai-tell', /\bTask\(/],
  ['md-link', /\.md\b/i],
  // Contract group.
  ['contract-ban', /\bresearch\b/i],
  ['contract-ban', /\bspike\b/i],
  ['contract-ban', /\bexplore\b/i],
  ['contract-ban', /\binvestigate\b/i],
  ['contract-ban', /\bevaluate options\b/i],
  ['contract-ban', /\bas needed\b/i],
  ['contract-ban', /\bif possible\b/i],
  ['contract-ban', /\bwhere appropriate\b/i],
  ['contract-ban', /\betc\./i],
  ['contract-ban', /\band so on\b/i],
  ['contract-ban', /\bworks correctly\b/i],
  ['contract-ban', /\blooks good\b/i],
  ['contract-ban', /\buser-friendly\b/i],
  ['contract-ban', /\bhandle edge cases\b/i],
  ['contract-ban', /\bsee (?:subtask|story)\b/i],
  ['contract-ban', /\bper the overview\b/i],
  ['contract-ban', /\bonce US\d+[a-z]? is merged\b/i],
  ['contract-ban', /\bPhase 0\b/i],
  ['contract-ban', /\bgates?\b/i],
  ['contract-ban', /\bcheckpoints?\b/i],
  ['contract-ban', /\brollback plan\b/i],
  ['contract-ban', /\bAI\b/],
  ['contract-ban', /\bagents?\b/i],
  ['contract-ban', /\bgenerated\b/i],
  ['contract-ban', /\bassistants?\b/i],
  ['contract-ban', /\bprompts?\b/i],
  ['contract-ban', /\bmodel output\b/i],
  ['placeholder', /\{\{|\}\}/],
  ['placeholder', /<[A-Z][A-Za-z_ -]*>/],
  ['emoji', /\p{Extended_Pictographic}/u],
  // Voice rules for anything a person "types" in Jira.
  ['automation-tell', /\b(?:automation|automated|automatically)\b/i],
  ['automation-tell', /\bscripts?\b/i],
  ['automation-tell', /\bbots?\b/i],
  ['exclamation', /!/],
  ['em-dash', /\u2014/],
];

/**
 * Every banned-phrasing hit in `text`. Empty array means it may go to
 * Jira.
 *
 * @param {string} text
 * @returns {Array<{ rule: string, match: string }>}
 */
export function forbiddenLanguage(text) {
  const hits = [];
  for (const [rule, re] of FORBIDDEN_RULES) {
    const m = re.exec(text ?? '');
    if (m) hits.push({ rule, match: m[0] });
  }
  return hits;
}

/** @param {string} text */
export function passesForbidden(text) {
  return forbiddenLanguage(text).length === 0;
}

// ===========================================================================
// PHRASING VARIETY
// ===========================================================================

/**
 * Text a person types over and over during an upload. Each kind has at
 * least eight variants; some start lowercase, most use contractions,
 * none use exclamation marks, emojis, or em dashes, and all pass
 * `forbiddenLanguage`. `{field}` is filled from `ctx.field`.
 */
const PHRASES = Object.freeze({
  'comment-opener': [
    'Updated the AC after standup.',
    'Tweaked the wording on this one.',
    "Reworked the scope table, the old one didn't match what we agreed.",
    'small edit to the test plan, nothing else changed.',
    'Rewrote the description so it reads in one pass.',
    'Fixed the files list, two paths were stale.',
    'Split one AC line that was doing two things.',
    'moved a couple of lines around, same content.',
    'Dropped a duplicate AC and tightened the rest.',
    'Brought this in line with the epic after the planning call.',
    "Clarified the out-of-scope list, it wasn't obvious before.",
  ],
  'edit-reason': [
    'Typo in the {field}, fixed.',
    'Forgot the {field} on the first pass.',
    'Had the wrong {field}, corrected it.',
    'quick fix to the {field}.',
    'Missed the {field} when I created this.',
    "The {field} didn't match the story, sorted now.",
    'Cleaned up the {field}.',
    "second look at the {field}, it's right now.",
    "Set the {field} I'd left blank.",
    'Corrected the {field}, nothing else touched.',
  ],
  'moved-to-backlog': [
    "Moving this to the backlog, it won't fit this sprint.",
    "Backlog for now, we'll pick it up next sprint.",
    'Pulled this out of the sprint after the capacity check.',
    'not this sprint. Parking it in the backlog.',
    'Deferring this one, the story it depends on slipped.',
    'Out of the sprint for now, scope got tighter.',
    'Backlogging this so the sprint stays honest.',
    "Taking this out of the sprint, we're over capacity.",
    'Moved to the backlog, will reslot it at planning.',
  ],
  'verifier-remark': [
    'Checked this against the source, boxes render fine.',
    'Read through it again, AC count matches.',
    'Looks right to me, headings and checkboxes all present.',
    'went over the card once more, nothing missing.',
    'Compared with the write-up, all the checkboxes are there.',
    'Reviewed the description, it matches what we planned.',
    'One more pass done, the summary and AC line up.',
    "Read it back, I'm happy with how it renders.",
    'Verified the checkboxes are real checkboxes, not text.',
    "Double-checked the story points and labels, they're both set.",
  ],
});

const CTX_DEFAULTS = Object.freeze({ field: 'summary' });

function fillTemplate(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    const v = ctx?.[name] ?? CTX_DEFAULTS[name];
    return v === undefined ? whole : String(v);
  });
}

/** Names accepted by `vary`. */
export function varyKinds() {
  return Object.keys(PHRASES);
}

/** All raw variants for a kind (tests and docs). */
export function varyVariants(kind) {
  const list = PHRASES[kind];
  if (!list) {
    const known = varyKinds().join(', ');
    throw new Error(`unknown vary kind "${kind}"; known: ${known}`);
  }
  return [...list];
}

const VARY_MEMORY = 3;

/**
 * A `vary(kind, ctx)` function with its own rotation state. Never
 * returns the same variant twice in a row for one kind; in fact it
 * avoids the last three picks so short runs do not read A-B-A.
 *
 * @param {{ seed?: number|string }} [opts]
 */
export function createVary(opts = {}) {
  const rng = seededRandom(opts.seed ?? Date.now());
  const recent = new Map();
  return function vary(kind, ctx = {}) {
    const list = varyVariants(kind);
    const seen = recent.get(kind) ?? [];
    const memory = Math.min(VARY_MEMORY, list.length - 1);
    let idx;
    do {
      idx = Math.floor(rng() * list.length);
    } while (seen.includes(idx));
    seen.push(idx);
    recent.set(kind, seen.slice(-memory));
    return fillTemplate(list[idx], ctx);
  };
}

/** Shared instance; seeded from the clock so runs differ. */
export const vary = createVary();

// ===========================================================================
// CLI
// ===========================================================================

const BOOL_FLAGS = new Set([
  '--fast',
  '--json',
  '--weekends',
  '--ignore-hours',
  '--include-unchanged',
]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { command: argv[0], positional: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (BOOL_FLAGS.has(arg)) out[arg.slice(2).replace(/-/g, '_')] = true;
    else if (arg.startsWith('--')) {
      out[arg.slice(2).replace(/-/g, '_')] = argv[++i];
    } else out.positional.push(arg);
  }
  return out;
}

const USAGE =
  'usage: human-cadence.mjs plan <payload.json> [--seed N] ' +
  '[--median-gap 12s] [--fast] [--edit-field <field>] [--json]\n' +
  '       human-cadence.mjs vary <kind> [--n 5] [--seed N] ' +
  '[--field <name>]\n' +
  '       human-cadence.mjs window [--hours 08:00-19:30] [--weekends] ' +
  '[--tz <zone>] [--ignore-hours]\n' +
  '       human-cadence.mjs wait --start <iso|epoch ms> --offset <12s> ' +
  '[window flags]\n' +
  '       human-cadence.mjs check "<text>" | check -\n' +
  `kinds: ${varyKinds().join(', ')}\n`;

/** `--seed 7` means the number 7, so CLI and API schedules agree. */
function seedArg(value) {
  if (value === undefined) return Date.now();
  const n = Number(value);
  return Number.isFinite(n) && value.trim() !== '' ? n : value;
}

function windowOpts(args) {
  return {
    hours: args.hours,
    weekends: args.weekends,
    tz: args.tz,
    ignoreHours: args.ignore_hours,
  };
}

function renderTable(schedule, summary, seed) {
  const rows = schedule.map((e) => [
    e.id,
    e.kind,
    e.action + (e.deferField ? ` (defer ${e.deferField})` : ''),
    formatOffset(e.startOffsetMs),
    String(e.batch),
  ]);
  const head = ['id', 'kind', 'action', 'offset', 'batch'];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cols) =>
    cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(head), ...rows.map(line)];
  out.push('');
  out.push(
    `total: ${summary.writes} writes (${summary.creates} creates, ` +
      `${summary.updates} updates, ${summary.edits} edits) over ` +
      `${formatDuration(summary.totalMs)}, ${summary.thinkPauses} think ` +
      `pause(s), ${summary.batches} batch(es), seed ${seed}`,
  );
  return `${out.join('\n')}\n`;
}

function parseStart(value) {
  if (value === undefined) throw new Error('wait needs --start <iso|ms>');
  const asNumber = Number(value);
  const ms = Number.isFinite(asNumber) && value.trim() !== ''
    ? asNumber
    : new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`bad --start "${value}"`);
  return ms;
}

/**
 * `wait`: sleep until `start + offset`, then until the window opens.
 * Prints what it waited for. Returns the exit code.
 */
async function runWait(args, io) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? realSleep;
  const start = parseStart(args.start);
  const offset = args.offset === undefined ? 0 : parseDuration(args.offset);
  const slept = await waitFor(
    { startOffsetMs: offset },
    { startedAt: start, now, sleep },
  );
  const w = activityWindow(now(), windowOpts(args));
  if (!w.allowed) {
    const when = new Date(w.nextAllowed).toISOString();
    out(`window closed, waiting ${formatDuration(w.waitMs)} until ${when}\n`);
    await sleep(w.waitMs);
  }
  out(`waited ${formatDuration(slept + w.waitMs)}\n`);
  return 0;
}

/**
 * Run the CLI against `argv` (without node/script). Returns the exit
 * code (a Promise of one for `wait`); writes through `io` so tests can
 * capture output.
 *
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   stdin?: () => string }} [io]
 */
export function runCli(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  const pos = args.positional;

  try {
    switch (args.command) {
      case 'plan': {
        const file = pos[0];
        if (!file || !fs.existsSync(file)) {
          throw new Error('plan <payload.json>');
        }
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        const seed = seedArg(args.seed);
        const opts = {
          seed,
          fast: args.fast,
          medianGapMs: args.median_gap
            ? parseDuration(args.median_gap)
            : DEFAULTS.medianGapMs,
        };
        const items = itemsFromPayload(payload, {
          editField: args.edit_field,
          includeUnchanged: args.include_unchanged,
        });
        const schedule = planSchedule(items, opts);
        const summary = summarizeSchedule(schedule, opts);
        if (args.json) {
          out(`${JSON.stringify({ seed, ...summary, schedule }, null, 2)}\n`);
        } else {
          out(renderTable(schedule, summary, seed));
        }
        return 0;
      }
      case 'vary': {
        const kind = pos[0];
        if (!kind) {
          throw new Error(`vary <kind>; kinds: ${varyKinds().join(', ')}`);
        }
        const n = Number(args.n ?? 1);
        const v = createVary({ seed: seedArg(args.seed) });
        for (let i = 0; i < n; i += 1) {
          out(`${v(kind, { field: args.field })}\n`);
        }
        return 0;
      }
      case 'window': {
        const now = (io.now ?? Date.now)();
        const w = activityWindow(now, windowOpts(args));
        if (w.allowed) {
          out('open\n');
          return 0;
        }
        const when = new Date(w.nextAllowed).toISOString();
        out(`closed until ${when} (wait ${formatDuration(w.waitMs)})\n`);
        return 3;
      }
      case 'wait':
        return runWait(args, io).catch((e) => {
          err(`${e.message}\n`);
          return 1;
        });
      case 'check': {
        const text =
          pos[0] === '-' || pos.length === 0
            ? (io.stdin ?? (() => fs.readFileSync(0, 'utf8')))()
            : pos.join(' ');
        const hits = forbiddenLanguage(text);
        for (const h of hits) out(`${h.rule}: "${h.match}"\n`);
        out(hits.length ? `${hits.length} problem(s)\n` : 'ok\n');
        return hits.length ? 1 : 0;
      }
      default:
        err(USAGE);
        return 2;
    }
  } catch (e) {
    err(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  Promise.resolve(runCli(process.argv.slice(2))).then((code) =>
    process.exit(code),
  );
}
