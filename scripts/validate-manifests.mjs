#!/usr/bin/env node
/**
 * Validate dual-host plugin packaging for this marketplace.
 *
 * Checks (all plugins under plugins/*):
 * - root .claude-plugin/marketplace.json and .cursor-plugin/marketplace.json
 *   parse, have a `name`, and every entry's `source` directory exists
 * - each plugin's .claude-plugin/plugin.json and .cursor-plugin/plugin.json
 *   parse, have `name` + `version`, versions match across hosts, and the
 *   name appears in the matching marketplace with `source` → that dir
 * - manifest component paths are relative (`./…`) and exist
 * - every mcp.json / .mcp.json has `mcpServers`; `url` entries declare a
 *   `type` (http | sse | ws); otherwise `command` is required
 * - every hooks.json parses and any referenced plugin-relative command
 *   script exists
 * - every agents/**\/*.md and skills/*\/SKILL.md has YAML frontmatter with
 *   non-empty `name` and `description`
 *
 * Usage:
 *   node scripts/validate-manifests.mjs [--root <marketplace-root>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');

/** Claude plugin.json fields that hold component paths. */
const claudePathFields = [
  'skills',
  'commands',
  'agents',
  'hooks',
  'mcpServers',
  'outputStyles',
  'lspServers',
];
/** Cursor plugin.json fields that hold component paths. */
const cursorPathFields = ['skills', 'agents', 'hooks', 'rules', 'mcp'];
/** Remote MCP transports that require `type` next to `url`. */
const remoteMcpTypes = new Set(['http', 'sse', 'ws']);

/**
 * @typedef {object} Issue
 * @property {string} file  path relative to the marketplace root
 * @property {string} message
 */

/**
 * @param {string} root
 * @returns {Issue[]}
 */
export function validateMarketplace(root) {
  const ctx = new Context(path.resolve(root));

  const claudeMarket = ctx.readJson('.claude-plugin/marketplace.json');
  const cursorMarket = ctx.readJson('.cursor-plugin/marketplace.json');
  checkMarketplace(ctx, '.claude-plugin/marketplace.json', claudeMarket);
  checkMarketplace(ctx, '.cursor-plugin/marketplace.json', cursorMarket);

  for (const pluginDir of listDirs(path.join(ctx.root, 'plugins'))) {
    checkPlugin(ctx, pluginDir, claudeMarket, cursorMarket);
  }

  return ctx.issues;
}

class Context {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
    /** @type {Issue[]} */
    this.issues = [];
  }

  /**
   * @param {string} rel
   * @param {string} message
   */
  add(rel, message) {
    this.issues.push({ file: toPosix(rel), message });
  }

  /**
   * @param {string} absOrRel
   * @returns {string}
   */
  rel(absOrRel) {
    return path.isAbsolute(absOrRel)
      ? path.relative(this.root, absOrRel)
      : absOrRel;
  }

  /**
   * Parse a JSON file, recording an issue on failure.
   *
   * @param {string} rel path relative to root (or absolute)
   * @returns {any | null}
   */
  readJson(rel) {
    const abs = path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    if (!fs.existsSync(abs)) {
      this.add(this.rel(abs), 'missing file');
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      this.add(this.rel(abs), `invalid JSON: ${err.message}`);
      return null;
    }
  }
}

/**
 * @param {Context} ctx
 * @param {string} rel
 * @param {any} market
 */
function checkMarketplace(ctx, rel, market) {
  if (!market) return;
  if (typeof market.name !== 'string' || !market.name) {
    ctx.add(rel, 'missing `name`');
  }
  if (!Array.isArray(market.plugins)) {
    ctx.add(rel, '`plugins` must be an array');
    return;
  }
  market.plugins.forEach((entry, i) => {
    if (typeof entry?.name !== 'string' || !entry.name) {
      ctx.add(rel, `plugins[${i}] missing \`name\``);
    }
    if (typeof entry?.source !== 'string') {
      ctx.add(rel, `plugins[${i}] (${entry?.name}) missing string \`source\``);
      return;
    }
    if (!fs.existsSync(path.join(ctx.root, entry.source))) {
      ctx.add(rel, `plugins[${i}] source does not exist: ${entry.source}`);
    }
  });
}

/**
 * @param {any} market
 * @param {string} pluginName
 * @returns {any | undefined}
 */
function marketEntry(market, pluginName) {
  return market?.plugins?.find?.((p) => p?.name === pluginName);
}

/**
 * @param {Context} ctx
 * @param {string} pluginDir absolute
 * @param {any} claudeMarket
 * @param {any} cursorMarket
 */
function checkPlugin(ctx, pluginDir, claudeMarket, cursorMarket) {
  const claudeRel = path.join(
    ctx.rel(pluginDir),
    '.claude-plugin/plugin.json',
  );
  const cursorRel = path.join(
    ctx.rel(pluginDir),
    '.cursor-plugin/plugin.json',
  );
  const claude = ctx.readJson(claudeRel);
  const cursor = ctx.readJson(cursorRel);

  checkPluginManifest(ctx, claudeRel, claude, claudePathFields);
  checkPluginManifest(ctx, cursorRel, cursor, cursorPathFields);
  checkMarketEntry(ctx, {
    manifest: claude,
    market: claudeMarket,
    marketRel: '.claude-plugin/marketplace.json',
    pluginDir,
  });
  checkMarketEntry(ctx, {
    manifest: cursor,
    market: cursorMarket,
    marketRel: '.cursor-plugin/marketplace.json',
    pluginDir,
  });

  if (claude && cursor) {
    if (claude.name !== cursor.name) {
      ctx.add(
        claudeRel,
        `name "${claude.name}" != cursor name "${cursor.name}"`,
      );
    }
    if (claude.version !== cursor.version) {
      ctx.add(
        claudeRel,
        `version "${claude.version}" != cursor version "${cursor.version}"`,
      );
    }
  }

  for (const file of findFiles(pluginDir, isMcpFile)) checkMcp(ctx, file);
  for (const file of findFiles(pluginDir, (n) => n === 'hooks.json')) {
    checkHooks(ctx, file, pluginDir);
  }

  const manifests = [claude, cursor];
  for (const dir of componentDirs(pluginDir, manifests, 'agents')) {
    for (const file of findFiles(dir, (n) => n.endsWith('.md'))) {
      checkFrontmatter(ctx, file);
    }
  }
  for (const dir of componentDirs(pluginDir, manifests, 'skills')) {
    for (const file of findFiles(dir, (n) => n === 'SKILL.md')) {
      checkFrontmatter(ctx, file);
    }
  }
}

/**
 * @param {Context} ctx
 * @param {string} rel
 * @param {any} manifest
 * @param {string[]} pathFields
 */
function checkPluginManifest(ctx, rel, manifest, pathFields) {
  if (!manifest) return;
  if (typeof manifest.name !== 'string' || !manifest.name) {
    ctx.add(rel, 'missing `name`');
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    ctx.add(rel, 'missing `version`');
  }
  if (typeof manifest.description !== 'string' || !manifest.description) {
    ctx.add(rel, 'missing `description`');
  }
  const pluginDir = path.dirname(path.dirname(path.join(ctx.root, rel)));
  for (const field of pathFields) {
    const value = manifest[field];
    if (value === undefined) continue;
    const paths = Array.isArray(value)
      ? value.filter((v) => typeof v === 'string')
      : typeof value === 'string'
        ? [value]
        : [];
    for (const p of paths) {
      if (!p.startsWith('./')) {
        ctx.add(rel, `\`${field}\` path must start with ./ : ${p}`);
      }
      if (!fs.existsSync(path.join(pluginDir, p))) {
        ctx.add(rel, `\`${field}\` path does not exist: ${p}`);
      }
    }
  }
}

/**
 * @param {Context} ctx
 * @param {{
 *   manifest: any,
 *   market: any,
 *   marketRel: string,
 *   pluginDir: string,
 * }} args plugin manifest, its host marketplace, and the plugin dir
 */
function checkMarketEntry(ctx, { manifest, market, marketRel, pluginDir }) {
  if (!manifest || !market || typeof manifest.name !== 'string') return;
  const entry = marketEntry(market, manifest.name);
  if (!entry) {
    ctx.add(marketRel, `no entry for plugin "${manifest.name}"`);
    return;
  }
  if (typeof entry.source !== 'string') return;
  const expected = path.resolve(ctx.root, entry.source);
  if (path.resolve(pluginDir) !== expected) {
    const actual = toPosix(ctx.rel(pluginDir));
    ctx.add(
      marketRel,
      `"${manifest.name}" source ${entry.source} != ${actual}`,
    );
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isMcpFile(name) {
  return name === 'mcp.json' || name === '.mcp.json';
}

/**
 * @param {Context} ctx
 * @param {string} file absolute
 */
function checkMcp(ctx, file) {
  const rel = ctx.rel(file);
  const parsed = ctx.readJson(file);
  if (!parsed) return;
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    ctx.add(rel, 'missing `mcpServers` object');
    return;
  }
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    if (!server || typeof server !== 'object') {
      ctx.add(rel, `server "${name}" must be an object`);
      continue;
    }
    if (typeof server.url === 'string') {
      if (!remoteMcpTypes.has(server.type)) {
        ctx.add(
          rel,
          `server "${name}" has url but no type (http | sse | ws) `
            + '— Claude hard-errors',
        );
      }
    } else if (typeof server.command !== 'string' || !server.command) {
      ctx.add(
        rel,
        `server "${name}" needs \`command\` or \`url\` + \`type\``,
      );
    }
  }
}

/**
 * @param {Context} ctx
 * @param {string} file absolute hooks.json
 * @param {string} pluginDir absolute
 */
function checkHooks(ctx, file, pluginDir) {
  const rel = ctx.rel(file);
  const parsed = ctx.readJson(file);
  if (!parsed) return;
  if (!parsed.hooks || typeof parsed.hooks !== 'object') {
    ctx.add(rel, 'missing `hooks` object');
    return;
  }
  for (const command of hookCommands(parsed.hooks)) {
    const scriptRel = pluginRelativeScript(command);
    if (!scriptRel) continue;
    if (!fs.existsSync(path.join(pluginDir, scriptRel))) {
      ctx.add(rel, `hook script does not exist: ${scriptRel}`);
    }
  }
}

/**
 * Collect every `command` string from Claude- or Cursor-shaped hooks.
 *
 * @param {Record<string, any>} hooks
 * @returns {string[]}
 */
export function hookCommands(hooks) {
  /** @type {string[]} */
  const out = [];
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.command === 'string') out.push(entry.command);
      for (const inner of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (typeof inner?.command === 'string') out.push(inner.command);
      }
    }
  }
  return out;
}

/**
 * Extract the plugin-relative script path from a hook command, if any.
 *
 * Recognises `${CLAUDE_PLUGIN_ROOT}/x/y.sh` (optionally after an
 * interpreter such as `bash`) and Cursor's `./x/y.sh`.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function pluginRelativeScript(command) {
  const claude = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"']+)/);
  if (claude) return claude[1];
  const cursor = command.match(/(?:^|\s)\.\/([^\s"']+)/);
  if (cursor) return cursor[1];
  return null;
}

/**
 * Resolve the directories to scan for a component on both hosts,
 * falling back to the auto-discovered default when unset.
 *
 * @param {string} pluginDir absolute
 * @param {any[]} manifests
 * @param {'agents' | 'skills'} field also the auto-discovered default dir
 * @returns {string[]} absolute, existing, deduped
 */
function componentDirs(pluginDir, manifests, field) {
  const rels = new Set([field]);
  for (const manifest of manifests) {
    const value = manifest?.[field];
    if (typeof value === 'string') rels.add(value);
    if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string') rels.add(v);
    }
  }
  const dirs = new Set();
  for (const rel of rels) {
    const abs = path.resolve(pluginDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) dirs.add(abs);
  }
  return [...dirs];
}

/**
 * @param {Context} ctx
 * @param {string} file absolute markdown file
 */
function checkFrontmatter(ctx, file) {
  const rel = ctx.rel(file);
  const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!fm) {
    ctx.add(rel, 'missing YAML frontmatter');
    return;
  }
  for (const key of ['name', 'description']) {
    if (!fm.has(key)) ctx.add(rel, `frontmatter missing \`${key}\``);
  }
}

/**
 * Minimal frontmatter scan: returns the set of top-level keys that have a
 * non-empty scalar or a block scalar (`|` / `>`) with indented content.
 *
 * @param {string} text
 * @returns {Set<string> | null} null when no frontmatter block
 */
export function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return null;
  const lines = normalized.slice(4, end).split('\n');
  const keys = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    if (value && !/^[|>][+-]?$/.test(value)) {
      keys.add(key);
      continue;
    }
    const next = lines[i + 1] ?? '';
    if (/^\s+\S/.test(next)) keys.add(key);
  }
  return keys;
}

/**
 * @param {string} dir absolute
 * @returns {string[]} absolute child dirs, sorted
 */
function listDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Recursive file search, skipping node_modules and `_`-prefixed dirs
 * (e.g. skills/_sources, which are not skills).
 *
 * @param {string} dir absolute
 * @param {(name: string) => boolean} match
 * @returns {string[]} absolute, sorted
 */
function findFiles(dir, match) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} current */
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('_')) {
          continue;
        }
        walk(abs);
      } else if (entry.isFile() && match(entry.name)) {
        out.push(abs);
      }
    }
  }
  walk(dir);
  return out.sort();
}

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * @param {string[]} argv
 * @returns {{ root: string }}
 */
export function parseArgs(argv) {
  let root = defaultRoot;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      root = argv[i + 1] ?? root;
      i += 1;
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root };
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const issues = validateMarketplace(root);
  if (issues.length === 0) {
    process.stdout.write('validate-manifests: OK\n');
    return;
  }
  process.stderr.write(`validate-manifests: ${issues.length} issue(s)\n`);
  for (const issue of issues) {
    process.stderr.write(`  ${issue.file}: ${issue.message}\n`);
  }
  process.exit(1);
}

const invokedDirectly =
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`validate-manifests: ${err.message}\n`);
    process.exit(2);
  }
}
