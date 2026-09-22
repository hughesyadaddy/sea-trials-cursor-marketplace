#!/usr/bin/env node
/**
 * Resolve Flutter channel HEAD without installing the SDK.
 *
 * Used for PR job-level pass-cache keys so a channel advance cannot
 * false-skip format/analyze/test lanes that ran under an older SDK.
 */

import { spawnSync } from 'node:child_process';

const channel = process.env.FLUTTER_CHANNEL?.trim() || 'main';
const ref = `refs/heads/${channel}`;

const result = spawnSync(
  'git',
  ['ls-remote', 'https://github.com/flutter/flutter.git', ref],
  { encoding: 'utf8' },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || 'git ls-remote failed\n');
  process.exit(result.status || 1);
}

const revision = result.stdout.trim().split(/\s+/)[0];
if (!revision || revision.length < 8) {
  process.stderr.write(`Could not resolve ${ref}\n`);
  process.exit(1);
}

process.stdout.write(`revision=${revision}\n`);
