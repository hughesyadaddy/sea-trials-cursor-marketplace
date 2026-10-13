#!/usr/bin/env node
/**
 * Merge guard — agents never merge by hand.
 *
 *   gh pr merge … --admin            DENY (never overridable)
 *   gh pr merge …                    DENY → use st-pr-merge merge-gate.mjs
 *   gh api …/pulls/<n>/merge         DENY (REST merge bypass)
 *   gh api graphql mergePullRequest  DENY (GraphQL merge bypass)
 *
 * merge-gate.mjs spawns `gh pr merge --match-head-commit` itself (not via
 * the agent shell), so it is not affected. Same stdin/stdout contract as
 * guard-git-push.mjs for Cursor and Claude Code.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { detectHost, extractCommand, render, splitSegments } from './guard-git-push.mjs';

export const MERGE_GATE = 'node "$ST_PLUGIN_ROOT/skills/st-pr-merge/scripts/merge-gate.mjs" --pr <n>';
export const MERGE_MESSAGES = {
  admin: 'Sea Trials: `--admin` merges are forbidden (standing rule). Fix the failing check / thread / protection instead.',
  manual: `Sea Trials: merge only through the st-pr-merge gate (all checks green on head, zero unresolved Codex threads, migration order). Run: ${MERGE_GATE}`,
};

/** @param {string} command */
export function decideMerge(command) {
  const segments = splitSegments(command ?? '');
  const queue = [...segments];
  while (queue.length) {
    const words = queue.shift();
    // Re-scan `bash -c "<cmd>"` / `sh -c` payloads.
    for (let i = 0; i < words.length - 1; i += 1) {
      if (/^(ba|z)?sh$/.test(words[i].split('/').pop()) && words[i + 1] === '-c' && words[i + 2]) {
        queue.push(...splitSegments(words[i + 2]));
      }
    }
    const gi = words.findIndex((w) => w === 'gh' || w.endsWith('/gh'));
    if (gi === -1) continue;
    const rest = words.slice(gi + 1);
    const isPrMerge = rest[0] === 'pr' && rest[1] === 'merge';
    const isApi = rest[0] === 'api';
    if (isPrMerge && rest.some((w) => w === '--admin' || w.startsWith('--admin='))) {
      return { permission: 'deny', message: MERGE_MESSAGES.admin };
    }
    if (isPrMerge) return { permission: 'deny', message: MERGE_MESSAGES.manual };
    if (isApi && rest.some((w) => /pulls\/\d+\/merge\b/.test(w))) {
      return { permission: 'deny', message: MERGE_MESSAGES.manual };
    }
    if (isApi && rest.some((w) => /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest/.test(w))) {
      return { permission: 'deny', message: MERGE_MESSAGES.manual };
    }
  }
  return { permission: 'allow' };
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }
  let input = null;
  try { input = raw.trim() ? JSON.parse(raw) : null; } catch { input = null; }
  const host = detectHost(input);
  let decision;
  try {
    decision = decideMerge(extractCommand(input));
  } catch {
    // Fail closed on the one rule that is never overridable.
    decision = /\bgh\b[\s\S]*\bmerge\b[\s\S]*--admin/.test(raw)
      ? { permission: 'deny', message: MERGE_MESSAGES.admin }
      : { permission: 'allow' };
  }
  const out = render(host, decision);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
