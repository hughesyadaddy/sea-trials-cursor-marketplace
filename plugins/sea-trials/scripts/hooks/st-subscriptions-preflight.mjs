#!/usr/bin/env node
/**
 * Read-only subscription diagnostics for the official Claude and Codex CLIs.
 *
 * Print an aligned human table or machine-readable JSON and exit according to
 * the selected requirement. Never log in or write config. Direct invocation
 * works outside a git checkout; st-run still requires a checkout.
 */
import { spawnSync } from 'node:child_process';
import { checkClaude, checkCodex } from '../subscriptions/lib/preflight.mjs';

const PREFLIGHT_TIMEOUT_MS = 15000;
const USAGE = 'Usage: st-subscriptions-preflight [--json] '
  + '[--require claude|codex|any|all]';
const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(USAGE);
  console.log('Read-only subscription checks; --require defaults to any.');
  console.log('--json prints machine-readable results instead of a table.');
  process.exit(0);
}

const index = args.indexOf('--require');
const requirement = index < 0 ? 'any' : args[index + 1];
if (!['claude', 'codex', 'any', 'all'].includes(requirement)) {
  console.error(USAGE);
  process.exit(1);
}

const exec = (cmd, argv, options) => spawnSync(cmd, argv, {
  ...options,
  encoding: 'utf8',
  timeout: PREFLIGHT_TIMEOUT_MS,
});
const results = [
  checkClaude({ exec, env: process.env }),
  checkCodex({ exec, env: process.env }),
];
const selected = requirement === 'any' || requirement === 'all'
  ? results
  : results.filter((result) => result.tool === requirement);
const ready = requirement === 'all'
  ? selected.every((result) => result.ready)
  : selected.some((result) => result.ready);

if (args.includes('--json')) {
  console.log(JSON.stringify(results));
} else {
  console.log('Tool    Ready  Setup');
  console.log('------  -----  -----');
  for (const result of results) {
    const tool = result.tool.padEnd(6);
    const status = (result.ready ? 'yes' : 'no').padEnd(5);
    console.log(`${tool}  ${status}  ${result.message}`);
  }
  if (!ready) {
    const nextSteps = selected
      .filter((result) => !result.ready)
      .map((result) => result.message)
      .join(' ');
    console.log(`\nNext step: ${nextSteps}`);
  }
}
process.exitCode = ready ? 0 : 1;
