#!/usr/bin/env node
/**
 * sessionStart (Cursor) / SessionStart (Claude): warm the model probe
 * cache so st-* skills can route subagents without a first-call stall.
 *
 * Prints nothing (stdout on SessionStart becomes agent context on both
 * hosts), always exits 0, and never blocks the hook on the probe: the
 * probe runs detached and finishes on its own. Skips silently when the
 * probe script has not shipped yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '../..');
const probe = path.join(pluginRoot, 'scripts', 'hooks', 'st-model-probe.mjs');

if (fs.existsSync(probe)) {
  try {
    const child = spawn(process.execPath, [probe, '--quiet'], {
      cwd: pluginRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Never fail a session start over a cache warm-up.
  }
}
process.exitCode = 0;
