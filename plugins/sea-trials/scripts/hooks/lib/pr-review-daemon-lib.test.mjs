import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  acquirePidLock,
  classifyMonitorState,
  createDedupEmitter,
  formatStatusDetail,
  releasePidLock,
} from './pr-review-daemon-lib.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-daemon-lib-'));
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('classifyMonitorState: CI fail beats threads', () => {
  const snap = {
    threads: { unresolvedCount: 3, unresolvedBotCount: 2 },
    ci: { hasFailure: true, hasPending: false },
  };
  const r = classifyMonitorState(snap, 'REVIEWING');
  assert.equal(r.reason, 'ci-fail');
  assert.equal(r.kind, 'ACTION');
});

test('classifyMonitorState: open threads are ACTION immediately', () => {
  const snap = {
    threads: { unresolvedCount: 2, unresolvedBotCount: 2 },
    ci: { hasFailure: false, hasPending: true },
  };
  const r = classifyMonitorState(snap, 'AWAITING_ACK');
  assert.equal(r.reason, 'threads');
});

test('formatStatusDetail uses serialized ci snapshot shape', () => {
  const snap = {
    threads: { unresolvedCount: 0, unresolvedBotCount: 0 },
    ci: {
      total: 21,
      pending: ['dart-analyze-guards', 'ci-script-tests'],
      failed: [{ name: 'dart-test', link: 'https://example.com' }],
    },
  };
  const line = formatStatusDetail(snap, 'AWAITING_ACK');
  assert.match(line, /pass=18/);
  assert.match(line, /pending=2/);
  assert.match(line, /fail=1/);
  assert.match(line, /settled=AWAITING_ACK/);
});

test('classifyMonitorState: green when clear', () => {
  const snap = {
    threads: { unresolvedCount: 0, unresolvedBotCount: 0 },
    ci: { hasFailure: false, hasPending: false },
  };
  const r = classifyMonitorState(snap, 'DONE');
  assert.equal(r.kind, 'GREEN');
});

test('createDedupEmitter dedupes identical lines', () => {
  const signal = path.join(tmp, 'sig.txt');
  const last = path.join(tmp, 'last.txt');
  const lines = [];
  const emitter = createDedupEmitter({
    signalFile: signal,
    monitorLastFile: last,
    log: (l) => lines.push(l),
  });
  assert.equal(emitter.emit('WAIT', 'a'), true);
  assert.equal(emitter.emit('WAIT', 'a'), false);
  assert.equal(lines.length, 1);
});

test('acquirePidLock refuses live pid', () => {
  const pidFile = path.join(tmp, 'live.pid');
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  const lock = acquirePidLock(pidFile);
  assert.equal(lock.ok, false);
  releasePidLock(pidFile);
});
