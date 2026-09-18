import fs from 'node:fs';
import path from 'node:path';

export const defaultArbFiles = ['app_en.arb', 'app_es.arb', 'app_hi.arb'];

export function l10nArbDirAbs(repoRoot) {
  return path.join(repoRoot, 'flutter/packages/l10n/lib/src/arb');
}

export function flutterRootAbs(repoRoot) {
  return path.join(repoRoot, 'flutter');
}

export function loadArbKeys(arbPath) {
  const raw = JSON.parse(fs.readFileSync(arbPath, 'utf8'));
  return Object.keys(raw).filter(
    (k) => !k.startsWith('@') && k !== '@@locale',
  );
}

export function collectDartFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '.dart_tool' ||
        entry.name === 'build' ||
        entry.name === '.pub-cache'
      ) {
        continue;
      }
      collectDartFiles(full, out);
    } else if (
      entry.name.endsWith('.dart') &&
      !entry.name.startsWith('app_localizations')
    ) {
      out.push(full);
    }
  }
  return out;
}

export function buildDartCorpus(files) {
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isKeyUsed(key, corpus) {
  const memberAccess = `\\s*\\.\\s*${escapeRegExp(key)}\\b`;
  const patterns = [
    new RegExp(`\\.\\s*l10n${memberAccess}`),
    new RegExp(`\\bl10n${memberAccess}`),
    new RegExp(
      `\\bAppLocalizations(?:\\s*\\.\\s*of\\s*\\([^)]*\\))?` +
        memberAccess,
    ),
  ];
  return patterns.some((re) => re.test(corpus));
}

export function auditUnusedL10n(repoRoot) {
  const arbDir = l10nArbDirAbs(repoRoot);
  const enPath = path.join(arbDir, 'app_en.arb');
  const allKeys = loadArbKeys(enPath);
  const dartFiles = collectDartFiles(flutterRootAbs(repoRoot));
  const corpus = buildDartCorpus(dartFiles);

  const unused = [];
  const used = [];

  for (const key of allKeys) {
    if (isKeyUsed(key, corpus)) {
      used.push(key);
    } else {
      unused.push(key);
    }
  }

  unused.sort();
  used.sort();

  return {
    allKeys,
    used,
    unused,
    dartFileCount: dartFiles.length,
  };
}

export function removeKeysFromArb(arbPath, keysToRemove) {
  const raw = JSON.parse(fs.readFileSync(arbPath, 'utf8'));
  let removed = 0;
  for (const key of keysToRemove) {
    if (key in raw) {
      delete raw[key];
      removed++;
    }
    const metaKey = `@${key}`;
    if (metaKey in raw) {
      delete raw[metaKey];
    }
  }
  fs.writeFileSync(arbPath, `${JSON.stringify(raw, null, 2)}\n`);
  return removed;
}

export function writeAuditReport(repoRoot, audit, reportPath) {
  const { allKeys, used, unused, dartFileCount } = audit;
  const report = `# Unused l10n keys audit

Date: ${new Date().toISOString().slice(0, 10)}

## Summary

| Metric | Count |
| --- | ---: |
| Total keys (app_en.arb) | ${allKeys.length} |
| Used in Dart | ${used.length} |
| Unused | ${unused.length} |
| Dart files scanned | ${dartFileCount} |

## Method

- Source of truth: \`app_en.arb\` keys (excluding \`@\` metadata)
- Scan: all \`.dart\` files under \`flutter/\`, excluding generated
  \`app_localizations*.dart\`
- A key is **used** if referenced as \`l10n.<key>\`, \`.l10n.<key>\`, or
  \`AppLocalizations.<key>\` anywhere in that corpus
- Keys with **zero** references are listed below for removal

## Unused keys (${unused.length})

${unused.map((k) => `- \`${k}\``).join('\n')}
`;

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
}

export function applyUnusedKeyRemoval(repoRoot, unused, arbFiles = defaultArbFiles) {
  const arbDir = l10nArbDirAbs(repoRoot);
  const results = [];
  for (const arbFile of arbFiles) {
    const arbPath = path.join(arbDir, arbFile);
    const removed = removeKeysFromArb(arbPath, unused);
    results.push({ arbFile, removed });
  }
  return results;
}
