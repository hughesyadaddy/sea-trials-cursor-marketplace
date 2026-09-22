/**
 * Host capabilities: read the probe output written by
 * `scripts/hooks/st-model-probe.mjs` and resolve a subagent model per
 * tier without guessing slugs.
 *
 * Pure module: no process spawning. Every function takes `env` and the
 * capabilities object as parameters so it can be tested exhaustively.
 *
 * Resolution order (per host):
 *   1. env override   `ST_SHARD_MODEL_<TIER>[_CLAUDE]`, then
 *                     `ST_WORKER_MODEL[_CLAUDE]` (mechanical tier only)
 *   2. probe list     tier default if the probe saw it, else the closest
 *                     available slug (see `pickFromList`)
 *   3. static default tagged `verified: false`
 */
import fs from 'node:fs';

import { hostCapabilitiesPath } from '../../lib/st-state-dir.mjs';

export const TIERS = Object.freeze(['mechanical', 'code', 'reasoning']);
export const DEFAULT_TIER = 'code';

/**
 * Tier defaults. Mirrors `TIER_MODELS` in st-build-shard-tasks.mjs; the
 * resolver only uses these as the *preferred* pick, never as truth.
 */
export const TIER_DEFAULTS = Object.freeze({
  mechanical: { cursor: 'composer-2.5-fast', claude: 'haiku' },
  code: { cursor: 'composer-2.5', claude: 'sonnet' },
  reasoning: { cursor: 'inherit', claude: 'inherit' },
});

/**
 * Cursor Task-tool slugs seen in a real session schema on 2026-09-22.
 * Used only when no probe file exists or the probe could not list
 * models; always reported with `verified: false`.
 */
export const STATIC_CURSOR_MODELS = Object.freeze([
  'inherit',
  'composer-2.5',
  'composer-2.5-fast',
  'cursor-grok-4.6-high-fast',
  'gpt-5.6-sol-medium',
  'grok-4.7-high-fast',
]);

/** Claude Code model aliases (stable across CLI versions) + `inherit`. */
export const STATIC_CLAUDE_MODELS = Object.freeze([
  'inherit',
  'haiku',
  'sonnet',
  'opus',
]);

export const SOURCE_ENV = 'env';
export const SOURCE_PROBE = 'probe';
export const SOURCE_STATIC = 'static-fallback';

/**
 * Env var names that identify the host of a tool-spawned shell. Observed
 * on 2026-09-22: Cursor sets `CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`,
 * `CURSOR_REQUEST_ID`, `CURSOR_EXTENSION_HOST_ROLE`, `CURSOR_LAYOUT`,
 * `CURSOR_RIPGREP_PATH`, `CURSOR_WORKSPACE_LABEL`, `CURSOR_TRACE_ID`
 * (some sessions). Claude Code sets `CLAUDECODE`, `CLAUDE_CODE_*` and
 * `CLAUDE_PLUGIN_ROOT` (inside plugin hooks).
 */
export const CURSOR_ENV_PREFIXES = Object.freeze(['CURSOR_']);
export const CLAUDE_ENV_NAMES = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_PLUGIN_ROOT',
]);
export const CLAUDE_ENV_PREFIXES = Object.freeze(['CLAUDE_CODE_']);

/**
 * Names (never values) of host-identifying env vars present in `env`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} sorted
 */
export function hostEnvNames(env = process.env) {
  const names = [];
  for (const key of Object.keys(env)) {
    if (CURSOR_ENV_PREFIXES.some((p) => key.startsWith(p))) names.push(key);
    else if (CLAUDE_ENV_NAMES.includes(key)) names.push(key);
    else if (CLAUDE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      names.push(key);
    }
  }
  return names.sort();
}

/**
 * Detect the host from the environment. `ST_HOST=cursor|claude` forces
 * the answer. Claude markers win over Cursor markers because a Claude
 * Code session started from a Cursor terminal inherits `CURSOR_*`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {'cursor'|'claude'|'unknown'}
 */
export function detectHost(env = process.env) {
  const forced = String(env.ST_HOST ?? '').trim().toLowerCase();
  if (forced === 'cursor' || forced === 'claude') return forced;
  const names = hostEnvNames(env);
  if (
    names.some(
      (n) =>
        CLAUDE_ENV_NAMES.includes(n) ||
        CLAUDE_ENV_PREFIXES.some((p) => n.startsWith(p)),
    )
  ) {
    return 'claude';
  }
  if (names.some((n) => CURSOR_ENV_PREFIXES.some((p) => n.startsWith(p)))) {
    return 'cursor';
  }
  return 'unknown';
}

/**
 * Read the probe output. Returns `null` when the file is missing or not
 * parseable — callers fall back to static defaults.
 *
 * @param {{ path?: string, env?: NodeJS.ProcessEnv, homeDir?: string }} [opts]
 * @returns {Record<string, any>|null}
 */
export function readCapabilities(opts = {}) {
  let file = opts.path;
  try {
    file ??= hostCapabilitiesPath({ env: opts.env, homeDir: opts.homeDir });
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {string} tier */
export function normalizeTier(tier) {
  return TIERS.includes(tier) ? tier : DEFAULT_TIER;
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string' && v))];
}

/**
 * Verified model list for one host from the probe, or `null` when the
 * probe has nothing trustworthy (missing, empty, or static fallback).
 *
 * @param {Record<string, any>|null|undefined} caps
 * @param {'cursor'|'claude'} host
 */
export function probedModels(caps, host) {
  const section = caps?.[host];
  if (!section || typeof section !== 'object') return null;
  const models = cleanList(section.models);
  if (models.length === 0) return null;
  if (section.verified === false || section.source === SOURCE_STATIC) {
    return null;
  }
  return models;
}

/**
 * Pick the best slug for a tier from an available list.
 *
 *   mechanical: tier default -> any `*-fast` slug -> `composer-2.5` -> inherit
 *   code:       tier default -> `composer-2.5` -> inherit
 *   reasoning:  inherit
 *
 * `inherit` is always accepted (the Task tool never rejects it).
 *
 * @param {string} tier
 * @param {string[]} list
 * @param {'cursor'|'claude'} host
 */
export function pickFromList(tier, list, host) {
  const t = normalizeTier(tier);
  const preferred = TIER_DEFAULTS[t][host];
  const has = (slug) => list.includes(slug);
  if (t === 'reasoning') return 'inherit';
  if (has(preferred)) return preferred;
  if (host === 'claude') {
    // Aliases are a fixed ladder; fall to the next cheaper-or-equal one.
    const ladder =
      t === 'mechanical'
        ? ['haiku', 'sonnet', 'opus']
        : ['sonnet', 'opus', 'haiku'];
    return ladder.find(has) ?? 'inherit';
  }
  if (t === 'mechanical') {
    const fast = list.filter((s) => /-fast$/i.test(s) && s !== 'inherit');
    if (fast.includes('composer-2.5-fast')) return 'composer-2.5-fast';
    if (fast.length > 0) return [...fast].sort()[0];
  }
  if (has('composer-2.5')) return 'composer-2.5';
  return 'inherit';
}

function envOverride(env, tier, host) {
  const key = tier.toUpperCase();
  const suffix = host === 'claude' ? '_CLAUDE' : '';
  const shard = String(env[`ST_SHARD_MODEL_${key}${suffix}`] ?? '').trim();
  if (shard) return shard;
  if (tier === 'mechanical') {
    const worker = String(env[`ST_WORKER_MODEL${suffix}`] ?? '').trim();
    if (worker) return worker;
  }
  return '';
}

/**
 * Resolve one host's model.
 *
 * @param {{
 *   tier: string, host: 'cursor'|'claude',
 *   caps?: Record<string, any>|null, env?: NodeJS.ProcessEnv,
 * }} args
 * @returns {{ model: string, verified: boolean, source: string }}
 */
export function resolveHostModel({ tier, host, caps, env = process.env }) {
  const t = normalizeTier(tier);
  const list = probedModels(caps, host);
  const override = envOverride(env, t, host);
  if (override) {
    return {
      model: override,
      verified: Boolean(
        list && (list.includes(override) || override === 'inherit'),
      ),
      source: SOURCE_ENV,
    };
  }
  if (list) {
    return {
      model: pickFromList(t, list, host),
      verified: true,
      source: SOURCE_PROBE,
    };
  }
  const fallback =
    host === 'claude' ? STATIC_CLAUDE_MODELS : STATIC_CURSOR_MODELS;
  return {
    model: pickFromList(t, [...fallback], host),
    verified: false,
    source: SOURCE_STATIC,
  };
}

/**
 * Resolve both hosts' models for a tier.
 *
 * `caps === undefined` reads the probe file from disk; pass `null` to
 * skip the read (tests, or when the caller already knows there is none).
 *
 * @param {{
 *   tier?: string, host?: 'cursor'|'claude'|'unknown',
 *   caps?: Record<string, any>|null, env?: NodeJS.ProcessEnv,
 * }} [args]
 * @returns {{
 *   tier: string, host: string,
 *   model: string, claudeModel: string,
 *   verified: boolean, source: string,
 *   cursor: { model: string, verified: boolean, source: string },
 *   claude: { model: string, verified: boolean, source: string },
 * }}
 */
export function resolveModel(args = {}) {
  const env = args.env ?? process.env;
  const caps = args.caps === undefined ? readCapabilities({ env }) : args.caps;
  const tier = normalizeTier(args.tier);
  const host = args.host ?? caps?.host ?? detectHost(env);
  const cursor = resolveHostModel({ tier, host: 'cursor', caps, env });
  const claude = resolveHostModel({ tier, host: 'claude', caps, env });
  const active = host === 'claude' ? claude : cursor;
  return {
    tier,
    host,
    model: cursor.model,
    claudeModel: claude.model,
    verified:
      host === 'unknown' ? cursor.verified && claude.verified : active.verified,
    source: active.source,
    cursor,
    claude,
  };
}
