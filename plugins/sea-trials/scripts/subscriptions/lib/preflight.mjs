/**
 * Read-only subscription checks for the official Claude Code and Codex CLIs.
 *
 * Exec and environment are injected so checks can be tested without running
 * installed CLIs. Child processes never receive API billing credentials.
 * Results contain setup instructions, never raw auth output or account fields.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API_KEY_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];
const CLAUDE_INSTALL_URL = 'https://code.claude.com/docs/en/setup';
const CODEX_INSTALL_URL = 'https://developers.openai.com/codex/cli';

/**
 * Copy the environment without API billing credentials.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizedEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !API_KEY_ENV_VARS.includes(key)),
  );
}

/**
 * Resolve CLI installations even with a Dock-launched host's minimal PATH.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
export function findExecutable(name, env) {
  const home = env.HOME || os.homedir();
  const dirs = [
    ...(env.PATH || '').split(path.delimiter),
    path.join(home, '.local/bin'),
    path.join(home, '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next directory.
    }
  }
  return null;
}

/**
 * @typedef {object} CheckOptions
 * @property {function(string, string[], {env: NodeJS.ProcessEnv}): {
 *   status: number|null, stdout?: string, stderr?: string, error?: Error
 * }} exec
 * @property {NodeJS.ProcessEnv} env
 *
 * @typedef {object} CheckResult
 * @property {string} tool
 * @property {boolean} installed
 * @property {boolean} ready
 * @property {string} method
 * @property {string} message
 */

/**
 * Check one official CLI using an injected synchronous exec function.
 *
 * @param {'claude'|'codex'} tool
 * @param {CheckOptions} options
 * @returns {CheckResult}
 */
function check(tool, { exec, env }) {
  const clean = sanitizedEnv(env);
  const args = tool === 'claude'
    ? ['auth', 'status', '--json']
    : ['login', 'status'];
  const result = exec(findExecutable(tool, clean) || tool, args, {
    env: clean,
  });
  const installed = result.error?.code !== 'ENOENT';
  let ready = false;
  if (installed && !result.error && result.status === 0) {
    if (tool === 'claude') {
      try {
        const auth = JSON.parse(result.stdout);
        ready = auth.loggedIn === true && auth.authMethod === 'claude.ai';
      } catch {
        // Malformed output is not proof of subscription auth.
      }
    } else {
      ready = [result.stdout, result.stderr].some(
        (output) => String(output ?? '').trim() === 'Logged in using ChatGPT',
      );
    }
  }
  const install = tool === 'claude' ? CLAUDE_INSTALL_URL : CODEX_INSTALL_URL;
  const fix = tool === 'claude'
    ? 'run `claude auth login` and sign in with your own '
      + 'Claude Pro/Max subscription'
    : 'run `codex login` and choose Sign in with ChatGPT '
      + '(your own Plus/Pro/Business plan)';
  let message;
  if (!installed) {
    message = `Install ${tool}: ${install}`;
  } else if (ready) {
    message = 'Subscription login ready.';
  } else {
    message = fix;
  }
  if (API_KEY_ENV_VARS.some((key) => env[key])) {
    message += ' API-key environment variables ignored by the '
      + 'Sea Trials launcher.';
  }
  const method = ready
    ? (tool === 'claude' ? 'claude.ai' : 'chatgpt')
    : 'not-subscription';
  return { tool, installed, ready, method, message };
}

/**
 * Inspect Claude Code subscription status.
 *
 * @param {CheckOptions} options
 * @returns {CheckResult}
 */
export function checkClaude(options) {
  return check('claude', options);
}

/**
 * Inspect Codex subscription status.
 *
 * @param {CheckOptions} options
 * @returns {CheckResult}
 */
export function checkCodex(options) {
  return check('codex', options);
}
