import assert from 'node:assert/strict';
import test from 'node:test';

import { backgroundSpawn, failFastDefault } from './parallel.mjs';

const existsYes = () => true;
const existsNo = () => false;

test('backgroundSpawn wraps with taskpolicy -b on macOS when available', () => {
  const r = backgroundSpawn({
    platform: 'darwin',
    executable: 'dart',
    args: ['analyze', '--fatal-infos', 'lib/a.dart'],
    env: {},
    exists: existsYes,
  });
  assert.equal(r.wrapped, true);
  assert.equal(r.executable, '/usr/sbin/taskpolicy');
  // taskpolicy EXECs the target, so the real tool + its args follow -b.
  assert.deepEqual(r.args, ['-b', 'dart', 'analyze', '--fatal-infos', 'lib/a.dart']);
});

test('backgroundSpawn is a no-op when taskpolicy is absent', () => {
  const r = backgroundSpawn({
    platform: 'darwin',
    executable: 'dart',
    args: ['analyze'],
    env: {},
    exists: existsNo,
  });
  assert.equal(r.wrapped, false);
  assert.equal(r.executable, 'dart');
  assert.deepEqual(r.args, ['analyze']);
});

test('backgroundSpawn is a no-op on non-darwin platforms', () => {
  for (const platform of ['linux', 'win32']) {
    const r = backgroundSpawn({
      platform,
      executable: 'dart',
      args: ['analyze'],
      env: {},
      exists: existsYes,
    });
    assert.equal(r.wrapped, false, platform);
    assert.equal(r.executable, 'dart');
  }
});

test('backgroundSpawn respects ST_GATE_BACKGROUND_QOS=0 and CI', () => {
  const off = backgroundSpawn({
    platform: 'darwin',
    executable: 'dart',
    args: [],
    env: { ST_GATE_BACKGROUND_QOS: '0' },
    exists: existsYes,
  });
  assert.equal(off.wrapped, false);

  const ci = backgroundSpawn({
    platform: 'darwin',
    executable: 'dart',
    args: [],
    env: { CI: 'true' },
    exists: existsYes,
  });
  assert.equal(ci.wrapped, false);

  // CI explicitly unset/false does not disable it.
  const ciFalse = backgroundSpawn({
    platform: 'darwin',
    executable: 'dart',
    args: [],
    env: { CI: 'false' },
    exists: existsYes,
  });
  assert.equal(ciFalse.wrapped, true);
});

test('failFastDefault honours ST_GATE_FAIL_FAST', () => {
  assert.equal(failFastDefault({}), true);
  assert.equal(failFastDefault({ ST_GATE_FAIL_FAST: '0' }), false);
  assert.equal(failFastDefault({ ST_GATE_FAIL_FAST: 'false' }), false);
  assert.equal(failFastDefault({ ST_GATE_FAIL_FAST: '1' }), true);
});
