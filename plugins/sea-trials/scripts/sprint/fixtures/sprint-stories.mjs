/**
 * Golden markdown fixtures shared by `md-to-adf.test.mjs`,
 * `adf-to-md.test.mjs` and `md-to-adf.roundtrip.test.mjs`.
 */

/** A realistic sprint story card. */
export const STORY_MD = `# US3: Reinstall reaches device setup

**Goal:** After a reinstall the user lands on **device setup** with the
\`OfflineDownloadToggle\` visible, exactly like a fresh install.

| Field | Value |
|---|---|
| Story points | 5 |
| Blocked by | US1 |

## Acceptance criteria

- [ ] **Boot** routes to \`ClientDeviceSetupBootPage\` when \`sync_ready\` is
  false after reinstall
- [x] Toggle defaults to **on** for licensed users
- [ ] Analytics event \`reinstall_setup_shown\` fires once
  - [ ] Event carries the \`license_id\` property

## Notes

- Legacy path
  - \`onboarding_offline_download_step.dart\`
  - \`onboarding_offline_download_footer.dart\`
- New path

\`\`\`dart
final gate = LicenseStreamSubscriptionGate(
  ready: state.syncReady,
);
\`\`\`

> [!NOTE]
> The E2E scenario lives in \`scenario_reinstall_device_setup_test.dart\`.

---
`;

/**
 * Every inline markdown string exercised by `md-to-adf.test.mjs`,
 * keyed by a short name so round-trip failures are easy to place.
 */
export const GOLDEN_SNIPPETS = {
  empty: '',
  paragraphs: 'one\ntwo\n\nthree',
  emptyHtmlAndStars: '<div></div>\n\n<span> </span>\n\n**\n\n****',
  headings: '# One\n## Two ##\n###### Six\n####### Seven',
  emptyHeading: '##',
  marks: '**a** __b__ *c* _d_ ~~e~~ `f`',
  nestedMarks: '**bold *both* bold** ***all***',
  codeInStrongAndLink: '**a `b` c** [`d`](https://e.f)',
  snakeCase: 'snake_case_name and file_a',
  unmatchedDelims: '2 * 3 * 4 and **open',
  links: '[t](https://a.b "T") https://c.d/e. <https://f.g> (https://h.i)',
  linkInnerMarks: '[**b** i](https://x.y)',
  hardBreaks: 'a<br>b  \nc<br/>d\nlast  ',
  escapes: '\\*not em\\* \\_x\\_ \\`y\\`',
  mentions: '@[Ada Lovelace](accountId:5b10ac8d) and @bob',
  htmlStripped: '<b>bold</b> <span class="x">y</span> <!-- c -->z',
  images: '![alt](https://img.x/a.png) ![](https://img.x/b.png)',
  fences: '```dart\nvoid main() {\n\n  x();\n}\n```\n\n~~~\nplain\n~~~',
  emptyAndOpenFence: '```\n```\n\n```js\nrest\nof file',
  rulesAndTable: '---\n\n***\n\n___\n\n| a |\n|---|\n| b |',
  frontmatter: '---\ntitle: x\ntags: [a]\n---\n\nbody',
  nestedLists: '- a\n  - b\n    1. c\n- d\n\n3) e\n4) f',
  orderedFromOne: '1. a\n2. b',
  tabNesting: '- a\n\t- b\n- c\n    - d',
  lazyContinuation: '- first line\n  continued here\n- second',
  codeInListItem: '- item\n\n  ```sh\n  ls\n  ```\n- next',
  taskStates: '- [ ] **a** `b`\n- [x] c\n* [X] d',
  mixedTaskPlain: '- [ ] t1\n- plain\n- [ ] t2',
  taskUnderBullet: '- parent\n  - [ ] child',
  nestedTasksFlatten: '- [ ] a\n  - [ ] a1\n  - [x] a2\n- [ ] b',
  taskHardBreak: '- [ ] one<br>two',
  gfmTable:
    '| Field | Value |\n| --- | :---: |\n| a | **b** |\n| empty | |\n' +
    '| task | [ ] do it |\n| pipe | x \\| y |',
  raggedTable: 'a | b\n---|---\n1\n2 | 3 | 4',
  blockquote: '> a\n> b\n>\n> c',
  alerts: ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']
    .map((k) => `> [!${k}]\n> body ${k}\n`)
    .join('\n'),
  panelWithTable: '> [!NOTE]\n> | a |\n> |---|\n> | b |',
  panelWithLists: '> [!TIP]\n> - a\n> - [ ] b',
  story: STORY_MD,
};

/** Shapes that are easy to flatten by accident. */
export const NASTY_SNIPPETS = {
  threeDeepLists: '- a\n  - b\n    - c\n      - d\n  - e\n- f',
  threeDeepMixed: '1. a\n   - b\n     1. c\n     2. d\n   - e\n2. f',
  orderedInsideTaskItem: '- [ ] task\n  1. step one\n  2. step two\n- [ ] next',
  nestedTasksTwoParents:
    '- [ ] a\n  - plain a1\n- [ ] b\n  - plain b1\n  - plain b2',
  tableInlineCodePipe:
    '| Cmd | Note |\n| --- | --- |\n| `a \\| b` | pipe in code |\n' +
    '| `x` | plain \\| pipe |',
  tableWithBreakAndTask:
    '| a | b |\n| --- | --- |\n| one<br>two | [x] done |\n| **c** *d* | `e` |',
  fenceInsideFence: '````md\n```js\nconsole.log(1);\n```\n````',
  fenceInsideFenceTilde: '~~~\n```dart\nx();\n```\n~~~',
  tasksUnderHeading: '## Acceptance criteria\n- [ ] one\n- [x] two\n### Sub\n- [ ] three',
  panelWithList: '> [!WARNING]\n> Intro line\n>\n> - a\n>   - b\n> - c\n>\n> 1. x\n> 2. y',
  panelWithCode: '> [!IMPORTANT]\n> ```sh\n> pnpm test\n> ```',
  blockquoteNested: '> outer\n>\n> > inner\n>\n> back',
  literalSyntax:
    '\\# not heading\n\n\\- not list\n\n1\\. not ordered\n\n\\> not quote\n\n' +
    'a \\[x\\] b \\<br> c \\@[m](accountId:1) d \\!\\[img\\](u)',
  underscoresAndTildes: 'a_b _c_ ~~d~~ ~e~ ~~~f',
  urlsInText: 'see https://x.y/z, (https://a.b) and http://c.d.',
  codeSpanBackticks: 'use `` `tick` `` and `` ` `` and ` a `',
  markAdjacency: '**a** **b** *c* *d* ~~e~~ ~~f~~ **g***h*',
  linkTitles: '[a](https://x.y "with \\"quote\\"") [b](https://x.y \'single\')',
  headingMarks: '## **Bold** heading with `code` and #tag',
  emptyListItemWithNested: '-\n  - nested',
  orderedStartNested: '5. five\n6. six\n   - a\n   - b\n7. seven',
  loosePlainList: '- a\n\n- b\n\n- c',
  tableSingleColumn: '| only |\n| --- |\n| one |\n|  |',
  hardBreaksAroundSpaces: 'a <br> b<br>c',
};
