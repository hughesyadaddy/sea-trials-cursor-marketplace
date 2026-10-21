/**
 * Exercise the launcher with temporary fake Claude executables only.
 * Verify setup fallback, Fast-off arguments, and credential sanitization.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const MCP_TIMEOUT_MS = 5000;

/**
 * Exchange newline-delimited requests with a child within a bounded timeout.
 *
 * @param {string} file
 * @param {NodeJS.ProcessEnv} env
 * @param {object[]} requests
 * @returns {Promise<object[]>}
 */
function roundTrip(file, env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env,
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
    const lines = requests.map(
      (request) => JSON.stringify({ jsonrpc: '2.0', ...request }),
    );
    child.stdin.end(lines.join('\n') + '\n');
  });
}

for (const ready of [false, true]) {
  test(`launcher with fake Claude: ready=${ready}`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mcp-'));
    try {
      const record = path.join(home, 'record.json');
      const fake = path.join(home, 'claude');
      fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'auth') {
  console.log(JSON.stringify({
    loggedIn: ${ready},
    authMethod: 'claude.ai',
  }));
} else {
  fs.writeFileSync(process.env.ST_TEST_RECORD, JSON.stringify({
    args: process.argv.slice(2),
    hasKey: 'ANTHROPIC_API_KEY' in process.env,
  }));
  console.log(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: 'fake' },
  }));
  process.stdin.resume();
}
`, { mode: 0o755 });
      const responses = await roundTrip(
        path.join(root, 'claude-code-mcp.mjs'),
        {
          HOME: home,
          PATH: home,
          ANTHROPIC_API_KEY: 'never-forward',
          ST_TEST_RECORD: record,
        },
        [{ id: 1, method: ready ? 'initialize' : 'tools/list' }],
      );
      if (ready) {
        assert.equal(responses[0].result.protocolVersion, 'fake');
        assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), {
          args: ['--settings', '{"fastMode":false}', 'mcp', 'serve'],
          hasKey: false,
        });
      } else {
        assert.equal(
          responses[0].result.tools[0].name,
          'subscription_setup_status',
        );
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
