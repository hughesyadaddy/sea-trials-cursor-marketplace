import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  hookCommands,
  parseFrontmatter,
  pluginRelativeScript,
  validateMarketplace,
} from './validate-manifests.mjs';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'validate-manifests.mjs',
);

/** @type {string[]} */
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @param {string} root
 * @param {string} rel
 * @param {unknown} value
 */
function writeJson(root, rel, value) {
  writeText(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} text
 */
function writeText(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** @returns {string} a fully valid marketplace fixture root */
function makeValidFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-manifests-'));
  tmpDirs.push(root);
  const plugins = [
    { name: 'demo', source: './plugins/demo', description: 'Demo plugin.' },
  ];
  writeJson(root, '.claude-plugin/marketplace.json', {
    name: 'demo-claude-marketplace',
    owner: { name: 'Demo' },
    plugins,
  });
  writeJson(root, '.cursor-plugin/marketplace.json', {
    name: 'demo-cursor-marketplace',
    owner: { name: 'Demo' },
    plugins,
  });
  const p = 'plugins/demo';
  writeJson(root, `${p}/.claude-plugin/plugin.json`, {
    name: 'demo',
    version: '1.0.0',
    description: 'Demo',
    skills: './skills/',
    agents: './agents/',
    hooks: './hooks/claude/hooks.json',
    mcpServers: './.mcp.json',
  });
  writeJson(root, `${p}/.cursor-plugin/plugin.json`, {
    name: 'demo',
    version: '1.0.0',
    description: 'Demo',
    skills: './skills/',
    agents: './agents/',
    hooks: './hooks/cursor/hooks.json',
    mcp: './mcp.json',
  });
  const mcp = {
    mcpServers: {
      remote: { type: 'http', url: 'https://example.com/mcp' },
      local: { command: 'npx', args: ['-y', 'demo-mcp'] },
    },
  };
  writeJson(root, `${p}/.mcp.json`, mcp);
  writeJson(root, `${p}/mcp.json`, mcp);
  writeJson(root, `${p}/hooks/claude/hooks.json`, {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/guard.sh',
            },
          ],
        },
      ],
    },
  });
  writeJson(root, `${p}/hooks/cursor/hooks.json`, {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: './hooks/scripts/guard.sh' }],
    },
  });
  writeText(root, `${p}/hooks/scripts/guard.sh`, '#!/usr/bin/env bash\n');
  writeText(
    root,
    `${p}/agents/helper.md`,
    '---\nname: helper\ndescription: Helps.\nmodel: inherit\n---\n\nBody\n',
  );
  writeText(
    root,
    `${p}/agents/nested/deep.md`,
    '---\nname: deep\ndescription: |\n  Multi-line.\n---\n\nBody\n',
  );
  writeText(
    root,
    `${p}/skills/st-demo/SKILL.md`,
    '---\nname: st-demo\ndescription: >-\n  Folded text.\n---\n\n# Demo\n',
  );
  writeText(root, `${p}/skills/_sources/shared.md`, '# not a skill\n');
  return root;
}

/**
 * @param {import('./validate-manifests.mjs').Issue[]} issues
 * @param {RegExp} pattern
 */
function assertIssue(issues, pattern) {
  const hit = issues.find((i) => pattern.test(`${i.file}: ${i.message}`));
  assert.ok(
    hit,
    `expected an issue matching ${pattern}, got:\n${issues
      .map((i) => `  ${i.file}: ${i.message}`)
      .join('\n')}`,
  );
}

describe('validate-manifests', () => {
  it('accepts a fully valid dual-host marketplace', () => {
    const root = makeValidFixture();
    assert.deepEqual(validateMarketplace(root), []);
  });

  it('validates the real marketplace in this repo', () => {
    const repoRoot = path.resolve(path.dirname(script), '..');
    const issues = validateMarketplace(repoRoot);
    assert.deepEqual(issues, []);
  });

  it('reports invalid JSON and missing marketplace files', () => {
    const root = makeValidFixture();
    writeText(root, '.claude-plugin/marketplace.json', '{ nope');
    fs.rmSync(path.join(root, '.cursor-plugin/marketplace.json'));
    const issues = validateMarketplace(root);
    assertIssue(issues, /\.claude-plugin\/marketplace\.json: invalid JSON/);
    assertIssue(issues, /\.cursor-plugin\/marketplace\.json: missing file/);
  });

  it('reports version and name drift between host manifests', () => {
    const root = makeValidFixture();
    writeJson(root, 'plugins/demo/.cursor-plugin/plugin.json', {
      name: 'demo-renamed',
      version: '2.0.0',
      description: 'Demo',
    });
    const issues = validateMarketplace(root);
    assertIssue(issues, /name "demo" != cursor name "demo-renamed"/);
    assertIssue(issues, /version "1\.0\.0" != cursor version "2\.0\.0"/);
    assertIssue(
      issues,
      /cursor-plugin\/marketplace\.json: no entry for plugin "demo-renamed"/,
    );
  });

  it('reports marketplace entries whose source is wrong or missing', () => {
    const root = makeValidFixture();
    writeJson(root, '.claude-plugin/marketplace.json', {
      name: 'm',
      plugins: [
        { name: 'demo', source: './plugins/elsewhere' },
        { name: 'ghost', source: './plugins/ghost' },
      ],
    });
    const issues = validateMarketplace(root);
    assertIssue(
      issues,
      /"demo" source \.\/plugins\/elsewhere != plugins\/demo/,
    );
    assertIssue(
      issues,
      /plugins\[1\] source does not exist: \.\/plugins\/ghost/,
    );
    assertIssue(issues, /plugins\[0\] source does not exist/);
  });

  it('reports component paths that are non-relative or missing', () => {
    const root = makeValidFixture();
    writeJson(root, 'plugins/demo/.claude-plugin/plugin.json', {
      name: 'demo',
      version: '1.0.0',
      description: 'Demo',
      skills: 'skills/',
      agents: './nope/',
      hooks: ['./hooks/claude/hooks.json', './hooks/missing.json'],
    });
    const issues = validateMarketplace(root);
    assertIssue(issues, /`skills` path must start with \.\/ : skills\//);
    assertIssue(issues, /`agents` path does not exist: \.\/nope\//);
    assertIssue(
      issues,
      /`hooks` path does not exist: \.\/hooks\/missing\.json/,
    );
  });

  it('reports url MCP servers without a transport type', () => {
    const root = makeValidFixture();
    writeJson(root, 'plugins/demo/.mcp.json', {
      mcpServers: {
        atlassian: { url: 'https://mcp.example.com' },
        broken: { args: [] },
        sse: { type: 'sse', url: 'https://x' },
      },
    });
    const issues = validateMarketplace(root);
    assertIssue(issues, /\.mcp\.json: server "atlassian" has url but no type/);
    assertIssue(issues, /server "broken" needs `command` or `url`/);
    assert.ok(!issues.some((i) => /server "sse"/.test(i.message)));
    writeJson(root, 'plugins/demo/mcp.json', { servers: {} });
    assertIssue(validateMarketplace(root), /mcp\.json: missing `mcpServers`/);
  });

  it('reports hook scripts that do not exist on disk', () => {
    const root = makeValidFixture();
    fs.rmSync(path.join(root, 'plugins/demo/hooks/scripts/guard.sh'));
    const issues = validateMarketplace(root);
    const hookIssues = issues.filter((i) =>
      /hook script does not exist/.test(i.message),
    );
    assert.equal(hookIssues.length, 2);
    assert.ok(
      hookIssues.every((i) => /hooks\/scripts\/guard\.sh/.test(i.message)),
    );
  });

  it('reports agents and skills without name + description', () => {
    const root = makeValidFixture();
    writeText(root, 'plugins/demo/agents/bare.md', '# No frontmatter\n');
    writeText(
      root,
      'plugins/demo/skills/st-empty/SKILL.md',
      '---\nname: st-empty\ndescription:\n---\n',
    );
    const issues = validateMarketplace(root);
    assertIssue(issues, /agents\/bare\.md: missing YAML frontmatter/);
    assertIssue(
      issues,
      /st-empty\/SKILL\.md: frontmatter missing `description`/,
    );
    assert.ok(!issues.some((i) => /_sources/.test(i.file)));
  });

  it('parses frontmatter scalars and block scalars', () => {
    assert.equal(parseFrontmatter('no frontmatter'), null);
    assert.equal(parseFrontmatter('---\nname: x\n'), null);
    const keys = parseFrontmatter(
      '---\nname: a\ndescription: >-\n  folded\nempty:\nblock: |\n---\n',
    );
    assert.deepEqual([...keys].sort(), ['description', 'name']);
    assert.deepEqual(
      [...parseFrontmatter('\uFEFF---\r\nname: bom\r\n---\r\n')],
      ['name'],
    );
  });

  it('extracts plugin-relative scripts from hook commands', () => {
    assert.equal(
      pluginRelativeScript('bash ${CLAUDE_PLUGIN_ROOT}/hooks/a.sh'),
      'hooks/a.sh',
    );
    assert.equal(pluginRelativeScript('./hooks/b.sh --flag'), 'hooks/b.sh');
    assert.equal(pluginRelativeScript('echo hi'), null);
    assert.deepEqual(
      hookCommands({
        PreToolUse: [{ hooks: [{ command: 'a' }, { command: 'b' }] }],
        stop: [{ command: 'c' }],
        junk: 'ignored',
      }),
      ['a', 'b', 'c'],
    );
  });

  it('CLI exits 1 with a readable list, 0 when clean', () => {
    const root = makeValidFixture();
    const clean = spawnSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8',
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /validate-manifests: OK/);

    writeJson(root, 'plugins/demo/mcp.json', {
      mcpServers: { r: { url: 'https://x' } },
    });
    const dirty = spawnSync(process.execPath, [script, `--root=${root}`], {
      encoding: 'utf8',
    });
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /1 issue\(s\)/);
    assert.match(dirty.stderr, /plugins\/demo\/mcp\.json: server "r" has url/);
  });
});
