#!/usr/bin/env node
/**
 * Cost-policy guard — keep coding on local subscriptions, off the cloud.
 *
 * Alex's cost policy (Oct 2026): no Cursor cloud agents, no *-fast models;
 * code locally via /st-code-via-subscriptions (Claude Code / Codex on the
 * user's own subscription), falling back to Cursor composer-2.5 standard.
 *
 * Decisions, per command segment (quotes stripped; `sh -c "…"` re-scanned):
 *   cursor-agent/agent --model …-fast   DENY (use composer-2.5, Fast off)
 *   api.cursor.com/v0|v1/agents          DENY (Cursor cloud/background agents)
 *   …/background-agents                  DENY
 *   codex cloud exec                     DENY (run Codex locally)
 *   claude --cloud                       DENY (run Claude Code locally)
 *
 * Override: ST_ALLOW_CLOUD=1 (hook env, or a `ST_ALLOW_CLOUD=1` assignment
 * in the approved command text). When overridden the guard allows but
 * prints what it would have blocked and that the override is active.
 *
 * Same stdin/stdout contract as guard-git-push.mjs for Cursor and Claude
 * Code; it reuses that module's host detection, command extraction and
 * rendering.
 *
 * Try it:
 *   echo '{"command":"cursor-agent --model composer-2.5-fast run"}' \
 *     | node hooks/scripts/guard-cost-policy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectHost, extractCommand, render, splitSegments } from './guard-git-push.mjs';

export const LOCAL_FALLBACK =
  'Code locally via /st-code-via-subscriptions (Claude Code / Codex on '
  + 'your subscription); fall back to Cursor composer-2.5 standard (Fast off).';

export const OVERRIDE_HINT =
  ' Override with ST_ALLOW_CLOUD=1 only if the user explicitly asked for '
  + 'this cloud job.';

export const COST_MESSAGES = {
  fastModel:
    'Sea Trials cost policy (Oct 2026): never pass a *-fast model to '
    + 'cursor-agent/agent. Use composer-2.5 standard (Fast off).',
  cursorCloud:
    'Sea Trials cost policy (Oct 2026): the Cursor cloud / background '
    + `agents API is blocked. ${LOCAL_FALLBACK}`,
  codexCloud:
    'Sea Trials cost policy (Oct 2026): `codex cloud exec` is blocked. '
    + `${LOCAL_FALLBACK}`,
  claudeCloud:
    'Sea Trials cost policy (Oct 2026): `claude --cloud` is blocked. '
    + `${LOCAL_FALLBACK}`,
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = /^(ba|z|da|k)?sh$/;

/**
 * @param {string} token
 * @returns {string} executable basename without `.exe`
 */
function baseName(token) {
  return path.basename(String(token).replace(/\\/g, '/')).replace(/\.exe$/i, '');
}

/**
 * Every command segment in `command`, re-scanning `sh -c "…"` / `eval "…"`
 * payloads so nested invocations are seen too.
 *
 * @param {string} command
 * @param {number} [depth]
 * @returns {string[][]}
 */
export function collectSegments(command, depth = 0) {
  /** @type {string[][]} */
  const out = [];
  if (depth > 3) return out;
  for (const words of splitSegments(command ?? '')) {
    out.push(words);
    for (let i = 0; i < words.length - 1; i += 1) {
      const exe = baseName(words[i]);
      if (SHELLS.test(exe) && words[i + 1] === '-c' && words[i + 2] !== undefined) {
        out.push(...collectSegments(words[i + 2], depth + 1));
      }
      if (exe === 'eval') {
        out.push(...collectSegments(words.slice(i + 1).join(' '), depth + 1));
        break;
      }
    }
  }
  return out;
}

/**
 * Drop leading `FOO=1` env assignments so the executable is `words[0]`.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function stripEnv(words) {
  let i = 0;
  while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i += 1;
  return words.slice(i);
}

/**
 * True when a segment invokes cursor-agent/agent with a `*-fast` model.
 *
 * @param {string[]} words segment with env prefixes stripped
 * @returns {boolean}
 */
export function fastModelInAgentCall(words) {
  if (words.length === 0) return false;
  const exe = baseName(words[0]);
  if (exe !== 'agent' && exe !== 'cursor-agent') return false;
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    let value = null;
    if (w === '--model' || w === '-m' || w === '--model-name') value = words[i + 1];
    else if (w.startsWith('--model=')) value = w.slice('--model='.length);
    else if (w.startsWith('-m=')) value = w.slice('-m='.length);
    if (value && /-fast\b/.test(value)) return true;
  }
  return false;
}

/**
 * @param {string[]} words segment with env prefixes stripped
 * @returns {boolean} true for `codex cloud exec …`
 */
export function isCodexCloudExec(words) {
  return baseName(words[0] ?? '') === 'codex'
    && words[1] === 'cloud'
    && words[2] === 'exec';
}

/**
 * @param {string[]} words segment with env prefixes stripped
 * @returns {boolean} true for `claude --cloud …`
 */
export function isClaudeCloud(words) {
  if (baseName(words[0] ?? '') !== 'claude') return false;
  return words.slice(1).some((w) => w === '--cloud' || w.startsWith('--cloud='));
}

/**
 * @param {string} command
 * @returns {boolean} true when the command hits the Cursor cloud agents API
 */
export function hitsCursorCloudApi(command) {
  if (!/api\.cursor\.com/i.test(command)) return false;
  return /\/v[01]\/agents\b/i.test(command) || /background-agents\b/i.test(command);
}

/**
 * Every distinct cost-policy violation in a command.
 *
 * @param {string} command
 * @returns {Array<{ code: string, message: string }>}
 */
export function detectViolations(command) {
  const cmd = command ?? '';
  /** @type {Map<string, string>} */
  const found = new Map();
  if (hitsCursorCloudApi(cmd)) found.set('cursorCloud', COST_MESSAGES.cursorCloud);
  for (const words of collectSegments(cmd)) {
    const stripped = stripEnv(words);
    if (stripped.length === 0) continue;
    if (fastModelInAgentCall(stripped)) found.set('fastModel', COST_MESSAGES.fastModel);
    if (isCodexCloudExec(stripped)) found.set('codexCloud', COST_MESSAGES.codexCloud);
    if (isClaudeCloud(stripped)) found.set('claudeCloud', COST_MESSAGES.claudeCloud);
  }
  return [...found].map(([code, message]) => ({ code, message }));
}

/**
 * ST_ALLOW_CLOUD=1 in the hook env, or a `ST_ALLOW_CLOUD=1` assignment in
 * the approved command text (the hook does not inherit the agent shell).
 *
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function overrideActive(command, env) {
  if ((env.ST_ALLOW_CLOUD ?? '').trim() === '1') return true;
  return /(^|\s)ST_ALLOW_CLOUD=1(\s|$)/.test(command ?? '');
}

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ permission: 'allow' | 'deny', message?: string, note?: string }}
 */
export function decideCost(command, env = process.env) {
  const violations = detectViolations(command);
  if (violations.length === 0) return { permission: 'allow' };
  const reason = violations.map((v) => v.message).join(' ');
  if (overrideActive(command, env)) {
    return {
      permission: 'allow',
      note: `Sea Trials cost guard: ST_ALLOW_CLOUD=1 — allowing despite: ${reason}`,
    };
  }
  return { permission: 'deny', message: `${reason}${OVERRIDE_HINT}` };
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    /* empty */
  }
  let input = null;
  try {
    input = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    input = null;
  }
  const host = detectHost(input);
  let decision;
  try {
    decision = decideCost(extractCommand(input));
  } catch {
    // Fail closed: crude raw scan so violations are still blocked, unless
    // the override is present in the raw input.
    const raw2 = raw;
    const hasOverride = /(^|\s|")ST_ALLOW_CLOUD=1(\s|$|")/.test(raw2);
    const suspicious =
      /-fast\b[\s\S]*--model|--model[\s\S]*-fast\b/.test(raw2)
      || hitsCursorCloudApi(raw2)
      || /\bcodex\b[\s\S]*\bcloud\b[\s\S]*\bexec\b/.test(raw2)
      || /\bclaude\b[\s\S]*--cloud\b/.test(raw2);
    decision =
      suspicious && !hasOverride
        ? { permission: 'deny', message: `Sea Trials cost policy (Oct 2026): cloud/*-fast coding is blocked. ${LOCAL_FALLBACK}${OVERRIDE_HINT}` }
        : { permission: 'allow' };
  }
  const out = render(host, decision);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
