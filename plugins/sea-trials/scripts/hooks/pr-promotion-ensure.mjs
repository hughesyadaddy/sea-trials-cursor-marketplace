#!/usr/bin/env node
/**
 * Find or create an open promotion PR between two branches.
 *
 *   pnpm pr-promotion-ensure -- --base main --head stg \
 *     --title "PROD <- STG" --body "…"
 *
 * Prints the PR number to stdout.
 */
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/**
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `gh ${args.join(' ')}`).trim(),
    );
  }
  return (result.stdout ?? '').trim();
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const tokens = argv[0] === '--' ? argv.slice(1) : argv;
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i];
    if (!key.startsWith('--')) {
      continue;
    }
    const name = key.slice(2);
    const value = tokens[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    out[name] = value;
    i += 1;
  }
  for (const required of ['base', 'head', 'title', 'body']) {
    if (!out[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  return out;
}

function main() {
  const { base, head, title, body } = parseArgs(process.argv.slice(2));
  const existing = runGh([
    'pr',
    'list',
    '--base',
    base,
    '--head',
    head,
    '--state',
    'open',
    '--json',
    'number',
    '-q',
    '.[0].number',
  ]);
  if (existing) {
    process.stdout.write(`${existing}\n`);
    return;
  }
  const url = runGh([
    'pr',
    'create',
    '--base',
    base,
    '--head',
    head,
    '--title',
    title,
    '--body',
    body,
  ]);
  const match = url.match(/\/pull\/(\d+)\s*$/);
  if (!match) {
    throw new Error(`Could not parse PR number from gh output: ${url}`);
  }
  process.stdout.write(`${match[1]}\n`);
}

main();
