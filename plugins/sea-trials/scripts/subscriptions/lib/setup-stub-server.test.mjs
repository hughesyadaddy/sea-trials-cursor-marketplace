/**
 * Exercise the setup stub over stdio, including protocol errors.
 * The child receives complete request lines and exits when stdin ends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STUB_PATH = fileURLToPath(
  new URL('./setup-stub-server.mjs', import.meta.url),
);
const MCP_TIMEOUT_MS = 5000;

/**
 * Send raw lines so malformed JSON can be tested alongside valid requests.
 *
 * @param {string[]} lines
 * @returns {Promise<object[]>}
 */
function roundTrip(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STUB_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP timeout'));
    }, MCP_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr));
      } else {
        resolve(stdout.trim().split('\n').map(JSON.parse));
      }
    });
    child.stdin.end(lines.join('\n') + '\n');
  });
}

test('setup stub round trip', async () => {
  const requests = [
    {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 'test-version' },
    },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    {
      id: 3,
      method: 'tools/call',
      params: { name: 'subscription_setup_status' },
    },
    { id: 4, method: 'missing' },
    { id: 5, method: 'ping' },
  ];
  const responses = await roundTrip(requests.map(
    (request) => JSON.stringify({ jsonrpc: '2.0', ...request }),
  ));
  assert.equal(responses.length, 5);
  assert.equal(responses[0].result.protocolVersion, 'test-version');
  assert.equal(responses[1].result.tools[0].name, 'subscription_setup_status');
  assert.match(responses[2].result.content[0].text, /own Pro\/Max/);
  assert.equal(responses[3].error.code, -32601);
  assert.deepEqual(responses[4].result, {});
});

test('setup stub reports parse errors and unknown tools', async () => {
  const responses = await roundTrip([
    '{invalid JSON',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'unknown_tool' },
    }),
  ]);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].id, 1);
  assert.equal(responses[1].error.code, -32602);
});
