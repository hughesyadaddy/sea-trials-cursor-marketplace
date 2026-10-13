/**
 * Block rich-content / explanations / xmedia / question-tagging / RAG work
 * from being promoted into stg or main.
 *
 * Policy (denylist, prefixes, name pattern) lives in the app repo as JSON;
 * this module implements diff + classification only.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{
 *   version: number,
 *   forbiddenNamePattern: string,
 *   denylist: string[],
 *   forbiddenPrefixes: string[],
 *   sqlDirs: string[],
 * }} PromotionPolicy
 */

/**
 * @param {PromotionPolicy} policy
 * @returns {RegExp}
 */
export function forbiddenNameRegex(policy) {
  return new RegExp(policy.forbiddenNamePattern, 'i');
}

/**
 * @param {string} filePath
 * @param {PromotionPolicy} policy
 * @returns {string | null}
 */
export function violation(filePath, policy) {
  const base = filePath.includes('/')
    ? filePath.slice(filePath.lastIndexOf('/') + 1)
    : filePath;
  const deny = new Set(policy.denylist);
  const nameRx = forbiddenNameRegex(policy);
  for (const dir of policy.sqlDirs) {
    if (filePath.startsWith(dir)) {
      if (deny.has(base)) {
        return 'denylisted migration';
      }
      if (nameRx.test(base)) {
        return 'migration/template name matches forbidden work pattern';
      }
    }
  }
  for (const prefix of policy.forbiddenPrefixes) {
    if (filePath.startsWith(prefix)) {
      return `path under forbidden prefix ${prefix}`;
    }
  }
  return null;
}

/**
 * @param {string} text git name-status output
 * @returns {string[]}
 */
export function pathsFromNameStatus(text) {
  /** @type {Set<string>} */
  const paths = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status === 'D') continue;
    if (status.startsWith('R') && parts.length >= 3) {
      paths.add(parts[1]);
      paths.add(parts[2]);
    } else if (parts.length >= 2) {
      paths.add(parts[parts.length - 1]);
    }
  }
  return [...paths];
}

/**
 * @param {string} base
 * @param {string} head
 * @param {{ cwd?: string }} [opts]
 * @returns {string[]}
 */
export function changedPaths(base, head, opts = {}) {
  const r = spawnSync(
    'git',
    [
      'diff',
      '--name-status',
      '--diff-filter=ACMR',
      '-M',
      `${base}...${head}`,
    ],
    { cwd: opts.cwd, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(
      `git diff failed: ${(r.stderr ?? r.stdout ?? '').trim()}`,
    );
  }
  return pathsFromNameStatus(r.stdout ?? '').sort();
}

/**
 * @param {string} policyPath absolute or cwd-relative JSON path
 * @param {{ cwd?: string }} [opts]
 * @returns {PromotionPolicy}
 */
export function loadPolicy(policyPath, opts = {}) {
  const abs = path.isAbsolute(policyPath)
    ? policyPath
    : path.join(opts.cwd ?? process.cwd(), policyPath);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (raw.version !== 1) {
    throw new Error(`unsupported policy version: ${raw.version}`);
  }
  return /** @type {PromotionPolicy} */ (raw);
}

/**
 * @param {string} base
 * @param {string} head
 * @param {PromotionPolicy} policy
 * @param {{ cwd?: string }} [opts]
 * @returns {{ ok: true } | { ok: false, hits: Array<[string, string]> }}
 */
export function checkPromotionDiff(base, head, policy, opts = {}) {
  const files = changedPaths(base, head, opts);
  /** @type {Array<[string, string]>} */
  const hits = [];
  for (const f of files) {
    const why = violation(f, policy);
    if (why) hits.push([f, why]);
  }
  if (hits.length) return { ok: false, hits };
  return { ok: true };
}

/** @returns {number} exit code */
export function runSelfTest() {
  const policy = {
    version: 1,
    forbiddenNamePattern:
      '(xmedia|question_explanations?(_|\\.|$)|explanation_v2|explanation_view' +
      '|backfill_question_explanations|sea_content|rich_content|richcontent' +
      '|content_references|reference_rag|rag_chunks|rag_citation|_citations?(_|\\.)' +
      '|question_tag|question_tagging|tagging_|_tagging|hint_blocks|hint_xmedia' +
      '|explanation_blocks|blogs_body)',
    denylist: ['20261013002842_question_explanations_xmedia.sql'],
    forbiddenPrefixes: ['scripts/reference_rag/'],
    sqlDirs: ['supabase/migrations/', 'supabase/templates/'],
  };
  let ok = true;
  const deletedForbidden =
    'D\tsupabase/migrations/20261013002842_question_explanations_xmedia.sql';
  if (pathsFromNameStatus(deletedForbidden).length) {
    process.stderr.write('SELF-TEST FAIL (pure deletion should be ignored)\n');
    ok = false;
  }
  const bad = [
    'supabase/migrations/20261013002842_question_explanations_xmedia.sql',
    'supabase/migrations/20990101000000_question_tagging_v2.sql',
    'scripts/reference_rag/src/x.py',
  ];
  const good = [
    'supabase/migrations/20260424120000_add_users_hint_explanation_tracking_v2.sql',
    'supabase/migrations/20261013120000_dedupe_anchor_threads.sql',
    'flutter/apps/client_app/lib/main.dart',
  ];
  const renameLines =
    'R100\tsupabase/migrations/20261013002842_question_explanations_xmedia.sql' +
    '\tsupabase/migrations/20261013120000_dedupe_anchor_threads.sql\n';
  const renamePaths = pathsFromNameStatus(renameLines);
  const renameSrc =
    'supabase/migrations/20261013002842_question_explanations_xmedia.sql';
  const renameDest =
    'supabase/migrations/20261013120000_dedupe_anchor_threads.sql';
  if (!renamePaths.includes(renameSrc)) {
    process.stderr.write(`SELF-TEST FAIL (rename source missing): ${renameSrc}\n`);
    ok = false;
  }
  if (!renamePaths.includes(renameDest)) {
    process.stderr.write(`SELF-TEST FAIL (rename dest missing): ${renameDest}\n`);
    ok = false;
  }
  if (!violation(renameSrc, policy)) {
    process.stderr.write(`SELF-TEST FAIL (rename source should flag): ${renameSrc}\n`);
    ok = false;
  }
  if (violation(renameDest, policy)) {
    process.stderr.write(
      `SELF-TEST FAIL (rename dest false positive): ${renameDest}\n`,
    );
    ok = false;
  }
  for (const b of bad) {
    if (!violation(b, policy)) {
      process.stderr.write(`SELF-TEST FAIL (should flag): ${b}\n`);
      ok = false;
    }
  }
  for (const g of good) {
    const v = violation(g, policy);
    if (v) {
      process.stderr.write(`SELF-TEST FAIL (false positive): ${g} ${v}\n`);
      ok = false;
    }
  }
  process.stdout.write(`self-test ${ok ? 'passed' : 'FAILED'}\n`);
  return ok ? 0 : 1;
}
