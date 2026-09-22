import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  contentHash,
  diffAgainstState,
  extractFiles,
  lintSprint,
  loadSprint,
  parseStory,
  storyIdFromFile,
} from './parse-sprint-folder.mjs';

/** Write `files` ({ name: content }) into a fresh temp sprint folder. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-'));
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const AC = '## Acceptance criteria\n\n- [ ] Works\n';

/** A clean, lint-free story with one subtask. */
function cleanStory(title = 'Clean story', sub = '1.1') {
  return (
    `# ${title}\n\n**Jira:** STD-1 | **SP:** 3\n\nGoal text.\n\n${AC}\n` +
    `## Subtask ${sub}: Do the thing\n\n**SP:** 1\n\n- [ ] Step one\n`
  );
}

const EPIC = '# Epic: Reinstall parity\n\nEpic body.\n';

// ===========================================================================
// FILENAMES
// ===========================================================================

test('storyIdFromFile handles usN, usNletter, sub-letter, legacy', () => {
  assert.equal(storyIdFromFile('01-us1-boot-page.md'), '1');
  assert.equal(storyIdFromFile('03-us3a-toggle.md'), '3a');
  assert.equal(storyIdFromFile('02-b-us12-x.md'), '12');
  assert.equal(storyIdFromFile('04-US4-caps.md'), '4');
  assert.equal(storyIdFromFile('07_legacy_slug.md'), '07');
  assert.equal(storyIdFromFile('00-epic.md'), null);
  assert.equal(storyIdFromFile('00_epic_overview.md'), null);
  assert.equal(storyIdFromFile('00-epic-reinstall.md'), null);
  assert.equal(storyIdFromFile('README.md'), null);
  assert.equal(storyIdFromFile('sprint.json'), null);
});

test('loadSprint picks epic, stories in order, config and state', () => {
  const dir = fixture({
    '00-epic-reinstall.md': EPIC,
    '01-us1-boot.md': cleanStory('Boot'),
    '02-us2-toggle.md': cleanStory('Toggle', '2.1'),
    '05_legacy.md': cleanStory('Legacy', '5.1'),
    'notes.md': '# not a story',
    'sprint.json': { jira: { projectKey: 'STD' }, labels: ['x'] },
    'jira_state.json': { epic: { key: 'STD-1', hash: 'h' }, stories: {} },
  });
  const sprint = loadSprint(dir);
  assert.equal(sprint.dir, dir);
  assert.equal(sprint.epic.summary, 'Reinstall parity');
  assert.equal(sprint.epic.description, 'Epic body.');
  assert.equal(sprint.epic.file, '00-epic-reinstall.md');
  assert.deepEqual(
    sprint.stories.map((s) => [s.id, s.file, s.summary]),
    [
      ['1', '01-us1-boot.md', 'Boot'],
      ['2', '02-us2-toggle.md', 'Toggle'],
      ['05', '05_legacy.md', 'Legacy'],
    ],
  );
  assert.deepEqual(sprint.config, {
    jira: { projectKey: 'STD' },
    labels: ['x'],
  });
  assert.equal(sprint.state.epic.key, 'STD-1');
});

test('loadSprint without epic/config/state uses safe defaults', () => {
  const dir = fixture({ '01-us1-a.md': cleanStory() });
  const sprint = loadSprint(dir);
  assert.equal(sprint.epic, null);
  assert.deepEqual(sprint.config, {});
  assert.deepEqual(sprint.state, { stories: {} });
});

// ===========================================================================
// METADATA
// ===========================================================================

test('story metadata is parsed and excluded from the description', () => {
  const story = parseStory(
    [
      '# US3: Title here',
      '',
      '**Jira:** STD-2002 | **SP:** 5',
      '**Blocked by:** US3, US4',
      '**Labels:** mobile, boot',
      '**Assignee:** alex',
      '',
      'Description **bold**.',
      '',
      AC,
    ].join('\n'),
    { id: '3', file: '03-us3-x.md' },
  );
  assert.equal(story.summary, 'US3: Title here');
  assert.equal(story.jiraKey, 'STD-2002');
  assert.equal(story.storyPoints, 5);
  assert.deepEqual(story.blockedBy, ['3', '4']);
  assert.deepEqual(story.labels, ['mobile', 'boot']);
  assert.equal(story.assignee, 'alex');
  assert.equal(story.description.includes('**Jira:**'), false);
  assert.equal(story.description.includes('**SP:**'), false);
  assert.ok(story.description.startsWith('Description **bold**.'));
});

test('story without metadata keeps nulls and empty arrays', () => {
  const story = parseStory(`# T\n\nBody\n\n${AC}`, { id: '1', file: 'f.md' });
  assert.equal(story.jiraKey, null);
  assert.equal(story.storyPoints, null);
  assert.deepEqual(story.blockedBy, []);
  assert.deepEqual(story.labels, []);
  assert.equal(story.assignee, null);
  assert.equal(story.description, `Body\n\n${AC.trim()}`);
});

test('a bold line that is not metadata stays in the description', () => {
  const story = parseStory('# T\n\n**Goal:** ship it\n\n' + AC, {
    id: '1',
    file: 'f.md',
  });
  assert.ok(story.description.startsWith('**Goal:** ship it'));
});

test('missing H1 falls back to the filename slug', () => {
  const story = parseStory('Body only', { id: '2', file: '02-us2-my-slug.md' });
  assert.equal(story.summary, 'my slug');
});

// ===========================================================================
// KIND / FILES
// ===========================================================================

test('**Kind:** metadata is parsed, lower-cased, defaults to null', () => {
  const withKind = parseStory(`# T\n\n**SP:** 2 | **Kind:** Verify\n\n${AC}`, {
    id: '1',
    file: 'f.md',
  });
  assert.equal(withKind.kind, 'verify');
  assert.equal(withKind.description.includes('Kind'), false);
  const noKind = parseStory(`# T\n\n${AC}`, { id: '1', file: 'f.md' });
  assert.equal(noKind.kind, null);
});

test('extractFiles reads heading and bold-label file sections', () => {
  const md = [
    '## Files to touch',
    '',
    '- `flutter/apps/client_app/lib/a.dart` - edit',
    '- `flutter/apps/client_app/lib/b.dart` - new; holds X',
    '- web/apps/site/src/page.ts (plain path)',
    '- Not a path at all',
    '- `flutter/apps/client_app/lib/a.dart` - duplicate',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] `not/a/file.dart` is not in a files section',
    '',
    '**Files to change**',
    '',
    '1. `supabase/migrations/001_x.sql`',
    '',
    '**Acceptance criteria**',
    '',
    '- [ ] `ignored/too.dart`',
    '',
    '```md',
    '## Files',
    '- `fenced/skip.dart`',
    '```',
  ].join('\n');
  assert.deepEqual(extractFiles(md), [
    'flutter/apps/client_app/lib/a.dart',
    'flutter/apps/client_app/lib/b.dart',
    'web/apps/site/src/page.ts',
    'supabase/migrations/001_x.sql',
  ]);
  assert.deepEqual(extractFiles('no sections here'), []);
});

test('story and subtask expose files from their own sections', () => {
  const story = parseStory(
    [
      '# T',
      '',
      '## Files to touch',
      '',
      '- `lib/story.dart` - x',
      '',
      AC,
      '## Subtasks',
      '',
      '### Subtask 1.1: A',
      '',
      '**Files to change**',
      '',
      '- `lib/sub.dart` - y',
      '',
      '**Acceptance criteria**',
      '',
      '- [ ] z',
    ].join('\n'),
    { id: '1', file: 'f.md' },
  );
  assert.deepEqual(story.files, ['lib/story.dart']);
  assert.deepEqual(story.subtasks[0].files, ['lib/sub.dart']);
});

// ===========================================================================
// SUBTASKS
// ===========================================================================

test('## Subtask headers split subtasks and stop the description', () => {
  const story = parseStory(
    [
      '# T',
      '',
      'Desc.',
      '',
      AC,
      '## Subtask 1.1: First',
      '',
      '**SP:** 2 | **Blocked by:** 1.0',
      '',
      '- [ ] a',
      '',
      '### Details',
      'more',
      '',
      '## Subtask 1.2a: Second',
      '',
      '- [ ] b',
      '',
      '## Notes',
      '',
      'trailing',
    ].join('\n'),
    { id: '1', file: 'f.md' },
  );
  assert.equal(story.subtasks.length, 2);
  const [a, b] = story.subtasks;
  assert.equal(a.id, '1.1');
  assert.equal(a.title, 'First');
  assert.equal(a.summary, 'First');
  assert.equal(a.storyPoints, 2);
  assert.deepEqual(a.blockedBy, ['1.0']);
  assert.equal(a.description, '- [ ] a\n\n### Details\nmore');
  assert.equal(b.id, '1.2a');
  assert.equal(b.description, '- [ ] b');
  assert.equal(b.storyPoints, null);
  assert.ok(story.description.includes('Desc.'));
  assert.ok(story.description.includes('## Notes\n\ntrailing'));
  assert.equal(story.description.includes('Subtask'), false);
});

test('### Subtask headers under ## Subtasks are split too', () => {
  const story = parseStory(
    [
      '# T',
      '',
      AC,
      '## Subtasks',
      '',
      'intro that is dropped',
      '',
      '### Subtask 2.1: Alpha',
      '- [ ] a',
      '',
      '### Subtask 2.2: Beta',
      '**SP:** 1',
      '- [ ] b',
    ].join('\n'),
    { id: '2', file: 'f.md' },
  );
  assert.deepEqual(
    story.subtasks.map((s) => [s.id, s.summary, s.description, s.storyPoints]),
    [
      ['2.1', 'Alpha', '- [ ] a', null],
      ['2.2', 'Beta', '- [ ] b', 1],
    ],
  );
  assert.equal(story.description.includes('Subtasks'), false);
  assert.equal(story.description.includes('intro'), false);
});

test('subtask headers inside fenced code are ignored', () => {
  const story = parseStory(
    `# T\n\n${AC}\n\`\`\`md\n## Subtask 9.9: fake\n\`\`\`\n\n## Subtask 1.1: Real\n- [ ] x`,
    { id: '1', file: 'f.md' },
  );
  assert.deepEqual(
    story.subtasks.map((s) => s.id),
    ['1.1'],
  );
  assert.ok(story.description.includes('## Subtask 9.9: fake'));
});

// ===========================================================================
// HASHING / DIFF
// ===========================================================================

test('contentHash is stable across CRLF and surrounding whitespace', () => {
  const a = contentHash('# T\n\nbody\n');
  assert.equal(a, contentHash('\n# T\r\n\r\nbody\r\n\n'));
  assert.notEqual(a, contentHash('# T\n\nbody!'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('diffAgainstState buckets epic, stories and subtasks', () => {
  const changed = cleanStory('Changed', '2.1');
  const same = cleanStory('Same', '3.1');
  const dir = fixture({
    '00-epic.md': EPIC,
    '01-us1-new.md': cleanStory('New'),
    '02-us2-changed.md': changed,
    '03-us3-same.md': same,
  });
  const probe = loadSprint(dir);
  const sameStory = probe.stories.find((s) => s.id === '3');
  const changedStory = probe.stories.find((s) => s.id === '2');
  fs.writeFileSync(
    path.join(dir, 'jira_state.json'),
    JSON.stringify({
      epic: { key: 'STD-1', hash: probe.epic.hash },
      stories: {
        2: {
          key: 'STD-20',
          hash: 'stale',
          subtasks: { '2.1': { key: 'STD-21', hash: 'stale' } },
        },
        3: {
          key: 'STD-30',
          hash: sameStory.hash,
          subtasks: {
            '3.1': { key: 'STD-31', hash: sameStory.subtasks[0].hash },
          },
        },
      },
    }),
  );
  const diff = diffAgainstState(loadSprint(dir));
  assert.deepEqual(diff.create, [
    { kind: 'story', id: '1', summary: 'New' },
    { kind: 'subtask', id: '1.1', storyId: '1', summary: 'Do the thing' },
  ]);
  assert.deepEqual(diff.update, [
    { kind: 'story', id: '2', summary: 'Changed', key: 'STD-20' },
    {
      kind: 'subtask',
      id: '2.1',
      storyId: '2',
      summary: 'Do the thing',
      key: 'STD-21',
    },
  ]);
  assert.deepEqual(
    diff.unchanged.map((e) => [e.kind, e.id, e.key]),
    [
      ['epic', 'epic', 'STD-1'],
      ['story', '3', 'STD-30'],
      ['subtask', '3.1', 'STD-31'],
    ],
  );
  assert.equal(changedStory.hash !== 'stale', true);
});

// ===========================================================================
// LINT
// ===========================================================================

function lintOf(files) {
  return lintSprint(loadSprint(fixture(files)));
}

function messages(findings, level) {
  return findings.filter((f) => f.level === level).map((f) => f.message);
}

test('clean sprint has no findings', () => {
  const findings = lintOf({
    '00-epic.md': EPIC,
    '01-us1-a.md': cleanStory(),
  });
  assert.deepEqual(findings, []);
});

test('error: missing acceptance criteria or no open item', () => {
  const missing = lintOf({
    '01-us1-a.md': '# T\n\nBody\n\n## Subtask 1.1: S\n- [ ] x\n',
  });
  assert.ok(
    messages(missing, 'error').some((m) => m.includes('missing "## Acceptance')),
  );
  const empty = lintOf({
    '01-us1-a.md':
      '# T\n\n## AC\n\n- [x] done only\n\n## Subtask 1.1: S\n- [ ] x\n',
  });
  assert.ok(
    messages(empty, 'error').some((m) => m.includes('no "- [ ]" item')),
  );
  const okCaps = lintOf({
    '01-us1-a.md':
      '# T\n\n## Acceptance Criteria\n\n- [ ] ok\n\n## Subtask 1.1: S\n- [ ] x\n',
  });
  assert.deepEqual(messages(okCaps, 'error'), []);
});

test('error: subtask without an open task item', () => {
  const findings = lintOf({
    '01-us1-a.md': `# T\n\n${AC}\n## Subtask 1.1: S\n\nJust prose.\n`,
  });
  assert.deepEqual(messages(findings, 'error'), [
    'subtask has no "- [ ]" item',
  ]);
  assert.equal(findings[0].where, 'story 1 (01-us1-a.md) subtask 1.1');
});

test('error: links to markdown files and doc paths', () => {
  const findings = lintOf({
    '01-us1-a.md':
      `# T\n\nSee [plan](docs/plan/x.md) and docs/plan/2026-01-01-y.md\n` +
      `and [ok link](https://example.com/page) and README.md alone\n\n${AC}` +
      '## Subtask 1.1: S\n- [ ] x\n',
  });
  const errs = messages(findings, 'error');
  assert.equal(errs.filter((m) => m.includes('markdown file')).length, 1);
  assert.ok(errs[0].includes('line 1'));
  const clean = lintOf({
    '01-us1-a.md':
      `# T\n\nRun \`flutter test\` and see https://x.y/README\n\n${AC}` +
      '## Subtask 1.1: S\n- [ ] x\n',
  });
  assert.deepEqual(messages(clean, 'error'), []);
});

test('error: vague / non-actionable phrases', () => {
  const body = [
    'Maybe do X.',
    'Consider Y.',
    'We might want to Z.',
    'Explore whether A.',
    'Investigate if B.',
    'Field: TBD',
    'TODO: fix',
    'Look into C.',
    '- [ ] Research D',
    '- [ ] Researching is a noun-ish line that still starts a task',
  ].join('\n');
  const findings = lintOf({
    '01-us1-a.md': `# T\n\n${body}\n\n${AC}\n## Subtask 1.1: S\n- [ ] x\n`,
  });
  const labels = messages(findings, 'error')
    .filter((m) => m.includes('non-actionable'))
    .map((m) => /"([^"]+)"/.exec(m)[1]);
  assert.deepEqual(labels, [
    'maybe',
    'consider',
    'might want to',
    'explore whether',
    'investigate if',
    'TBD',
    'TODO:',
    'look into',
    'Research (task item)',
  ]);
  const clean = lintOf({
    '01-us1-a.md':
      `# T\n\nThe research repository lists todos. Tbd is a word.\n\n${AC}` +
      '## Subtask 1.1: S\n- [ ] x\n',
  });
  assert.deepEqual(messages(clean, 'error'), []);
});

test('error: vague words inside fenced code are ignored', () => {
  const findings = lintOf({
    '01-us1-a.md':
      `# T\n\n\`\`\`dart\n// TODO: maybe consider\n\`\`\`\n\n${AC}` +
      '## Subtask 1.1: S\n- [ ] x\n',
  });
  assert.deepEqual(messages(findings, 'error'), []);
});

test('error: AI tells anywhere in card text', () => {
  const body = [
    'Ask Claude.',
    'Open in Cursor.',
    'ChatGPT said so.',
    'Copilot suggestion.',
    'As an AI, I cannot.',
    'Use an LLM.',
    'Spawn a subagent.',
    'Task({ prompt })',
  ].join('\n');
  const findings = lintOf({
    '00-epic.md': `# Epic\n\n${body}\n`,
    '01-us1-a.md': cleanStory(),
  });
  const labels = messages(findings, 'error')
    .filter((m) => m.includes('AI tell'))
    .map((m) => /"([^"]+)"/.exec(m)[1]);
  assert.deepEqual(labels, [
    'Claude',
    'Cursor',
    'ChatGPT',
    'Copilot',
    'As an AI',
    'LLM',
    'subagent',
    'Task(',
  ]);
  assert.ok(findings.every((f) => f.where.startsWith('epic')));
  const clean = lintOf({
    '01-us1-a.md':
      `# T\n\nMove the text cursor; a copilot seat; Task(1) is fine? no.\n\n` +
      `${AC}## Subtask 1.1: S\n- [ ] x\n`,
  });
  assert.deepEqual(
    messages(clean, 'error').map((m) => /"([^"]+)"/.exec(m)[1]),
    ['Task('],
  );
});

test('warn: long task item, deep heading, long description', () => {
  const long = 'x'.repeat(201);
  const findings = lintOf({
    '01-us1-a.md':
      `# T\n\n${'lorem '.repeat(1100)}\n\n${AC}` +
      `## Subtask 1.1: S\n\n#### Too deep\n\n- [ ] ${long}\n`,
  });
  const warns = messages(findings, 'warn');
  assert.ok(warns.some((m) => m.includes('task item is 201 chars')));
  assert.ok(warns.some((m) => m.includes('heading deeper than H3')));
  assert.ok(warns.some((m) => m.includes('description is')));
  assert.deepEqual(messages(findings, 'error'), []);
});

test('warn: zero subtasks and missing subtask SP', () => {
  const none = lintOf({ '01-us1-a.md': `# T\n\n**SP:** 3\n\n${AC}` });
  assert.deepEqual(messages(none, 'warn'), ['story has no subtasks']);

  const noSp = lintOf({
    '01-us1-a.md':
      `# T\n\n**SP:** 3\n\n${AC}## Subtask 1.1: S\n- [ ] x\n`,
  });
  assert.deepEqual(messages(noSp, 'warn'), [
    'subtask has no **SP:** while the story has SP',
  ]);

  const storyNoSp = lintOf({
    '01-us1-a.md': `# T\n\n${AC}## Subtask 1.1: S\n- [ ] x\n`,
  });
  assert.deepEqual(messages(storyNoSp, 'warn'), []);
});
