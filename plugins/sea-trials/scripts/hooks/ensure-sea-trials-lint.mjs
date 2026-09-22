#!/usr/bin/env node
/**
 * Make sure the checkout has a usable `sea-trials-lint` binary.
 *
 *   node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" ensure-sea-trials-lint
 *   node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" ensure-sea-trials-lint -- --soft
 *   node "$ST_PLUGIN_ROOT/scripts/hooks/ensure-sea-trials-lint.mjs" --force-rebuild
 *
 * `--soft` never fails the caller (used from `pnpm install`'s prepare
 * step); `--force-rebuild` rebuilds from `tools/sea-trials-lint` even
 * when a binary is present (used when HEAD touches the linter source).
 */
import { ensureSeaTrialsLint } from './lib/ensure-sea-trials-lint.mjs';
import { resolveRepoRoot } from './lib/plugin-paths.mjs';

function formatError(e) {
  return e instanceof Error ? e.message : String(e);
}

const soft = process.argv.includes('--soft');
const forceRebuild = process.argv.includes('--force-rebuild');
const repoRoot = resolveRepoRoot();

try {
  const ok = ensureSeaTrialsLint(repoRoot, { soft, forceRebuild });
  if (ok) process.exit(0);
  if (soft) process.exit(0);
  process.exit(1);
} catch (e) {
  if (soft) {
    process.stderr.write(`⚠️  ${formatError(e)}\n`);
    process.exit(0);
  }
  process.stderr.write(`❌ ${formatError(e)}\n`);
  process.exit(1);
}
