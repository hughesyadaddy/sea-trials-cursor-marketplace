#!/usr/bin/env node
/**
 * Push guard — one implementation for both hosts.
 *
 *   Cursor  beforeShellExecution  stdin {"command", "cwd", ...}
 *   Claude  PreToolUse (Bash)     stdin {"tool_name", "tool_input":{"command"}, "cwd", ...}
 *
 * Decisions, per `git push` segment in the command:
 *   --no-verify / -n / --dry-run   DENY (never overridable)
 *   --force / -f / --force-with-lease
 *                                  DENY unless ST_ALLOW_FORCE_PUSH=1
 *   bare push in a gated repo      DENY unless a fresh gate-pass token
 *                                  (written by pr-review-push) exists
 *                                  or ST_ALLOW_BARE_PUSH=1
 *   push in a repo without gate    ALLOW
 *
 * A repo "has the gate" when its root has `.husky/st-plugin-run.sh` or a
 * `pr-review-push` script in package.json.
 *
 * Output:
 *   Cursor  {"permission":"allow"|"deny","user_message","agent_message"}
 *           exit 0 (JSON is the decision)
 *   Claude  allow -> exit 0, no output
 *           deny  -> hookSpecificOutput JSON on stdout + reason on stderr,
 *                    exit 2 (exit 2 blocks even if stdout is ignored)
 *
 * Flag checks are pure string work and never fail open. Anything that
 * needs git (repo root, token) fails open with a note on stderr.
 *
 * Try it:  echo '{"command":"git push"}' | node hooks/scripts/guard-git-push.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';

export const PUSH_GATE_COMMAND = 'pnpm pr-review-push -- --pr <n>';

export const MESSAGES = {
  noVerify:
    'Sea Trials: never git push with --no-verify, -n, or --dry-run. '
    + `Run: ${PUSH_GATE_COMMAND}`,
  force:
    'Sea Trials: force push is blocked (--force, -f, --force-with-lease). '
    + `Run: ${PUSH_GATE_COMMAND}. `
    + 'ST_ALLOW_FORCE_PUSH=1 only for an explicitly approved rewrite.',
  barePush:
    'Sea Trials: bare git push is blocked here. '
    + `Run: ${PUSH_GATE_COMMAND}`,
};

/** Mirrors PHASE_PREPUSH in scripts/hooks/lib/push-gate-tasks.mjs. */
const REQUIRED_PHASE = 'prepush';

const GATE_MARKER = path.join('.husky', 'st-plugin-run.sh');
const GATE_SCRIPT = 'pr-review-push';

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '\n'];

/**
 * Split a shell command into segments of word tokens, honouring quotes
 * and backslashes. Control operators (`&&`, `||`, `;`, `|`, newline)
 * end a segment; a trailing `&` is dropped. Quoted content is kept
 * verbatim (quotes removed) so `bash -c "git push"` can be re-scanned.
 *
 * @param {string} command
 * @returns {string[][]}
 */
export function splitSegments(command) {
  /** @type {string[][]} */
  const segments = [];
  /** @type {string[]} */
  let words = [];
  let word = '';
  let inWord = false;
  let i = 0;

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          word += command[i + 1];
          i += 2;
        } else {
          word += command[i];
          i += 1;
        }
      }
      inWord = true;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') {
        word += command[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    const op = OPERATORS.find((o) => command.startsWith(o, i));
    if (op) {
      endSegment();
      i += op.length;
      continue;
    }
    if (ch === '&') {
      endSegment();
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      i += 1;
      continue;
    }
    word += ch;
    inWord = true;
    i += 1;
  }
  endSegment();
  return segments;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** git global options that consume the next token. */
const GIT_OPTS_WITH_ARG = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
]);

/**
 * @param {string} token
 * @returns {string} executable basename without `.exe`
 */
function baseName(token) {
  return path.basename(token.replace(/\\/g, '/')).replace(/\.exe$/i, '');
}

/**
 * Drop env assignments and wrappers (`FOO=1 command git push`),
 * keeping the assignments: the hook process does not inherit the agent
 * shell's environment, so `ST_ALLOW_*=1 git push` in the command text is
 * the only way an escape hatch can reach the guard.
 *
 * @param {string[]} words
 * @returns {{ words: string[], env: Record<string, string> }}
 */
function stripPrefixes(words) {
  /** @type {Record<string, string>} */
  const env = {};
  const take = (w) => {
    const eq = w.indexOf('=');
    env[w.slice(0, eq)] = w.slice(eq + 1);
  };
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (ENV_ASSIGNMENT.test(w)) {
      take(w);
      i += 1;
    } else if (WRAPPERS.has(w)) {
      i += 1;
    } else if (w === 'env') {
      i += 1;
      while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || words[i] === '-i')) {
        if (words[i] !== '-i') take(words[i]);
        i += 1;
      }
    } else {
      break;
    }
  }
  return { words: words.slice(i), env };
}

/**
 * @typedef {object} PushInvocation
 * @property {string[]} args   tokens after `push`
 * @property {string[]} cDirs  every `git -C <dir>` in order
 * @property {boolean} noVerify
 * @property {boolean} force
 * @property {Record<string, string>} env  `FOO=1` prefixes on the segment
 */

/**
 * @param {string[]} words one segment, prefixes already stripped
 * @returns {PushInvocation | null}
 */
function parseGitSegment(words) {
  if (words.length === 0 || baseName(words[0]) !== 'git') return null;
  const cDirs = [];
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (!w.startsWith('-')) break;
    if (GIT_OPTS_WITH_ARG.has(w)) {
      if (w === '-C' && i + 1 < words.length) cDirs.push(words[i + 1]);
      i += 2;
    } else {
      i += 1;
    }
  }
  if (words[i] !== 'push') return null;
  const args = words.slice(i + 1);
  return { args, cDirs, ...classifyPushFlags(args) };
}

/**
 * @param {string[]} args tokens after `push`
 * @returns {{ noVerify: boolean, force: boolean }}
 */
export function classifyPushFlags(args) {
  let noVerify = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--no-verify' || arg === '--dry-run') noVerify = true;
    else if (arg === '--force' || arg.startsWith('--force-with-lease')) {
      force = true;
    } else if (/^-[A-Za-z]+$/.test(arg)) {
      if (arg.includes('n')) noVerify = true;
      if (arg.includes('f')) force = true;
    }
  }
  return { noVerify, force };
}

/**
 * Every `git push` invocation in a command, including ones nested in
 * `sh -c "..."` or `eval "..."`.
 *
 * @param {string} command
 * @param {number} [depth]
 * @returns {PushInvocation[]}
 */
export function findPushInvocations(command, depth = 0) {
  /** @type {PushInvocation[]} */
  const found = [];
  if (depth > 3) return found;
  for (const segment of splitSegments(command)) {
    const { words, env } = stripPrefixes(segment);
    if (words.length === 0) continue;
    const exe = baseName(words[0]);
    if (exe === 'git') {
      const push = parseGitSegment(words);
      if (push) found.push({ ...push, env });
      continue;
    }
    if (SHELLS.has(exe)) {
      const c = words.indexOf('-c');
      if (c !== -1 && c + 1 < words.length) {
        found.push(...findPushInvocations(words[c + 1], depth + 1));
      }
      continue;
    }
    if (exe === 'eval') {
      found.push(...findPushInvocations(words.slice(1).join(' '), depth + 1));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Host detection and input
// ---------------------------------------------------------------------------

/**
 * @param {any} input parsed stdin JSON
 * @param {NodeJS.ProcessEnv} env
 * @returns {'claude' | 'cursor'}
 */
export function detectHost(input, env = process.env) {
  if (input && typeof input === 'object') {
    if (input.tool_input !== undefined || input.tool_name !== undefined) {
      return 'claude';
    }
    if (input.hook_event_name === 'PreToolUse') return 'claude';
    if (typeof input.command === 'string') return 'cursor';
  }
  if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR) return 'claude';
  return 'cursor';
}

/**
 * @param {any} input
 * @returns {string}
 */
export function extractCommand(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  const tool = input.tool_input;
  if (tool && typeof tool === 'object' && typeof tool.command === 'string') {
    return tool.command;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Repo gate
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null}
 */
function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: isWindows,
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/**
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function repoHasGate(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, GATE_MARKER))) return true;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    return Boolean(pkg?.scripts && typeof pkg.scripts[GATE_SCRIPT] === 'string');
  } catch {
    return false;
  }
}

/**
 * Fresh gate-pass token for HEAD + tree, ignoring ST_REVIEW_PUSH: the
 * agent shell is not the pr-review-push child process, so that env var
 * is never set here. HEAD, tree fingerprint, phase and age still apply.
 *
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: boolean, reason: string }}
 */
export async function gatePassIsFresh(repoRoot, env) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const libPath = path.resolve(
    here,
    '../../scripts/hooks/lib/gate-pass-token.mjs',
  );
  const lib = await import(pathToFileURL(libPath).href);
  const headOid = git(repoRoot, ['rev-parse', 'HEAD']) ?? '';
  if (!headOid) return { ok: false, reason: 'no HEAD' };
  return lib.checkGatePassToken(repoRoot, {
    requiredPhase: REQUIRED_PHASE,
    env: { ...env, ST_REVIEW_PUSH: headOid },
  });
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Decision
 * @property {'allow' | 'deny'} permission
 * @property {string} [message]  user/agent facing explanation
 * @property {string} [note]     stderr diagnostics (allow path)
 */

/**
 * @param {any} input parsed hook input
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 * @returns {Promise<Decision>}
 */
export async function decide(input, opts = {}) {
  const env = opts.env ?? process.env;
  const command = extractCommand(input);
  if (!command) return { permission: 'allow' };

  const pushes = findPushInvocations(command);
  if (pushes.length === 0) return { permission: 'allow' };

  // Escape hatches: hook env, or an explicit `VAR=1` prefix on the
  // segment itself (visible in the command the user approves).
  const hatch = (name) =>
    (env[name] ?? '').trim() === '1'
    || pushes.every((p) => (p.env[name] ?? '').trim() === '1');

  // Flag checks: pure string work, never fail open.
  if (pushes.some((p) => p.noVerify)) {
    return { permission: 'deny', message: MESSAGES.noVerify };
  }
  if (!hatch('ST_ALLOW_FORCE_PUSH') && pushes.some((p) => p.force)) {
    return { permission: 'deny', message: MESSAGES.force };
  }

  if (hatch('ST_ALLOW_BARE_PUSH')) {
    return {
      permission: 'allow',
      note: 'Sea Trials: ST_ALLOW_BARE_PUSH=1 — push gate hook bypassed.',
    };
  }

  const baseCwd =
    typeof input?.cwd === 'string' && input.cwd
      ? input.cwd
      : (opts.cwd ?? process.cwd());
  const notes = [];
  for (const push of pushes) {
    let dir = baseCwd;
    for (const c of push.cDirs) dir = path.resolve(dir, c);

    let repoRoot = null;
    try {
      repoRoot = fs.existsSync(dir)
        ? git(dir, ['rev-parse', '--show-toplevel'])
        : null;
    } catch (err) {
      notes.push(`Sea Trials push guard: ${err.message}`);
    }
    if (!repoRoot) continue; // not a repo (push would fail anyway)
    if (!repoHasGate(repoRoot)) continue;

    let pass = { ok: false, reason: 'no gate token' };
    try {
      pass = await gatePassIsFresh(repoRoot, env);
    } catch (err) {
      pass = { ok: false, reason: `token check failed: ${err.message}` };
    }
    if (!pass.ok) {
      return {
        permission: 'deny',
        message: `${MESSAGES.barePush} (${pass.reason})`,
      };
    }
    notes.push(`Sea Trials push guard: ${pass.reason}; allowing push.`);
  }
  return {
    permission: 'allow',
    note: notes.length > 0 ? notes.join('\n') : undefined,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * @param {'claude' | 'cursor'} host
 * @param {Decision} decision
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export function render(host, decision) {
  const stderr = decision.note ? `${decision.note}\n` : '';
  if (host === 'cursor') {
    const body =
      decision.permission === 'deny'
        ? {
            permission: 'deny',
            user_message: decision.message,
            agent_message: decision.message,
          }
        : { permission: 'allow' };
    return { stdout: `${JSON.stringify(body)}\n`, stderr, exitCode: 0 };
  }
  if (decision.permission === 'deny') {
    const body = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message,
      },
    };
    return {
      stdout: `${JSON.stringify(body)}\n`,
      stderr: `${stderr}${decision.message}\n`,
      exitCode: 2,
    };
  }
  return { stdout: '', stderr, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Last line of defence if the parser itself throws: a crude scan of the
 * raw input so hook-bypassing flags are still denied.
 *
 * @param {string} raw
 * @returns {Decision | null}
 */
export function fallbackFlagDeny(raw) {
  if (!/\bgit\b[\s\S]*\bpush\b/.test(raw)) return null;
  const end = String.raw`(?=[\s"'}\\]|$)`;
  if (new RegExp(String.raw`--no-verify|--dry-run|\s-[a-z]*n[a-z]*${end}`, 'i').test(raw)) {
    return { permission: 'deny', message: MESSAGES.noVerify };
  }
  if (new RegExp(String.raw`--force|\s-[a-z]*f[a-z]*${end}`, 'i').test(raw)) {
    return { permission: 'deny', message: MESSAGES.force };
  }
  return null;
}

async function main() {
  const raw = readStdin();
  let input = null;
  try {
    input = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    input = null;
  }
  const host = detectHost(input);
  let decision;
  try {
    decision = await decide(input);
  } catch (err) {
    decision = fallbackFlagDeny(raw) ?? {
      permission: 'allow',
      note: `Sea Trials push guard failed open: ${err.message}`,
    };
  }
  const out = render(host, decision);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

const invokedDirectly =
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
