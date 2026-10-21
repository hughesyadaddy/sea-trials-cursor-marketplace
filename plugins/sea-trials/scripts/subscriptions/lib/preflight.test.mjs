/**
 * Test subscription parsing and environment handling with injected fake exec.
 * Never invoke real CLIs or read credential files during these checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkClaude,
  checkCodex,
  sanitizedEnv,
  findExecutable,
} from './preflight.mjs';

const TEST_ENV = { HOME: '/nonexistent', PATH: '' };
const AUTH_STATES = [
  'subscription',
  'api-key',
  'logged-out',
  'missing',
  'malformed',
];

test('sanitization copies env without API credentials', () => {
  const env = {
    PATH: '/bin',
    OPENAI_API_KEY: 'secret',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret',
  };
  assert.deepEqual(sanitizedEnv(env), { PATH: '/bin' });
  assert.equal(env.OPENAI_API_KEY, 'secret');
});

for (const tool of ['claude', 'codex']) {
  for (const state of AUTH_STATES) {
    test(`${tool}: ${state}`, () => {
      const exec = (cmd, args, { env }) => {
        assert.equal(env.OPENAI_API_KEY, undefined);
        assert.equal(env.ANTHROPIC_API_KEY, undefined);
        assert.deepEqual(
          args,
          tool === 'claude'
            ? ['auth', 'status', '--json']
            : ['login', 'status'],
        );
        let stdout;
        if (state === 'malformed') {
          stdout = 'bad JSON';
        } else if (tool === 'claude') {
          stdout = JSON.stringify({
            loggedIn: state !== 'logged-out',
            authMethod: state === 'subscription' ? 'claude.ai' : 'api-key',
            email: 'private@example.com',
          });
        } else {
          stdout = state === 'subscription'
            ? 'Logged in using ChatGPT\n'
            : 'Logged in using an API key';
        }
        return {
          status: state === 'logged-out' ? 1 : 0,
          error: state === 'missing' ? { code: 'ENOENT' } : undefined,
          stdout,
        };
      };
      const check = tool === 'claude' ? checkClaude : checkCodex;
      const result = check({
        exec,
        env: {
          ...TEST_ENV,
          OPENAI_API_KEY: 'secret',
          ANTHROPIC_API_KEY: 'secret',
        },
      });
      assert.equal(result.ready, state === 'subscription');
      assert.equal(result.installed, state !== 'missing');
      assert.match(result.message, /ignored by the Sea Trials launcher/);
      assert.doesNotMatch(JSON.stringify(result), /private@example|secret/);
      if (!result.ready) {
        assert.match(
          result.message,
          state === 'missing' ? /https:/ : /run `.*login`/,
        );
      }
    });
  }
}

test('Dock PATH fallback finds local installation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-path-'));
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    const file = path.join(home, '.local/bin/claude');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(findExecutable('claude', { HOME: home, PATH: '' }), file);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex subscription status on stderr and nonzero status', () => {
  for (const status of [0, 1]) {
    const result = checkCodex({
      env: TEST_ENV,
      exec: () => ({
        status,
        stdout: '',
        stderr: 'Logged in using ChatGPT\n',
      }),
    });
    assert.equal(result.ready, status === 0);
  }
});

test('Claude provider and logged-out states fail closed', () => {
  for (const auth of [
    { loggedIn: false, authMethod: 'claude.ai' },
    { loggedIn: true, authMethod: 'console' },
    { loggedIn: true, authMethod: 'bedrock' },
    { loggedIn: true, authMethod: 'vertex' },
  ]) {
    const result = checkClaude({
      env: TEST_ENV,
      exec: () => ({ status: 0, stdout: JSON.stringify(auth) }),
    });
    assert.equal(result.ready, false);
  }
});

test('Claude API key is ignored without leaking its value', () => {
  const key = 'private-test-api-key';
  const result = checkClaude({
    env: { ...TEST_ENV, ANTHROPIC_API_KEY: key },
    exec: (cmd, args, { env }) => {
      assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false);
      return {
        status: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      };
    },
  });
  assert.equal(result.ready, true);
  assert.match(result.message, /ignored by the Sea Trials launcher/);
  assert.equal(JSON.stringify(result).includes(key), false);
});
