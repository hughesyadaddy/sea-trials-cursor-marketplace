#!/usr/bin/env node
/**
 * Probe the host (Cursor / Claude Code) for model + tool capabilities and
 * cache the result at `hostCapabilitiesPath()`:
 *
 *   ~/.cache/sea-trials/host/capabilities.json   (root: ST_STATE_DIR)
 *
 *   node st-model-probe.mjs [--quiet] [--json] [--force] [--max-age 24h]
 *                           [--set tools.askQuestion=true ...]
 *
 * Called from session-start hooks, so it ALWAYS exits 0 and prints
 * nothing with `--quiet`. Every external call (`agent`, `claude`) is
 * best-effort with a 3 s timeout and runs in parallel: a cold probe
 * finishes in ~2 s, a cached one in the time it takes node to start.
 *
 * Host tools (AskQuestion / AskUserQuestion) cannot be seen from a
 * shell. Skills that can see their tool schema record it with
 * `--set tools.askQuestion=true`; `--set` never triggers a re-probe on
 * a fresh cache. See skills/st-build-with-subagents/references/model-probe.md.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hostCapabilitiesPath } from '../lib/st-state-dir.mjs';
import {
  STATIC_CLAUDE_MODELS,
  STATIC_CURSOR_MODELS,
  SOURCE_STATIC,
  detectHost,
  hostEnvNames,
} from './lib/host-capabilities.mjs';

export const CAPABILITIES_VERSION = 1;
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CALL_TIMEOUT_MS = 3000;

export const SOURCE_AGENT_LIST = 'agent --list-models';
export const SOURCE_CLAUDE_ALIASES = 'claude cli aliases';

export const TOOLS_NOTE =
  'host tools cannot be probed from a shell; set by skills at runtime ' +
  'via --set tools.askQuestion=true / --set tools.askUserQuestion=true';

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const pluginMcpJson = path.join(hooksDir, '..', '..', 'mcp.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{
 *   quiet: boolean, json: boolean, force: boolean, maxAgeMs: number,
 *   sets: string[], help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    quiet: false,
    json: false,
    force: false,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    sets: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet' || arg === '-q') out.quiet = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--max-age') out.maxAgeMs = parseDuration(argv[++i]);
    else if (arg.startsWith('--max-age=')) {
      out.maxAgeMs = parseDuration(arg.slice('--max-age='.length));
    } else if (arg === '--set') out.sets.push(String(argv[++i] ?? ''));
    else if (arg.startsWith('--set=')) out.sets.push(arg.slice(6));
  }
  return out;
}

/**
 * `24h`, `30m`, `10s`, `500ms`, `2d`, or a bare millisecond count.
 * Unparseable input falls back to the default so a hook never dies here.
 *
 * @param {string|undefined} text
 */
export function parseDuration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(String(text ?? ''));
  if (!m) return DEFAULT_MAX_AGE_MS;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * mult[unit]);
}

// ---------------------------------------------------------------------------
// Runner (injectable)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ status: number|null, stdout: string, stderr: string }} RunResult
 * @typedef {(cmd: string, args: string[], opts: { timeoutMs: number, env: NodeJS.ProcessEnv })
 *   => Promise<RunResult|null>} Runner
 */

/** Default runner: async spawn, hard timeout, never throws. */
export const defaultRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(cmd, args, {
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      done(null);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      done(null);
    }, opts.timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });

// ---------------------------------------------------------------------------
// Discovery helpers (pure where possible)
// ---------------------------------------------------------------------------

/**
 * Locate an executable on PATH plus `~/.local/bin` (where the Cursor
 * and Claude installers put their launchers).
 *
 * @param {string} name
 * @param {{ env: NodeJS.ProcessEnv, homeDir: string, exists?: (p: string) => boolean }} opts
 * @returns {string|undefined}
 */
export function findExecutable(name, opts) {
  const exists =
    opts.exists ??
    ((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const dirs = String(opts.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  dirs.push(path.join(opts.homeDir, '.local', 'bin'));
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Parse `agent --list-models` output. Accepts JSON (array of strings or
 * objects with `id`/`slug`/`name`) or plain text, one model per line
 * with optional bullet / description. Returns `[]` when the CLI says no
 * models are available.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseAgentModelList(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  if (/^no models available/i.test(raw)) return [];
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed)
        ? parsed
        : parsed.models ?? parsed.data ?? [];
      return uniq(
        items
          .map((m) =>
            typeof m === 'string' ? m : m?.id ?? m?.slug ?? m?.name ?? '',
          )
          .map(String)
          .filter((s) => SLUG_RE.test(s)),
      );
    } catch {
      // fall through to text parsing
    }
  }
  const HEADER_RE = /^(available|models?|name|id|usage|options|default)$/i;
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.replace(/^[\s*\-•>❯]+/, '').trim();
    if (!stripped || /:\s*$/.test(stripped)) continue;
    const token = stripped.split(/[\s(,:]+/)[0];
    if (HEADER_RE.test(token)) continue;
    if (SLUG_RE.test(token)) out.push(token);
  }
  return uniq(out);
}

/**
 * Parse `claude plugin list` into plugin names (`name@marketplace` → `name`).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseClaudePluginList(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^[\s❯>*\-]*([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9._-]+)\s*$/.exec(
      line,
    );
    if (m) out.push(m[1]);
  }
  return uniq(out);
}

/** First `x.y.z`-looking token in a `--version` output. */
export function parseVersion(text) {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)*)/.exec(String(text ?? ''));
  return m ? m[1] : undefined;
}

function uniq(list) {
  return [...new Set(list)];
}

/**
 * Names of MCP servers declared in the readable config files. Only keys
 * are read — server configs may hold tokens and must never be copied.
 *
 * @param {{ homeDir: string, pluginMcpPath?: string, readFile?: (p: string) => string }} opts
 */
export function collectMcpServers(opts) {
  const readFile =
    opts.readFile ??
    ((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''));
  const files = {
    cursorUser: path.join(opts.homeDir, '.cursor', 'mcp.json'),
    plugin: opts.pluginMcpPath ?? pluginMcpJson,
    claudeUser: path.join(opts.homeDir, '.claude.json'),
  };
  /** @type {Record<string, string[]>} */
  const sources = {};
  for (const [label, file] of Object.entries(files)) {
    try {
      const text = readFile(file);
      if (!text) {
        sources[label] = [];
        continue;
      }
      const parsed = JSON.parse(text);
      const servers = parsed?.mcpServers;
      sources[label] =
        servers && typeof servers === 'object' ? Object.keys(servers).sort() : [];
    } catch {
      sources[label] = [];
    }
  }
  return {
    servers: uniq(Object.values(sources).flat()).sort(),
    sources,
  };
}

// ---------------------------------------------------------------------------
// --set support
// ---------------------------------------------------------------------------

const SET_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

/** `true` / `false` / `null` / number / JSON array or object / string. */
export function coerceSetValue(text) {
  const v = String(text ?? '').trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v === 'unknown') return 'unknown';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') || v.startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Apply `key.path=value` assignments in place. Invalid keys are skipped
 * (returned in `rejected`) — never thrown.
 *
 * @param {Record<string, any>} target
 * @param {string[]} sets
 */
export function applySets(target, sets) {
  const applied = [];
  const rejected = [];
  for (const entry of sets) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      rejected.push(entry);
      continue;
    }
    const key = entry.slice(0, eq).trim();
    const value = coerceSetValue(entry.slice(eq + 1));
    if (!SET_KEY_RE.test(key) || /(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(key)) {
      rejected.push(entry);
      continue;
    }
    const parts = key.split('.');
    let node = target;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) {
        node[part] = {};
      }
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
    applied.push(key);
  }
  return { applied, rejected };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Run the probe. Everything is injectable for tests.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv, homeDir?: string, runner?: Runner,
 *   now?: () => Date, timeoutMs?: number, previous?: Record<string, any>|null,
 *   pluginMcpPath?: string, exists?: (p: string) => boolean,
 *   readFile?: (p: string) => string,
 * }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function probe(opts = {}) {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const run = (cmd, args) =>
    runner(cmd, args, { timeoutMs, env }).catch(() => null);

  const agentPath = findExecutable('agent', { env, homeDir, exists: opts.exists });
  const claudePath = findExecutable('claude', { env, homeDir, exists: opts.exists });

  const [agentVersion, agentModels, claudeVersion, claudePlugins] =
    await Promise.all([
      agentPath ? run(agentPath, ['--version']) : null,
      agentPath ? run(agentPath, ['--list-models']) : null,
      claudePath ? run(claudePath, ['--version']) : null,
      claudePath ? run(claudePath, ['plugin', 'list']) : null,
    ]);

  const cursor = { models: [...STATIC_CURSOR_MODELS], source: SOURCE_STATIC, verified: false };
  if (agentPath) {
    cursor.cliPath = agentPath;
    const v = parseVersion(agentVersion?.stdout);
    if (v) cursor.cliVersion = v;
    const listed = agentModels ? parseAgentModelList(agentModels.stdout) : [];
    if (listed.length > 0) {
      cursor.models = uniq(['inherit', ...listed]);
      cursor.source = SOURCE_AGENT_LIST;
      cursor.verified = true;
    } else {
      const firstLine = String(agentModels?.stdout ?? agentModels?.stderr ?? '')
        .trim()
        .split(/\r?\n/)[0];
      cursor.note = agentModels
        ? `${SOURCE_AGENT_LIST}: ${firstLine || 'empty output'}`
        : `${SOURCE_AGENT_LIST}: timed out or failed to start`;
    }
  } else {
    cursor.note = 'agent CLI not installed';
  }

  const claude = { models: [...STATIC_CLAUDE_MODELS], source: SOURCE_STATIC, verified: false };
  if (claudePath) {
    claude.cliPath = claudePath;
    const v = parseVersion(claudeVersion?.stdout);
    if (v) claude.cliVersion = v;
    if (claudeVersion && claudeVersion.status === 0) {
      // Aliases are part of the CLI contract; the CLI answering makes
      // them verified even though there is no list command.
      claude.source = SOURCE_CLAUDE_ALIASES;
      claude.verified = true;
    }
    if (claudePlugins?.stdout) {
      claude.pluginsInstalled = parseClaudePluginList(claudePlugins.stdout);
    }
  } else {
    claude.note = 'claude CLI not installed';
  }

  const previousTools =
    opts.previous?.tools && typeof opts.previous.tools === 'object'
      ? opts.previous.tools
      : {};
  const tools = {
    askQuestion: previousTools.askQuestion ?? 'unknown',
    askUserQuestion: previousTools.askUserQuestion ?? 'unknown',
    notes: TOOLS_NOTE,
  };

  return {
    version: CAPABILITIES_VERSION,
    probedAt: now().toISOString(),
    probeDurationMs: Date.now() - started,
    host: detectHost(env),
    hostEnv: hostEnvNames(env),
    cursor,
    claude,
    tools,
    mcp: collectMcpServers({
      homeDir,
      pluginMcpPath: opts.pluginMcpPath,
      readFile: opts.readFile,
    }),
  };
}

/**
 * @param {Record<string, any>|null} caps
 * @param {number} maxAgeMs
 * @param {() => Date} [now]
 */
export function isFresh(caps, maxAgeMs, now = () => new Date()) {
  if (!caps || typeof caps.probedAt !== 'string') return false;
  const at = Date.parse(caps.probedAt);
  if (Number.isNaN(at)) return false;
  return now().getTime() - at < maxAgeMs;
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Full CLI flow: cache check, probe, `--set`, write, report.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {Parameters<typeof probe>[0] & { file?: string }} [opts]
 * @returns {Promise<{
 *   caps: Record<string, any>, action: 'cached'|'probed',
 *   file: string, rejected: string[],
 * }>}
 */
export async function runProbeCli(args, opts = {}) {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const now = opts.now ?? (() => new Date());
  const file = opts.file ?? hostCapabilitiesPath({ env, homeDir });
  const previous = readJson(file);

  let caps;
  let action;
  if (!args.force && isFresh(previous, args.maxAgeMs, now)) {
    caps = previous;
    action = 'cached';
  } else {
    caps = await probe({ ...opts, env, homeDir, now, previous });
    action = 'probed';
  }

  let rejected = [];
  if (args.sets.length > 0) {
    ({ rejected } = applySets(caps, args.sets));
    caps.updatedAt = now().toISOString();
  }
  if (action === 'probed' || args.sets.length > 0) writeJsonAtomic(file, caps);
  return { caps, action, file, rejected };
}

function summaryLine(result) {
  const { caps, action } = result;
  const c = caps.cursor ?? {};
  const k = caps.claude ?? {};
  return (
    `[st-model-probe] ${action} host=${caps.host} ` +
    `cursor=${(c.models ?? []).length} models (${c.source}` +
    `${c.cliVersion ? ` v${c.cliVersion}` : ''}) ` +
    `claude=${(k.models ?? []).length} models (${k.source}` +
    `${k.cliVersion ? ` v${k.cliVersion}` : ''}) ` +
    `mcp=${(caps.mcp?.servers ?? []).length} -> ${result.file}`
  );
}

function printHelp() {
  process.stdout.write(`\
Probe the host for subagent model slugs and cache capabilities.json.

  --quiet          print nothing (session-start hook mode)
  --json           print the capabilities JSON to stdout
  --force          re-probe even if the cache is fresh
  --max-age <dur>  cache lifetime (default 24h; e.g. 30m, 2d, 500ms)
  --set k.p=v      record an observation (tools.askQuestion=true ...);
                   does not re-probe a fresh cache

Always exits 0. File: ${hostCapabilitiesPath()}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = await runProbeCli(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result.caps, null, 2)}\n`);
  }
  if (!args.quiet) {
    process.stderr.write(`${summaryLine(result)}\n`);
    for (const bad of result.rejected) {
      process.stderr.write(`[st-model-probe] ignored --set ${bad}\n`);
    }
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .catch((err) => {
      if (!process.argv.includes('--quiet')) {
        process.stderr.write(`st-model-probe: ${err?.message ?? err}\n`);
      }
    })
    .finally(() => process.exit(0));
}
