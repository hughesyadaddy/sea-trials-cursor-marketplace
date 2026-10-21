#!/usr/bin/env node
/**
 * Cursor stdio entry for the official Claude Code subscription MCP server.
 *
 * Strip API credentials, verify subscription auth, and keep Fast off. Missing
 * setup or an explicit opt-out serves a setup stub so Cursor loads cleanly.
 * Forward termination signals and propagate the real server's exit status.
 */
import { spawn, spawnSync } from 'node:child_process';
import { checkClaude, sanitizedEnv, findExecutable } from './lib/preflight.mjs';
import { serveSetupStub } from './lib/setup-stub-server.mjs';

const PREFLIGHT_TIMEOUT_MS = 15000;
const SETUP_STEPS = '\nInstall Claude Code, sign in with your own '
  + 'subscription, run st-subscriptions-preflight, then reload Cursor '
  + 'and check its MCP panel.';
const START_ERROR = 'Unable to start Claude Code; check installation and PATH.';
const env = sanitizedEnv(process.env);

if (env.ST_SUBSCRIPTION_MCP === '0') {
  serveSetupStub(
    'Subscription MCP is disabled (ST_SUBSCRIPTION_MCP=0).' + SETUP_STEPS,
  );
} else {
  const result = checkClaude({
    exec: (cmd, args, options) => spawnSync(cmd, args, {
      ...options,
      encoding: 'utf8',
      timeout: PREFLIGHT_TIMEOUT_MS,
    }),
    env: process.env,
  });
  if (!result.ready) {
    console.error(result.message);
    serveSetupStub(result.message + SETUP_STEPS);
  } else {
    if (result.message.includes('ignored')) {
      console.error(result.message);
    }
    const child = spawn(
      findExecutable('claude', env) || 'claude',
      ['--settings', '{"fastMode":false}', 'mcp', 'serve'],
      { stdio: 'inherit', env },
    );
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => child.kill(signal));
    }
    child.on('error', () => {
      console.error(START_ERROR);
      serveSetupStub(START_ERROR + SETUP_STEPS);
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
    });
  }
}
