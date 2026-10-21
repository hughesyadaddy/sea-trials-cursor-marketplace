/**
 * Verify preflight CLI output with fake tools and isolated installation paths.
 * No real subscription CLI or credential file is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(
  new URL('./st-subscriptions-preflight.mjs', import.meta.url),
);
const CLI_TIMEOUT_MS = 5000;

test('help exits successfully without checking installed tools', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    env: { HOME: '/nonexistent', PATH: '' },
    timeout: CLI_TIMEOUT_MS,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stdout, /Next step:/);
});

test('unready CLI prints aligned columns and next steps, or pure JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-preflight-cli-'));
  try {
    for (const tool of ['claude', 'codex']) {
      fs.writeFileSync(path.join(home, tool), `#!${process.execPath}
process.stdout.write('{"loggedIn":false}');
`, { mode: 0o755 });
    }
    const options = {
      encoding: 'utf8',
      env: { HOME: home, PATH: home },
      timeout: CLI_TIMEOUT_MS,
    };
    const human = spawnSync(process.execPath, [CLI_PATH], options);
    assert.equal(human.status, 1);
    assert.match(human.stdout, /^Tool    Ready  Setup\n/m);
    assert.match(human.stdout, /^claude  no     /m);
    assert.match(human.stdout, /^codex   no     /m);
    assert.match(human.stdout, /Next step:.*claude auth login/);
    const machine = spawnSync(
      process.execPath,
      [CLI_PATH, '--json'],
      options,
    );
    assert.equal(machine.status, 1);
    const results = JSON.parse(machine.stdout);
    assert.equal(results.length, 2);
    assert.equal(results.every((result) => !result.ready), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
