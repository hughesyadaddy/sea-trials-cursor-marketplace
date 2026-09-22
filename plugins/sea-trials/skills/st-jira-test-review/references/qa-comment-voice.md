# QA comment voice

Comments are written as the signed-in tester. They must read like a
real QA pass typed by a senior tester between two other tasks: short,
specific, first person, no ceremony.

## Rules

- Open with what you did, not with a verdict label. Vary the opener
  across cards in one run (see the list below).
- One line per AC when it matters; group passes into a sentence when
  they all passed ("All five AC pass on iOS 17 sim and web").
- On a fail: numbered repro, expected, actual, and where the
  screenshot is. Mention the assignee with an ADF mention.
- Name the platform, branch, and commit short SHA once.
- No headers, no "Summary", no bold labels, no bullet walls, no
  sign-off, no emojis, no words from contract section 5.
- Never say who or what wrote the comment. Never paste command output
  longer than three lines; say "exits 0" or quote the failing line.
- Checkboxes in comments are fine (`- [ ]` for open repro items); they
  need `contentFormat: "adf"` like any other body.

## Openers (rotate, never reuse within one run)

- Ran this on `<branch>` at `<sha>` ...
- Checked all AC on the iOS sim and web ...
- Pulled the branch and went through the card ...
- Tested this one against staging ...
- Went through the test plan first, then the AC one by one ...
- Quick pass on this: ...
- Spent about twenty minutes on this card ...

## Examples

Pass:

```text
Ran this on feature/us3-pdf at 4f2c1a9. Unit test for the service
exits 0 and the export button shows the share sheet with
invoice-1042.pdf on the iOS 17 sim. Opened the file in Preview, one
page, totals match the screen. Moving to Done.
```

Pass with a different approach:

```text
Checked all AC on web and Android. The card lists
invoice_pdf_service.dart but the work landed in
billing/pdf/invoice_document.dart; behaviour is the same and the test
covers it, so I am not holding it on that. Done.
```

Fail:

```text
Went through the test plan first, then the AC. Service test passes.
The share sheet AC fails on Android 14:

1. Open invoice 1042
2. Tap Export PDF
3. Expected: share sheet with invoice-1042.pdf
4. Actual: toast "Could not build PDF", logcat shows a
   FileSystemException on /storage/emulated/0/Download

Screenshot attached. iOS is fine. @[Dana](accountId:557058:...) can
you take a look? Back to In Progress.
```

Needs discussion (no transition):

```text
Two of the three AC pass. The third says "totals match the screen"
but the screen rounds to whole units and the PDF shows cents. Not
sure which one is right; leaving it in review until we decide.
```
