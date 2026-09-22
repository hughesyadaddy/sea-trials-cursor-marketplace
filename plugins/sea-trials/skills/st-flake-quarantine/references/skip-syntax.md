# Skip syntax

What `flake-quarantine.mjs quarantine` writes, and what `unquarantine`
reverses. Every transform is regex + paren-matching over the source
text, formatting-preserving, and idempotent (a second run reports
`already quarantined; no change` and writes nothing).

The skip string is always `<reason> (<issue-url>)`, single-quoted,
with `'` and `\` escaped.

## Dart — test-level (`--test "<description>"`)

Applies to `test(`, `testWidgets(`, `group(`. The call is located by
callee + exact description literal (single or double quoted) followed
by a comma. Exactly one match is required.

Inline closing:

```dart
test('recovers after wedge', () async {
  expect(1, 1);
}, skip: 'flaky under CI load (https://github.com/o/r/issues/9)');
```

Trailing-comma style keeps the argument on its own line with the
indent of the last argument:

```dart
test(
  'trailing comma style',
  () async {
    expect(true, isTrue);
  },
  skip: 'flaky under CI load (https://github.com/o/r/issues/9)',
);
```

A `group(...)` skip silences every test in the group. Use it only when
the whole group is the flaky unit.

### `blocTest<…>(` is different

`blocTest` from `package:bloc_test` has a `skip:` parameter, but it is
an **`int`** — the number of emitted states to drop before comparing —
not a test skip. Writing `skip: 'reason'` there is a compile error.
The script therefore never edits a `blocTest` call; it falls back to
the file-level `@Skip` below and prints
`note: file-level @Skip: blocTest has no test-skip parameter…` on
stderr. Say so in the commit body.

### Fallbacks

| Situation | Result |
| --- | --- |
| Description not found | file-level `@Skip`, `note: … no test/testWidgets/group/blocTest call with description` |
| Description matches 2+ calls | file-level `@Skip`, `note: … description is not unique` |
| Callee is `blocTest` | file-level `@Skip` (see above) |
| `skip:` already present on the call | no change, `already quarantined` |

## Dart — file-level (no `--test`, or fallback)

`@Skip` is a library annotation, so it must sit on a `library`
directive.

Existing `library` directive → annotation goes immediately before it
(after any other annotations such as `@TestOn`):

```dart
@TestOn('vm')
@Skip('flaky under CI load (https://github.com/o/r/issues/9)')
library attach_test;
```

No `library` directive → the script inserts an unnamed one after any
leading `//` comment block (license, `// ignore_for_file:`), separated
by one blank line:

```dart
// ignore_for_file: avoid_print

@Skip('flaky under CI load (https://github.com/o/r/issues/9)')
library;

import 'package:flutter_test/flutter_test.dart';
```

`unquarantine --file <path>` removes the `@Skip(...)` line and a bare
`library;` directly beneath it (a named `library x;` stays).

## Node (`*.test.mjs`, `*.mjs`, `*.js`, `*.ts`)

`--test` is required; there is no file-level form. Applies to `test(`
and `it(` with an exact name literal (single, double, or backtick
quoted).

No options object yet → one is inserted as the second argument:

```js
test('settles after quiet window', { skip: 'flaky under CI load (https://github.com/o/r/issues/9)' }, async () => {
```

Existing options object → `skip` is appended as the last property:

```js
it('has options', { timeout: 500, skip: 'flaky under CI load (…)' }, () => {});
```

`unquarantine --file <path> --test "<name>"` removes the `skip`
property; when it was the only property the whole options argument is
removed, restoring the original two-argument call. Property splitting
respects strings, so commas inside the reason are safe.

## Formatting

The transforms aim to be `dart format` / `prettier` clean for the
common layouts above. The single gate runs `dart format --check` on
the quarantine commit anyway; if it flags the file, run `dart format`
on that file and amend before the push.

## Ledger

Every successful `quarantine` / `unquarantine` appends one JSON line to
`~/.cache/sea-trials/quarantine/ledger.jsonl` (`ST_STATE_DIR` override):

```json
{"ts":"2026-09-22T20:33:26.034Z","action":"quarantine","repo":"o/r",
 "file":"test/x_test.dart","test":"a b","issue":"https://…/issues/3",
 "pr":9,"reason":"flaky","fallback":null}
```

`ledger` prints a table; `ledger --json` the raw entries.
