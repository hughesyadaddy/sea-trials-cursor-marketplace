#!/usr/bin/env node
/**
 * Pre-commit fixer for staged Dart (`flutter/**`) and web (`web/**`)
 * files: sea-trials-lint fix + dart format, prettier + eslint --fix,
 * re-stage, cspell, CRLF → LF. Runs from the checkout's `.husky/
 * pre-commit` via `sh .husky/st-plugin-run.sh precommit`.
 *
 * Ships in the sea-trials plugin; every path below is relative to the
 * checkout (`ST_REPO_ROOT`, else the git toplevel of cwd).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runAsync } from './lib/parallel.mjs';
import { getSeaTrialsLintCmd } from './lib/resolve-sea-trials-lint.mjs';
import { chunk } from './lib/flutter-packages.mjs';
import { isLintableDartPath } from './lib/artifact-paths.mjs';
import { resolveRepoRoot } from './lib/plugin-paths.mjs';

const isWindows = process.platform === 'win32';

const repoRoot = resolveRepoRoot();
// Staged paths are repo-relative; run every git/pnpm/fs step from the
// checkout root regardless of where the hook was invoked.
process.chdir(repoRoot);

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', shell: isWindows, ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '');
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? '').trim();
}

const staged = capture('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const stagedDartRepoPaths = staged.filter((p) => isLintableDartPath(p));
const stagedWebRepoPaths = staged.filter((p) => p.startsWith('web/') && /\.(ts|tsx|md)$/.test(p));
const stagedWebTsPaths = staged.filter((p) => p.startsWith('web/') && /\.(ts|tsx)$/.test(p));

const dartPaths = stagedDartRepoPaths.map((p) => p.slice('flutter/'.length));
const webPaths = stagedWebRepoPaths.map((p) => p.slice('web/'.length));

async function main() {
  // Phase 1: Parallel auto-fix (Dart domain || Web domain)
  const tasks = [];

  if (dartPaths.length > 0) {
    tasks.push({
      label: 'Dart: sea-trials-lint fix + dart format',
      run: async () => {
        // Step 1: sea-trials-lint fix
        let lintCmd;
        try {
          lintCmd = getSeaTrialsLintCmd(repoRoot);
        } catch {
          process.stderr.write('⚠️  sea-trials-lint not found, skipping Rust fixes.\n');
          lintCmd = null;
        }

        if (lintCmd) {
          const flutterRoot = path.join(repoRoot, 'flutter');
          const absDartPaths = dartPaths.map((p) => path.join(flutterRoot, p));
          for (const batch of chunk(absDartPaths, 50)) {
            if (batch.length === 0) continue;
            const lintResult = await runAsync(lintCmd[0], [
              'fix',
              '--root',
              flutterRoot,
              '--quiet',
              ...batch,
            ]);
            if (lintResult.code === 2) {
              process.stderr.write(`sea-trials-lint fix failed:\n${lintResult.stderr}\n`);
              return false;
            }
          }
        }

        // Step 2: dart format (sequential after fix).
        //
        // No `--line-length` flag: read `formatter.page_width: 80`
        // from `flutter/analysis_options.yaml` (same as CI and IDE).
        // Passing `--line-length` overrides the YAML and can reintroduce
        // wrap drift between format-on-save, hooks, and CI.
        for (const files of chunk(dartPaths, 50)) {
          if (files.length === 0) continue;
          const fmtResult = await runAsync('pnpm', [
            'dart', 'format', ...files,
          ]);
          if (fmtResult.code !== 0) {
            process.stderr.write(`dart format failed:\n${fmtResult.stderr}\n`);
            return false;
          }
        }
        return true;
      },
    });
  }

  if (webPaths.length > 0) {
    tasks.push({
      label: 'Web: prettier + eslint --fix',
      run: async () => {
        // Step 1: prettier --write (repo-root paths; prettier is hoisted here)
        for (const files of chunk(webPaths, 200)) {
          if (files.length === 0) continue;
          const result = await runAsync('pnpm', [
            'exec',
            'prettier',
            '--write',
            ...files.map((f) => `web/${f}`),
          ]);
          if (result.code !== 0) {
            process.stderr.write(`prettier failed:\n${result.stderr}\n`);
            return false;
          }
        }

        // Step 2: eslint --fix (sequential after prettier).
        // `--no-warn-ignored` keeps ESLint silent when a staged
        // file is matched by `.eslintignore` / config ignores
        // (e.g. `*.d.ts` declarations). Without it, the staged
        // path triggers an "ignored" warning that gets escalated
        // to an error by `--max-warnings 0`, blocking the commit
        // for files we explicitly chose not to lint.
        if (stagedWebTsPaths.length > 0) {
          for (const files of chunk(stagedWebTsPaths, 200)) {
            if (files.length === 0) continue;
            const result = await runAsync('pnpm', [
              'exec',
              'eslint',
              '--fix',
              '--no-warn-ignored',
              '--max-warnings',
              '0',
              ...files,
            ]);
            if (result.code !== 0) {
              process.stderr.write(`eslint --fix failed:\n${result.stderr}\n`);
              return false;
            }
          }
        }
        return true;
      },
    });
  }

  if (tasks.length > 0) {
    const results = await Promise.all(
      tasks.map(async (t) => {
        const ok = await t.run();
        process.stderr.write(ok ? `✅ ${t.label}\n` : `❌ ${t.label}\n`);
        return ok;
      }),
    );

    if (results.some((ok) => !ok)) {
      process.exit(1);
    }
  }

  // Phase 2: Re-stage all originally-staged files.
  //
  // `-f` is required because some intentionally-tracked files
  // live under `.gitignore`d paths (e.g., `web/scratch/audit/*.md`
  // — committed with `--force` and surfaced by `git diff --cached`,
  // but rejected by a vanilla `git add` due to the parent ignore
  // rule). Re-staging is a no-op for the index either way; the
  // only failure mode without `-f` is the ignored-but-tracked case,
  // which we explicitly want to accept here.
  const toRestage = [...stagedWebRepoPaths, ...stagedDartRepoPaths];
  for (const files of chunk(toRestage, 50)) {
    if (files.length === 0) continue;
    run('git', ['add', '-f', '--', ...files]);
  }

  // Phase 3: Spellcheck (sequential, check-only)
  const spellcheckPaths = staged.filter(
    (p) =>
      p.endsWith('.md') ||
      (p.endsWith('.dart') && isLintableDartPath(p)),
  );

  if (spellcheckPaths.length > 0) {
    for (const files of chunk(spellcheckPaths, 50)) {
      if (files.length === 0) continue;
      run('pnpm', [
        'exec',
        'cspell',
        'lint',
        '--config',
        '.vscode/cspell.json',
        '--no-progress',
        '--no-summary',
        '--no-must-find-files',
        ...files,
      ]);
    }
  }

  // Phase 4: Normalize line endings (CRLF → LF)
  // .gitattributes declares eol=lf for all text, but
  // git on Windows may check out CRLF when autocrlf is
  // set. Renormalize ALL staged text files so the
  // committed blobs always have LF regardless of
  // working-tree line endings.
  const textExtensions = new Set([
    '.dart',
    '.yaml',
    '.yml',
    '.json',
    '.js',
    '.mjs',
    '.ts',
    '.tsx',
    '.md',
    '.html',
    '.css',
    '.scss',
    '.xml',
    '.toml',
    '.rs',
    '.py',
    '.sh',
    '.bash',
    '.lock',
    '.arb',
    '.plist',
    '.gradle',
    '.properties',
    '.cmake',
    '.cc',
    '.h',
    '.swift',
    '.kt',
    '.m',
    '.mm',
    '.entitlements',
  ]);

  const textFiles = staged.filter((p) => {
    const ext = '.' + p.split('.').pop();
    return (
      textExtensions.has(ext) ||
      p.endsWith('Podfile') ||
      p.endsWith('Gemfile') ||
      p.endsWith('Makefile') ||
      p.endsWith('Dockerfile')
    );
  });

  const fixedCrlf = [];
  for (const filePath of textFiles) {
    try {
      const content = readFileSync(filePath, 'utf8');
      if (content.includes('\r\n') || content.includes('\r')) {
        const fixed = content.replace(/\r\n/g, '\n').replace(/\r/g, '');
        writeFileSync(filePath, fixed, 'utf8');
        fixedCrlf.push(filePath);
      }
    } catch {
      // File deleted or binary — skip
    }
  }

  if (fixedCrlf.length > 0) {
    process.stderr.write(`\n\x1b[33mFixed CRLF → LF in ${fixedCrlf.length} file(s)\x1b[0m\n`);
    for (const batch of chunk(fixedCrlf, 50)) {
      // `-f` for the same ignored-but-tracked reason as Phase 2.
      run('git', ['add', '-f', '--', ...batch]);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Pre-commit error: ${err.message}\n`);
  process.exit(2);
});
