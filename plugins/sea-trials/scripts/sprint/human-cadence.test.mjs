import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  DEFAULTS,
  activityWindow,
  createVary,
  forbiddenLanguage,
  formatDuration,
  formatOffset,
  itemsFromPayload,
  orderItems,
  parseArgs,
  parseDuration,
  parseHours,
  passesForbidden,
  planSchedule,
  runCli,
  runWithCadence,
  sampleGap,
  seededRandom,
  summarizeSchedule,
  vary,
  varyKinds,
  varyVariants,
  waitFor,
} from './human-cadence.mjs';

const SCRIPT = fileURLToPath(new URL('./human-cadence.mjs', import.meta.url));
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// A Tuesday, 10:00 UTC. Window tests pin `tz: 'UTC'` so the machine's
// zone never matters.
const TUESDAY_10 = Date.UTC(2026, 8, 22, 10, 0, 0);
const UTC = { tz: 'UTC' };

// ===========================================================================
// FIXTURES
// ===========================================================================

/** Epic + 6 stories + 23 subtasks = 30 cards. */
function fixture30(extra = {}) {
  const items = [{ id: 'epic', kind: 'epic', ...extra }];
  for (let s = 1; s <= 6; s += 1) {
    items.push({ id: String(s), kind: 'story', ...extra });
    const subs = s === 6 ? 3 : 4;
    for (let k = 1; k <= subs; k += 1) {
      items.push({
        id: `${s}.${k}`,
        kind: 'subtask',
        storyId: String(s),
        ...extra,
      });
    }
  }
  return items;
}

function cardsOnly(schedule) {
  return schedule.filter((e) => e.action !== 'edit');
}

function virtualClock(start) {
  let t = start;
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

function payloadFixture() {
  const sub = (id) => ({
    id,
    title: `Sub ${id}`,
    summary: `Sub ${id}`,
    description: `- [ ] do ${id}`,
    hash: `h-${id}`,
  });
  const story = (id, subs) => ({
    id,
    summary: `User Story ${id}: thing ${id}`,
    description: `## Acceptance criteria\n\n- [ ] ac ${id}`,
    hash: `h-${id}`,
    subtasks: subs.map(sub),
  });
  return {
    epic: { summary: 'Epic', description: 'goal', hash: 'h-epic' },
    stories: [
      story('1', ['1.1', '1.2']),
      story('2', ['2.1']),
      story('3', ['3.1', '3.2', '3.3']),
    ],
    state: { stories: {} },
  };
}

// ===========================================================================
// RANDOM + GAPS
// ===========================================================================

test('seededRandom is deterministic and in [0, 1)', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const c = seededRandom('42');
  for (let i = 0; i < 100; i += 1) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(seededRandom(1)(), seededRandom(2)());
  // A numeric string is not the same seed as the number (FNV vs int).
  assert.notEqual(c(), seededRandom(42)());
});

test('sampleGap stays inside [3 s, 45 s] and centres near the median', () => {
  const rng = seededRandom(7);
  const gaps = Array.from({ length: 2000 }, () => sampleGap(rng));
  for (const g of gaps) {
    assert.ok(g >= DEFAULTS.minGapMs && g <= DEFAULTS.maxGapMs, String(g));
  }
  const sorted = [...gaps].sort((x, y) => x - y);
  const median = sorted[sorted.length / 2];
  assert.ok(Math.abs(median - DEFAULTS.medianGapMs) < 1500, String(median));
  assert.ok(gaps.some((g) => g < 6 * SECOND));
  assert.ok(gaps.some((g) => g > 25 * SECOND));
});

test('parseDuration and formatters', () => {
  assert.equal(parseDuration('12s'), 12000);
  assert.equal(parseDuration('2m'), 120000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration('9'), 9000);
  assert.equal(parseDuration(750), 750);
  assert.throws(() => parseDuration('soon'));
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(765000), '12m 45s');
  assert.equal(formatDuration(3_725_000), '1h 2m 5s');
  assert.equal(formatOffset(0), '+0:00');
  assert.equal(formatOffset(61_000), '+1:01');
  assert.equal(formatOffset(3_661_000), '+1:01:01');
});

// ===========================================================================
// ORDERING
// ===========================================================================

test('orderItems: epic first, stories in order, subtasks after story', () => {
  const shuffled = [
    { id: '2.1', kind: 'subtask', storyId: '2' },
    { id: '1', kind: 'story' },
    { id: 'epic', kind: 'epic' },
    { id: '2', kind: 'story' },
    { id: '1.2', kind: 'subtask', storyId: '1' },
    { id: '1.1', kind: 'subtask', storyId: '1' },
  ];
  const ids = orderItems(shuffled).map((e) => e.id);
  // Story 2 is reached first through its subtask, so its group leads.
  assert.deepEqual(ids, ['epic', '2', '2.1', '1', '1.2', '1.1']);
});

test('orderItems: one epic at a time across two epics', () => {
  const items = [
    { id: 'A', kind: 'epic', epicId: 'A' },
    { id: 'a1', kind: 'story', epicId: 'A' },
    { id: 'B', kind: 'epic', epicId: 'B' },
    { id: 'b1', kind: 'story', epicId: 'B' },
    { id: 'a1.1', kind: 'subtask', epicId: 'A', storyId: 'a1' },
    { id: 'b1.1', kind: 'subtask', epicId: 'B', storyId: 'b1' },
  ];
  assert.deepEqual(
    orderItems(items).map((e) => e.id),
    ['A', 'a1', 'a1.1', 'B', 'b1', 'b1.1'],
  );
});

test('orderItems: orphan subtasks keep their place among stories', () => {
  const items = [
    { id: '1', kind: 'story' },
    { id: '3.2', kind: 'subtask', storyId: '3' },
    { id: '3.1', kind: 'subtask', storyId: '3' },
    { id: '4', kind: 'story' },
  ];
  assert.deepEqual(
    orderItems(items).map((e) => e.id),
    ['1', '3.2', '3.1', '4'],
  );
  assert.throws(() => orderItems([{ kind: 'story' }]), /needs an id/);
});

// ===========================================================================
// SCHEDULE
// ===========================================================================

test('planSchedule is deterministic per seed and differs across seeds', () => {
  const a = planSchedule(fixture30(), { seed: 11 });
  const b = planSchedule(fixture30(), { seed: 11 });
  const c = planSchedule(fixture30(), { seed: 12 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(
    a.map((e) => e.startOffsetMs),
    c.map((e) => e.startOffsetMs),
  );
  assert.equal(a[0].startOffsetMs, 0);
  assert.equal(a[0].id, 'epic');
});

test('planSchedule keeps human order and monotone offsets', () => {
  const schedule = planSchedule(fixture30(), { seed: 3 });
  const ids = cardsOnly(schedule).map((e) => e.id);
  assert.deepEqual(ids, fixture30().map((i) => i.id));
  for (let i = 1; i < schedule.length; i += 1) {
    assert.ok(schedule[i].startOffsetMs > schedule[i - 1].startOffsetMs);
  }
});

test('gaps are 3-45 s, or a 60-180 s think pause on top of a gap', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const cards = cardsOnly(planSchedule(fixture30(), { seed }));
    let pauses = 0;
    let sinceLast = 0;
    for (let i = 1; i < cards.length; i += 1) {
      const gap = cards[i].startOffsetMs - cards[i - 1].startOffsetMs;
      const isPause = gap > DEFAULTS.maxGapMs;
      if (isPause) {
        assert.ok(gap >= 63 * SECOND && gap <= 225 * SECOND, String(gap));
        assert.equal(cards[i].batch, cards[i - 1].batch + 1);
        assert.ok(sinceLast >= 6 && sinceLast <= 10, `pause after ${sinceLast}`);
        pauses += 1;
        sinceLast = 0;
      } else {
        assert.ok(gap >= 3 * SECOND, String(gap));
        assert.equal(cards[i].batch, cards[i - 1].batch);
      }
      sinceLast += 1;
    }
    assert.ok(pauses >= 2 && pauses <= 4, `seed ${seed}: ${pauses} pauses`);
  }
});

test('no edits are planned unless the item offers one', () => {
  const schedule = planSchedule(fixture30(), { seed: 5 });
  assert.equal(schedule.filter((e) => e.action === 'edit').length, 0);
  assert.ok(schedule.every((e) => e.deferField === null));
});

test('edits: ~10% of creates, one field, 20-90 s after the create', () => {
  let edits = 0;
  let creates = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const items = fixture30({ edit: { field: 'labels' } });
    const schedule = planSchedule(items, { seed });
    creates += cardsOnly(schedule).length;
    for (const e of schedule.filter((x) => x.action === 'edit')) {
      edits += 1;
      assert.equal(e.field, 'labels');
      const create = schedule.find((c) => c.id === e.targetId);
      assert.equal(create.deferField, 'labels');
      const delta = e.startOffsetMs - create.startOffsetMs;
      // +1 s slack for the same-second push.
      assert.ok(delta >= 20 * SECOND && delta <= 91 * SECOND, String(delta));
      assert.equal(e.batch, create.batch);
    }
  }
  const rate = edits / creates;
  assert.ok(rate > 0.06 && rate < 0.14, `edit rate ${rate}`);
});

test('edits never apply to update-bucket cards', () => {
  const items = fixture30({ edit: { field: 'labels' }, action: 'update' });
  for (let seed = 1; seed <= 10; seed += 1) {
    const schedule = planSchedule(items, { seed });
    assert.equal(schedule.filter((e) => e.action === 'edit').length, 0);
  }
});

test('never two writes in the same second', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const items = fixture30({ edit: { field: 'labels' } });
    const schedule = planSchedule(items, { seed, editChance: 0.6 });
    const seconds = schedule.map((e) => Math.floor(e.startOffsetMs / 1000));
    assert.equal(new Set(seconds).size, seconds.length, `seed ${seed}`);
    for (let i = 1; i < schedule.length; i += 1) {
      assert.ok(schedule[i].startOffsetMs > schedule[i - 1].startOffsetMs);
    }
  }
});

test('fast mode collapses every offset to zero', () => {
  const items = fixture30({ edit: { field: 'labels' } });
  const schedule = planSchedule(items, { seed: 9, fast: true });
  assert.ok(schedule.every((e) => e.startOffsetMs === 0));
  assert.equal(summarizeSchedule(schedule).totalMs, 0);
  assert.equal(cardsOnly(schedule).length, 30);
});

test('30 cards at default settings take 8-15 minutes', () => {
  const totals = [];
  for (let seed = 1; seed <= 20; seed += 1) {
    const schedule = planSchedule(fixture30(), { seed });
    const s = summarizeSchedule(schedule);
    assert.equal(s.writes, 30);
    assert.equal(s.creates, 30);
    assert.equal(s.edits, 0);
    assert.equal(s.batches, s.thinkPauses + 1);
    totals.push(s.totalMs);
  }
  totals.sort((a, b) => a - b);
  const median = totals[10];
  assert.ok(median >= 8 * MINUTE && median <= 15 * MINUTE, String(median));
  assert.ok(totals[0] >= 5 * MINUTE, `fastest ${formatDuration(totals[0])}`);
  assert.ok(
    totals[totals.length - 1] <= 20 * MINUTE,
    `slowest ${formatDuration(totals[totals.length - 1])}`,
  );
});

test('a shorter median gap shortens the run', () => {
  const slow = summarizeSchedule(planSchedule(fixture30(), { seed: 2 }));
  const quick = summarizeSchedule(
    planSchedule(fixture30(), { seed: 2, medianGapMs: 5 * SECOND }),
  );
  assert.ok(quick.totalMs < slow.totalMs);
});

// ===========================================================================
// PAYLOAD -> ITEMS
// ===========================================================================

test('itemsFromPayload: document order, unchanged skipped, updates kept', () => {
  const payload = payloadFixture();
  payload.state = {
    epic: { key: 'P-1', hash: 'h-epic' },
    stories: {
      '1': {
        key: 'P-2',
        hash: 'old',
        subtasks: { '1.1': { key: 'P-3', hash: 'h-1.1' } },
      },
    },
  };
  const items = itemsFromPayload(payload, { editField: 'labels' });
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.id}:${i.action}`),
    [
      'story:1:update',
      'subtask:1.2:create',
      'story:2:create',
      'subtask:2.1:create',
      'story:3:create',
      'subtask:3.1:create',
      'subtask:3.2:create',
      'subtask:3.3:create',
    ],
  );
  assert.equal(items[0].key, 'P-2');
  assert.equal(items[0].edit, undefined);
  assert.deepEqual(items[1].edit, { field: 'labels' });
  assert.equal(items[1].storyId, '1');

  const all = itemsFromPayload(payload, { includeUnchanged: true });
  assert.equal(all.length, 10);
  assert.equal(all[0].id, 'epic');
});

test('itemsFromPayload without state plans everything as create', () => {
  const payload = payloadFixture();
  delete payload.state;
  const items = itemsFromPayload(payload);
  assert.equal(items.length, 10);
  assert.ok(items.every((i) => i.action === 'create' && !i.edit));
});

// ===========================================================================
// ACTIVITY WINDOW
// ===========================================================================

test('parseHours', () => {
  assert.deepEqual(parseHours('08:00-19:30'), { start: 480, end: 1170 });
  assert.deepEqual(parseHours(['9:00', '17:00']), { start: 540, end: 1020 });
  assert.throws(() => parseHours('19:00-08:00'));
  assert.throws(() => parseHours('nine'));
});

test('activityWindow: open on a weekday inside hours', () => {
  const w = activityWindow(TUESDAY_10, UTC);
  assert.deepEqual(w, { allowed: true, nextAllowed: TUESDAY_10, waitMs: 0 });
});

test('activityWindow: evening waits for 08:00 next day', () => {
  const evening = Date.UTC(2026, 8, 22, 21, 17, 42, 300);
  const w = activityWindow(evening, UTC);
  assert.equal(w.allowed, false);
  assert.equal(new Date(w.nextAllowed).toISOString(), '2026-09-23T08:00:00.000Z');
  assert.equal(w.waitMs, w.nextAllowed - evening);
});

test('activityWindow: early morning waits for 08:00 the same day', () => {
  const dawn = Date.UTC(2026, 8, 22, 6, 30);
  const w = activityWindow(dawn, UTC);
  assert.equal(w.allowed, false);
  assert.equal(new Date(w.nextAllowed).toISOString(), '2026-09-22T08:00:00.000Z');
});

test('activityWindow: 19:30 is closed, 19:29 is open', () => {
  assert.equal(activityWindow(Date.UTC(2026, 8, 22, 19, 30), UTC).allowed, false);
  assert.equal(activityWindow(Date.UTC(2026, 8, 22, 19, 29), UTC).allowed, true);
});

test('activityWindow: weekends skip to Monday unless allowed', () => {
  const saturday = Date.UTC(2026, 8, 26, 11, 0);
  const w = activityWindow(saturday, UTC);
  assert.equal(w.allowed, false);
  assert.equal(new Date(w.nextAllowed).toISOString(), '2026-09-28T08:00:00.000Z');
  assert.equal(activityWindow(saturday, { ...UTC, weekends: true }).allowed, true);
  const fridayNight = Date.UTC(2026, 8, 25, 22, 0);
  assert.equal(
    new Date(activityWindow(fridayNight, UTC).nextAllowed).toISOString(),
    '2026-09-28T08:00:00.000Z',
  );
});

test('activityWindow: custom hours, other zones, and the override', () => {
  const w = activityWindow(TUESDAY_10, { ...UTC, hours: '11:00-12:00' });
  assert.equal(w.allowed, false);
  assert.equal(new Date(w.nextAllowed).toISOString(), '2026-09-22T11:00:00.000Z');
  // 10:00 UTC is 06:00 in New York: closed there, opens 08:00 local.
  const ny = activityWindow(TUESDAY_10, { tz: 'America/New_York' });
  assert.equal(ny.allowed, false);
  assert.equal(new Date(ny.nextAllowed).toISOString(), '2026-09-22T12:00:00.000Z');
  const off = activityWindow(Date.UTC(2026, 8, 26, 3, 0), { ignoreHours: true });
  assert.equal(off.allowed, true);
  assert.equal(activityWindow(new Date(TUESDAY_10), UTC).allowed, true);
});

// ===========================================================================
// RUNNING
// ===========================================================================

test('waitFor sleeps only the remaining time', async () => {
  const clock = virtualClock(1000);
  const entry = { id: 'x', startOffsetMs: 5000 };
  const slept = await waitFor(entry, { ...clock, startedAt: 1000 });
  assert.equal(slept, 5000);
  assert.equal(clock.now(), 6000);
  const again = await waitFor(entry, { ...clock, startedAt: 1000 });
  assert.equal(again, 0);
  assert.equal(clock.now(), 6000);
});

test('runWithCadence executes in schedule order at the planned offsets', async () => {
  const clock = virtualClock(TUESDAY_10);
  const seen = [];
  const res = await runWithCadence(
    fixture30(),
    async (entry) => {
      seen.push(entry.id);
      return entry.id.toUpperCase();
    },
    { seed: 4, ...clock, ...UTC },
  );
  assert.equal(res.ok, true);
  assert.equal(res.remaining.length, 0);
  assert.deepEqual(seen, res.schedule.map((e) => e.id));
  for (const [i, rec] of res.log.entries()) {
    assert.equal(rec.actualOffsetMs, res.schedule[i].startOffsetMs);
    assert.equal(rec.plannedOffsetMs, res.schedule[i].startOffsetMs);
    assert.equal(rec.windowWaitMs, 0);
    assert.equal(rec.result, res.schedule[i].id.toUpperCase());
  }
  const total = summarizeSchedule(res.schedule).totalMs;
  assert.equal(res.finishedAt - res.startedAt, total);
});

test('runWithCadence stops at the first executor error with a partial log', async () => {
  const clock = virtualClock(TUESDAY_10);
  const res = await runWithCadence(
    fixture30(),
    async (entry) => {
      if (entry.id === '2') throw new Error('429 slow down');
      return 'ok';
    },
    { seed: 4, ...clock, ...UTC },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.message, '429 slow down');
  // epic, 1, 1.1-1.4, then 2 fails: 7 records, the last with an error.
  assert.equal(res.log.length, 7);
  assert.equal(res.log.at(-1).id, '2');
  assert.equal(res.log.at(-1).error, '429 slow down');
  assert.equal(res.remaining.length, 23);
  assert.equal(res.remaining[0].id, '2.1');
});

test('runWithCadence waits for the activity window and shifts the base', async () => {
  const evening = Date.UTC(2026, 8, 22, 21, 0);
  const clock = virtualClock(evening);
  const items = [
    { id: 'epic', kind: 'epic' },
    { id: '1', kind: 'story' },
  ];
  const res = await runWithCadence(items, async () => 'ok', {
    seed: 1,
    ...clock,
    ...UTC,
  });
  assert.equal(res.ok, true);
  const open = Date.UTC(2026, 8, 23, 8, 0);
  assert.equal(res.log[0].windowWaitMs, open - evening);
  assert.equal(res.log[0].at, open);
  // The second write keeps its planned gap relative to the first.
  assert.equal(res.log[1].windowWaitMs, 0);
  assert.equal(res.log[1].at - res.log[0].at, res.schedule[1].startOffsetMs);
});

test('runWithCadence honours ignoreHours and a precomputed schedule', async () => {
  const clock = virtualClock(Date.UTC(2026, 8, 26, 3, 0));
  const schedule = planSchedule(fixture30().slice(0, 3), { seed: 2 });
  const res = await runWithCadence([], async () => 'ok', {
    schedule,
    ignoreHours: true,
    ...clock,
  });
  assert.equal(res.ok, true);
  assert.equal(res.log.length, 3);
  assert.ok(res.log.every((r) => r.windowWaitMs === 0));
});

// ===========================================================================
// FORBIDDEN LANGUAGE
// ===========================================================================

test('forbiddenLanguage catches the contract and voice rules', () => {
  const rules = (t) => forbiddenLanguage(t).map((h) => h.rule);
  assert.deepEqual(rules('Consider adding a check.'), ['vague']);
  assert.deepEqual(rules('the agent did it'), ['contract-ban']);
  assert.deepEqual(rules('Done! Ship it'), ['exclamation']);
  assert.deepEqual(rules('Fixed the typo \u2014 sorry'), ['em-dash']);
  assert.deepEqual(rules('Shipped it \u{1F680}'), ['emoji']);
  assert.deepEqual(rules('see docs/plan/foo.md'), ['md-link']);
  assert.deepEqual(rules('ran the script automatically'), [
    'automation-tell',
    'automation-tell',
  ]);
  assert.deepEqual(rules('fill in <PLACEHOLDER> later'), ['placeholder']);
  assert.deepEqual(rules('As an AI, I think'), ['ai-tell', 'contract-ban']);
  assert.ok(passesForbidden("Updated the AC, didn't touch the rest."));
  assert.ok(passesForbidden('Delegate to the billing service.'));
  assert.ok(passesForbidden(''));
});

// ===========================================================================
// VARY
// ===========================================================================

test('every vary kind has at least eight distinct clean variants', () => {
  assert.deepEqual(varyKinds(), [
    'comment-opener',
    'edit-reason',
    'moved-to-backlog',
    'verifier-remark',
  ]);
  for (const kind of varyKinds()) {
    const variants = varyVariants(kind);
    assert.ok(variants.length >= 8, `${kind} has ${variants.length}`);
    assert.equal(new Set(variants).size, variants.length, `${kind} dupes`);
    for (const v of variants) {
      const filled = v.replace('{field}', 'labels');
      assert.deepEqual(forbiddenLanguage(filled), [], `${kind}: ${v}`);
      assert.ok(!/!/.test(v) && !/\u2014/.test(v), v);
      assert.ok(!/\p{Extended_Pictographic}/u.test(v), v);
      assert.ok(v.length <= 80, v);
    }
    assert.ok(variants.some((v) => /^[a-z]/.test(v)), `${kind} lowercase`);
    assert.ok(variants.some((v) => /\w'\w/.test(v)), `${kind} contraction`);
  }
  assert.throws(() => varyVariants('nope'), /unknown vary kind/);
});

test('vary never repeats the previous string for a kind', () => {
  const v = createVary({ seed: 3 });
  for (const kind of varyKinds()) {
    const recent = [];
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) {
      const s = v(kind);
      assert.ok(!recent.includes(s), `${kind} repeated "${s}" within 3`);
      recent.push(s);
      if (recent.length > 3) recent.shift();
      seen.add(s);
    }
    assert.equal(seen.size, varyVariants(kind).length, `${kind} coverage`);
  }
  // Rotation state is per kind: alternating kinds does not reset it.
  const w = createVary({ seed: 8 });
  const first = w('comment-opener');
  w('edit-reason');
  assert.notEqual(w('comment-opener'), first);
});

test('vary fills {field} from ctx and is seed-deterministic', () => {
  const a = createVary({ seed: 21 });
  const b = createVary({ seed: 21 });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(a('edit-reason', { field: 'labels' }), b('edit-reason', { field: 'labels' }));
  }
  const withField = createVary({ seed: 1 })('edit-reason', { field: 'labels' });
  assert.ok(withField.includes('labels'), withField);
  const defaulted = createVary({ seed: 1 })('edit-reason');
  assert.ok(defaulted.includes('summary'), defaulted);
  assert.ok(!/\{\w+\}/.test(defaulted));
  // The shared instance works and is clean.
  const shared = vary('verifier-remark');
  assert.ok(passesForbidden(shared));
});

// ===========================================================================
// CLI
// ===========================================================================

test('parseArgs', () => {
  assert.deepEqual(
    parseArgs(['plan', 'p.json', '--seed', '7', '--fast', '--json']),
    { command: 'plan', positional: ['p.json'], seed: '7', fast: true, json: true },
  );
  assert.deepEqual(parseArgs(['window', '--ignore-hours']), {
    command: 'window',
    positional: [],
    ignore_hours: true,
  });
});

function withTempPayload(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-'));
  const file = path.join(dir, 'payload.json');
  fs.writeFileSync(file, JSON.stringify(payloadFixture()));
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function capture(argv, io = {}) {
  let stdout = '';
  let stderr = '';
  const code = runCli(argv, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    ...io,
  });
  return { code, stdout, stderr };
}

test('cli plan prints a table with total and honours --seed/--json', () => {
  withTempPayload((file) => {
    const table = capture(['plan', file, '--seed', '5']);
    assert.equal(table.code, 0);
    assert.match(table.stdout, /^id\s+kind\s+action\s+offset\s+batch/);
    assert.match(table.stdout, /^epic\s+epic\s+create\s+\+0:00\s+1$/m);
    assert.match(table.stdout, /total: 10 writes \(10 creates, 0 updates, 0 edits\)/);
    assert.match(table.stdout, /seed 5$/m);

    const json = capture(['plan', file, '--seed', '5', '--json']);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.seed, 5);
    assert.equal(parsed.writes, 10);
    assert.equal(parsed.schedule.length, 10);
    // CLI --seed 5 equals the API with seed 5.
    const api = planSchedule(itemsFromPayload(payloadFixture()), { seed: 5 });
    assert.deepEqual(parsed.schedule, api);
    assert.equal(parsed.totalMs, summarizeSchedule(api).totalMs);

    const fast = capture(['plan', file, '--fast', '--json']);
    assert.equal(JSON.parse(fast.stdout).totalMs, 0);

    const gap = capture(['plan', file, '--seed', '5', '--median-gap', '4s', '--json']);
    assert.ok(JSON.parse(gap.stdout).totalMs < parsed.totalMs);

    const edits = capture(['plan', file, '--seed', '3', '--edit-field', 'labels', '--json']);
    const withEdits = JSON.parse(edits.stdout);
    assert.ok(withEdits.schedule.every((e) => e.action !== 'edit' || e.field === 'labels'));
  });
});

test('cli plan rejects a missing payload', () => {
  const r = capture(['plan', '/nonexistent/payload.json']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /plan <payload.json>/);
});

test('cli vary prints n distinct lines and rejects unknown kinds', () => {
  const r = capture(['vary', 'comment-opener', '--n', '5', '--seed', '2']);
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 5);
  for (let i = 1; i < lines.length; i += 1) assert.notEqual(lines[i], lines[i - 1]);
  for (const l of lines) assert.ok(passesForbidden(l), l);
  const bad = capture(['vary', 'nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown vary kind/);
  const none = capture(['vary']);
  assert.equal(none.code, 1);
});

test('cli window reports open/closed with exit codes 0/3', () => {
  const open = capture(['window', '--tz', 'UTC'], { now: () => TUESDAY_10 });
  assert.equal(open.code, 0);
  assert.equal(open.stdout, 'open\n');
  const closed = capture(['window', '--tz', 'UTC'], {
    now: () => Date.UTC(2026, 8, 22, 21, 0),
  });
  assert.equal(closed.code, 3);
  assert.match(closed.stdout, /^closed until 2026-09-23T08:00:00.000Z \(wait 11h 0m 0s\)/);
  const forced = capture(['window', '--ignore-hours'], {
    now: () => Date.UTC(2026, 8, 26, 3, 0),
  });
  assert.equal(forced.code, 0);
  const weekend = capture(['window', '--tz', 'UTC', '--weekends', '--hours', '02:00-04:00'], {
    now: () => Date.UTC(2026, 8, 26, 3, 0),
  });
  assert.equal(weekend.code, 0);
});

test('cli wait sleeps to start+offset, then to the window', async () => {
  const clock = virtualClock(TUESDAY_10);
  let stdout = '';
  const io = { ...clock, stdout: (s) => (stdout += s) };
  const start = new Date(TUESDAY_10 - 5000).toISOString();
  const code = await runCli(
    ['wait', '--start', start, '--offset', '12s', '--tz', 'UTC'],
    io,
  );
  assert.equal(code, 0);
  assert.deepEqual(clock.slept, [7000]);
  assert.equal(stdout, 'waited 7s\n');

  // Already past the offset: no sleep, but the window still applies.
  const late = virtualClock(Date.UTC(2026, 8, 22, 21, 0));
  stdout = '';
  const code2 = await runCli(
    [
      'wait',
      '--start',
      String(late.now() - 60_000),
      '--offset',
      '3s',
      '--tz',
      'UTC',
    ],
    { ...late, stdout: (s) => (stdout += s) },
  );
  assert.equal(code2, 0);
  assert.match(stdout, /window closed, waiting/);
  assert.equal(late.now(), Date.UTC(2026, 8, 23, 8, 0));

  stdout = '';
  const code3 = await runCli(
    ['wait', '--start', String(late.now()), '--offset', '2s', '--ignore-hours'],
    { ...late, stdout: (s) => (stdout += s) },
  );
  assert.equal(code3, 0);
  assert.equal(stdout, 'waited 2s\n');

  let stderr = '';
  const bad = await runCli(['wait', '--offset', '2s'], {
    stderr: (s) => (stderr += s),
  });
  assert.equal(bad, 1);
  assert.match(stderr, /--start/);
});

test('cli check flags banned text and passes clean text', () => {
  const bad = capture(['check', 'Consider it done!']);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /vague: "Consider"/);
  assert.match(bad.stdout, /exclamation: "!"/);
  assert.match(bad.stdout, /2 problem\(s\)/);
  const good = capture(['check', "Updated the AC, didn't touch anything else."]);
  assert.equal(good.code, 0);
  assert.equal(good.stdout, 'ok\n');
  const stdin = capture(['check', '-'], { stdin: () => 'the bot posted this' });
  assert.equal(stdin.code, 1);
  assert.match(stdin.stdout, /automation-tell: "bot"/);
});

test('cli usage on unknown command', () => {
  const r = capture(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: human-cadence.mjs plan/);
});

test('cli runs as a process', () => {
  const out = execFileSync(process.execPath, [SCRIPT, 'vary', 'verifier-remark', '--n', '2'], {
    encoding: 'utf8',
  });
  assert.equal(out.trimEnd().split('\n').length, 2);
  withTempPayload((file) => {
    const table = execFileSync(process.execPath, [SCRIPT, 'plan', file, '--seed', '1'], {
      encoding: 'utf8',
    });
    assert.match(table, /total: 10 writes/);
  });
});
