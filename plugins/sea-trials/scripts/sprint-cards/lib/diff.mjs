/** Line diff (LCS) and a unified diff like `diff -u`, no dependencies. */

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{ op: ' '|'-'|'+', line: string, ai: number, bi: number }>}
 */
export function diffLines(a, b) {
  // Trim common prefix and suffix so the LCS table stays small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const ops = [];
  for (let i = 0; i < pre; i += 1) ops.push({ op: ' ', line: a[i], ai: i, bi: i });
  if (n * m > 4_000_000) {
    A.forEach((l, i) => ops.push({ op: '-', line: l, ai: pre + i, bi: -1 }));
    B.forEach((l, j) => ops.push({ op: '+', line: l, ai: -1, bi: pre + j }));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        ops.push({ op: ' ', line: A[i], ai: pre + i, bi: pre + j });
        i += 1;
        j += 1;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        ops.push({ op: '-', line: A[i], ai: pre + i, bi: -1 });
        i += 1;
      } else {
        ops.push({ op: '+', line: B[j], ai: -1, bi: pre + j });
        j += 1;
      }
    }
  }
  for (let k = 0; k < suf; k += 1) {
    const ai = a.length - suf + k;
    const bi = b.length - suf + k;
    ops.push({ op: ' ', line: a[ai], ai, bi });
  }
  return ops;
}

function splitText(t) {
  if (!t) return [];
  const lines = t.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Unified diff text with `context` lines around each change.
 *
 * @returns {string} empty when equal
 */
export function unifiedDiff(base, working, fromFile = 'jira', toFile = 'local', context = 3) {
  const a = splitText(base);
  const b = splitText(working);
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.op !== ' ')) return '';
  const out = [`--- ${fromFile}`, `+++ ${toFile}`];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].op === ' ') k += 1;
    if (k >= ops.length) break;
    let start = Math.max(0, k - context);
    let end = k;
    // extend the hunk while changes are within 2*context of each other
    for (;;) {
      while (end < ops.length && ops[end].op !== ' ') end += 1;
      let look = end;
      while (look < ops.length && ops[look].op === ' ' && look - end < 2 * context) look += 1;
      if (look < ops.length && ops[look].op !== ' ' && look - end < 2 * context + 1) {
        end = look;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, stop);
    const aStart = (hunk.find((o) => o.ai >= 0)?.ai ?? 0) + 1;
    const bStart = (hunk.find((o) => o.bi >= 0)?.bi ?? 0) + 1;
    const aLen = hunk.filter((o) => o.op !== '+').length;
    const bLen = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
    k = stop;
    start = stop;
  }
  return `${out.join('\n')}\n`;
}

/** `{ plus, minus }` counted from a unified diff. */
export function diffStat(udiff) {
  let plus = 0;
  let minus = 0;
  for (const l of udiff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) continue;
    if (l.startsWith('+')) plus += 1;
    else if (l.startsWith('-')) minus += 1;
  }
  return { plus, minus };
}
