/* md-render.js — small vendored Markdown renderer + rendered block diff.
 * No external deps. Output is built from escaped text; only whitelisted tags are emitted
 * and URLs are scheme-checked (http/https/mailto/relative only).
 */
(function (root) {
  "use strict";

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

  // Word-diff sentinels (private-use chars, stripped from URLs)
  const DS = "\uE000", DE = "\uE001", AS = "\uE002", AE = "\uE003";
  const SENT_RE = /[\uE000-\uE003]/g;

  function safeUrl(raw, base) {
    let u = String(raw || "").replace(SENT_RE, "").trim();
    // entities already escaped in input; decode &amp; for scheme check only
    const plain = u.replace(/&amp;/g, "&");
    if (/^[a-z][a-z0-9+.-]*:/i.test(plain) && !/^(https?:|mailto:)/i.test(plain)) return null;
    if (base && !/^(https?:|mailto:|\/|#)/i.test(plain)) u = base + u;
    return u;
  }

  /* ---------------- inline ---------------- */
  function renderInline(src, opts) {
    opts = opts || {};
    let s = esc(src);
    const slots = [];
    const hold = (html) => { slots.push(html); return "\uE010" + (slots.length - 1) + "\uE011"; };
    // code spans
    s = s.replace(/`([^`]+)`/g, (_, c) => hold("<code>" + c + "</code>"));
    // images ![alt](src)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => {
      const u = safeUrl(url, opts.imgBase);
      if (!u) return alt;
      return hold('<img src="' + u + '" alt="' + alt.replace(SENT_RE, "") + '" loading="lazy">');
    });
    // links [text](href)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, url) => {
      const u = safeUrl(url, null);
      if (!u) return text;
      return hold('<a href="' + u + '" target="_blank" rel="noopener noreferrer">') + text + hold("</a>");
    });
    // autolinks
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) =>
      pre + hold('<a href="' + url.replace(SENT_RE, "") + '" target="_blank" rel="noopener noreferrer">') + url + hold("</a>"));
    // emphasis
    s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, "$1<em>$2</em>");
    s = s.replace(/\uE010(\d+)\uE011/g, (_, i) => slots[+i]);
    s = s.replace(/\uE010(\d+)\uE011/g, (_, i) => slots[+i]);
    // word-diff sentinels → spans
    s = s.replace(/\uE000/g, '<span class="w-del">').replace(/\uE001/g, "</span>")
         .replace(/\uE002/g, '<span class="w-add">').replace(/\uE003/g, "</span>");
    return s;
  }

  /* ---------------- blocks ---------------- */
  const RE_FENCE = /^\s*(```|~~~)/;
  const RE_HEAD = /^(#{1,6})\s+(.*)$/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const RE_LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const RE_TABLE = /^\s*\|.*\|\s*$/;
  const RE_QUOTE = /^\s*>\s?/;

  /** Split markdown into top-level blocks: {type, src}. List items are one block each. */
  function splitBlocks(md) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (RE_FENCE.test(line)) {
        const fence = line.trim().slice(0, 3);
        const buf = [line]; i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) { buf.push(lines[i]); i++; }
        if (i < lines.length) { buf.push(lines[i]); i++; }
        blocks.push({ type: "code", src: buf.join("\n") });
        continue;
      }
      if (RE_HEAD.test(line)) { blocks.push({ type: "heading", src: line }); i++; continue; }
      if (RE_HR.test(line)) { blocks.push({ type: "hr", src: line }); i++; continue; }
      if (RE_TABLE.test(line)) {
        const buf = [];
        while (i < lines.length && RE_TABLE.test(lines[i])) { buf.push(lines[i]); i++; }
        blocks.push({ type: "table", src: buf.join("\n") });
        continue;
      }
      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && lines[i].trim() && RE_QUOTE.test(lines[i])) { buf.push(lines[i]); i++; }
        blocks.push({ type: "quote", src: buf.join("\n") });
        continue;
      }
      const li = line.match(RE_LI);
      if (li && li[1].length < 2) {
        const buf = [line]; i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // blank followed by indented continuation stays in item
            if (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) { buf.push(l); i++; continue; }
            break;
          }
          if (/^\s{2,}\S/.test(l)) { buf.push(l); i++; continue; }
          break;
        }
        blocks.push({ type: "li", src: buf.join("\n") });
        continue;
      }
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !RE_FENCE.test(lines[i]) && !RE_HEAD.test(lines[i]) &&
             !RE_TABLE.test(lines[i]) && !RE_QUOTE.test(lines[i]) && !(RE_LI.test(lines[i]) && lines[i].match(RE_LI)[1].length < 2)) {
        buf.push(lines[i]); i++;
      }
      blocks.push({ type: "p", src: buf.join("\n") });
    }
    return blocks;
  }

  function renderTable(src, opts) {
    const rows = src.split("\n").map((r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
    let html = '<table class="md-table">';
    let start = 0;
    if (rows.length > 1 && rows[1].every((c) => /^:?-{2,}:?$/.test(c.replace(SENT_RE, "")))) {
      html += "<thead><tr>" + rows[0].map((c) => "<th>" + renderInline(c, opts) + "</th>").join("") + "</tr></thead>";
      start = 2;
    }
    html += "<tbody>";
    for (let r = start; r < rows.length; r++) html += "<tr>" + rows[r].map((c) => "<td>" + renderInline(c, opts) + "</td>").join("") + "</tr>";
    return html + "</tbody></table>";
  }

  function renderListItem(src, opts) {
    const lines = src.split("\n");
    const m = lines[0].match(RE_LI);
    const ordered = /\d/.test(m[2]);
    let text = m[3];
    let box = "";
    const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
    if (task) {
      box = '<input type="checkbox" disabled' + (task[1] !== " " ? " checked" : "") + "> ";
      text = task[2];
    }
    const rest = lines.slice(1);
    // continuation lines that are not nested list → join into paragraph
    const nestedIdx = rest.findIndex((l) => RE_LI.test(l));
    const contText = (nestedIdx === -1 ? rest : rest.slice(0, nestedIdx)).map((l) => l.trim()).filter(Boolean);
    let inner = box + renderInline([text].concat(contText).join(" "), opts);
    if (nestedIdx !== -1) {
      const nested = rest.slice(nestedIdx);
      const minIndent = Math.min.apply(null, nested.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
      inner += renderBlocksHtml(nested.map((l) => l.slice(minIndent)).join("\n"), opts, true);
    }
    const tag = ordered ? "ol" : "ul";
    const startAttr = ordered ? ' start="' + parseInt(m[2], 10) + '"' : "";
    return "<" + tag + startAttr + (task ? ' class="task-list"' : "") + "><li>" + inner + "</li></" + tag + ">";
  }

  function renderBlock(b, opts) {
    switch (b.type) {
      case "heading": {
        const m = b.src.match(RE_HEAD);
        const n = m[1].length;
        return "<h" + n + ">" + renderInline(m[2], opts) + "</h" + n + ">";
      }
      case "hr": return "<hr>";
      case "code": {
        const lines = b.src.split("\n");
        const lang = lines[0].trim().slice(3).replace(/[^\w-]/g, "");
        const body = lines.slice(1, lines[lines.length - 1].trim().match(/^(```|~~~)/) ? -1 : undefined).join("\n");
        let h = esc(body);
        h = h.replace(/\uE000/g, '<span class="w-del">').replace(/\uE001/g, "</span>")
             .replace(/\uE002/g, '<span class="w-add">').replace(/\uE003/g, "</span>");
        return '<pre class="md-code"' + (lang ? ' data-lang="' + lang + '"' : "") + "><code>" + h + "</code></pre>";
      }
      case "table": return renderTable(b.src, opts);
      case "quote": return "<blockquote>" + renderBlocksHtml(b.src.split("\n").map((l) => l.replace(RE_QUOTE, "")).join("\n"), opts) + "</blockquote>";
      case "li": return renderListItem(b.src, opts);
      default: return "<p>" + b.src.split("\n").map((l) => renderInline(l, opts)).join("<br>") + "</p>";
    }
  }

  function renderBlocksHtml(md, opts) {
    return splitBlocks(md).map((b) => renderBlock(b, opts)).join("\n");
  }

  /* ---------------- diff ---------------- */
  function lcsOps(A, B, eq) {
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = eq(A[i], B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(A[i], B[j])) { ops.push({ t: "eq", a: A[i], b: B[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", a: A[i] }); i++; }
      else { ops.push({ t: "add", b: B[j] }); j++; }
    }
    while (i < n) ops.push({ t: "del", a: A[i++] });
    while (j < m) ops.push({ t: "add", b: B[j++] });
    return ops;
  }

  const norm = (s) => s.replace(/\s+/g, " ").trim();

  /** Word-level diff on two source strings → [leftSrcWithSentinels, rightSrcWithSentinels] */
  function wordMark(a, b) {
    const ta = a.split(/(\s+)/), tb = b.split(/(\s+)/);
    if (ta.length * tb.length > 250000) return [DS + a + DE, AS + b + AE];
    const ops = lcsOps(ta, tb, (x, y) => x === y);
    let L = "", R = "";
    for (const o of ops) {
      if (o.t === "eq") { L += o.a; R += o.b; }
      else if (o.t === "del") L += /^\s+$/.test(o.a) ? o.a : DS + o.a + DE;
      else R += /^\s+$/.test(o.b) ? o.b : AS + o.b + AE;
    }
    return [L, R];
  }

  function similar(a, b) {
    const wa = new Set(norm(a).split(" ")), wb = norm(b).split(" ");
    if (!wa.size || !wb.length) return 0;
    let hit = 0; for (const w of wb) if (wa.has(w)) hit++;
    return hit / Math.max(wa.size, wb.length);
  }

  /** Aligned rows: {kind: eq|del|add|mod, left: block|null, right: block|null} */
  function diffBlocks(leftMd, rightMd) {
    const A = splitBlocks(leftMd), B = splitBlocks(rightMd);
    const ops = lcsOps(A, B, (x, y) => x.type === y.type && norm(x.src) === norm(y.src));
    const rows = [];
    let k = 0;
    while (k < ops.length) {
      if (ops[k].t === "eq") { rows.push({ kind: "eq", left: ops[k].a, right: ops[k].b }); k++; continue; }
      const dels = [], adds = [];
      while (k < ops.length && ops[k].t !== "eq") { (ops[k].t === "del" ? dels : adds).push(ops[k].t === "del" ? ops[k].a : ops[k].b); k++; }
      // pair dels with adds in order when same type and reasonably similar
      let di = 0, ai = 0;
      while (di < dels.length || ai < adds.length) {
        const d = dels[di], a = adds[ai];
        if (d && a && d.type === a.type && similar(d.src, a.src) >= 0.3) { rows.push({ kind: "mod", left: d, right: a }); di++; ai++; }
        else if (d && (!a || dels.length - di >= adds.length - ai)) { rows.push({ kind: "del", left: d, right: null }); di++; }
        else { rows.push({ kind: "add", left: null, right: a }); ai++; }
      }
    }
    return rows;
  }

  function renderRowSides(row, opts) {
    if (row.kind === "mod") {
      const [l, r] = wordMark(row.left.src, row.right.src);
      return [renderBlock({ type: row.left.type, src: l }, opts), renderBlock({ type: row.right.type, src: r }, opts)];
    }
    return [row.left ? renderBlock(row.left, opts) : "", row.right ? renderBlock(row.right, opts) : ""];
  }

  const GUT = { eq: ["", ""], del: ["−", ""], add: ["", "+"], mod: ["−", "+"] };

  function lineCount(b) { return b ? b.src.split("\n").filter((l) => l.trim()).length || 1 : 0; }

  /** GitHub-style counts: lines in removed/changed (left) and added/changed (right) blocks. */
  function lineStats(rows) {
    let plus = 0, minus = 0;
    for (const r of rows) {
      if (r.kind === "add" || r.kind === "mod") plus += lineCount(r.right);
      if (r.kind === "del" || r.kind === "mod") minus += lineCount(r.left);
    }
    return { plus, minus };
  }

  function diffHeader(rows, title) {
    const ls = lineStats(rows), st = stats(rows);
    const total = ls.plus + ls.minus;
    const boxes = [];
    for (let i = 0; i < 5; i++) {
      const g = total ? Math.round((ls.plus / total) * 5) : 0;
      boxes.push('<span class="dbox ' + (!total ? "n" : i < g ? "a" : "d") + '"></span>');
    }
    return '<div class="rdiff-file"><span class="dstat"><span class="p">+' + ls.plus + '</span> <span class="m">−' + ls.minus +
      "</span></span>" + boxes.join("") + '<span class="dtitle">' + esc(title || "") + '</span><span class="dblocks">' +
      st.add + " added · " + st.del + " removed · " + st.mod + " changed · " + st.eq + " unchanged blocks</span></div>";
  }

  // Full render: nothing is folded or hidden; filler keeps both sides aligned.
  function renderSplitDiff(leftMd, rightMd, opts) {
    opts = opts || {};
    const rows = diffBlocks(leftMd, rightMd);
    const out = ['<div class="rdiff rsplit">' + diffHeader(rows, opts.title) +
      '<div class="rdiff-head"><div>' + esc(opts.leftLabel || "Jira") + "</div><div>" + esc(opts.rightLabel || "Local") + "</div></div>"];
    for (const row of rows) {
      const [l, r] = renderRowSides(row, opts);
      const g = GUT[row.kind];
      out.push('<div class="rrow ' + row.kind + '">' +
        '<div class="rg left">' + g[0] + '</div><div class="rc left' + (row.left ? "" : " empty") + '">' + l + "</div>" +
        '<div class="rg right">' + g[1] + '</div><div class="rc right' + (row.right ? "" : " empty") + '">' + r + "</div></div>");
    }
    out.push("</div>");
    return { html: out.join(""), stats: stats(rows), lines: lineStats(rows) };
  }

  function renderUnifiedDiff(leftMd, rightMd, opts) {
    opts = opts || {};
    const rows = diffBlocks(leftMd, rightMd);
    const out = ['<div class="rdiff runified">' + diffHeader(rows, opts.title) +
      '<div class="rdiff-head one"><div>' + esc(opts.leftLabel || "Jira") + " → " + esc(opts.rightLabel || "Local") + "</div></div>"];
    const line = (cls, g, html) => '<div class="urow ' + cls + '"><div class="rg">' + g + '</div><div class="rc">' + html + "</div></div>";
    for (const row of rows) {
      const [l, r] = renderRowSides(row, opts);
      if (row.kind === "eq") { out.push(line("eq", "", r)); continue; }
      if (row.left) out.push(line(row.kind === "mod" ? "mod del" : "del", "−", l));
      if (row.right) out.push(line(row.kind === "mod" ? "mod add" : "add", "+", r));
    }
    out.push("</div>");
    return { html: out.join(""), stats: stats(rows), lines: lineStats(rows) };
  }

  function stats(rows) {
    const s = { eq: 0, add: 0, del: 0, mod: 0 };
    for (const r of rows) s[r.kind]++;
    return s;
  }

  /* ---------------- front matter ---------------- */
  function parseFrontMatter(text) {
    text = String(text || "").replace(/\r\n?/g, "\n");
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { meta: {}, order: [], body: text };
    const meta = {}, order = [];
    let last = null;
    for (const raw of m[1].split("\n")) {
      const km = raw.match(/^([\w-]+):\s*(.*)$/);
      if (km) {
        last = km[1]; order.push(last);
        let v = km[2].trim();
        if (v === "" ) meta[last] = [];
        else if (v === "[]") meta[last] = [];
        else if (v === "null" || v === "~") meta[last] = null;
        else meta[last] = v.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
        continue;
      }
      const lm = raw.match(/^\s*-\s+(.*)$/);
      if (lm && last) {
        if (!Array.isArray(meta[last])) meta[last] = meta[last] == null || meta[last] === "" ? [] : [meta[last]];
        meta[last].push(lm[1].trim().replace(/^'(.*)'$/, "$1"));
      } else if (last && /^\s+\S/.test(raw)) {
        // nested mapping line (e.g. attachments entries) — keep as text
        const prev = meta[last];
        const piece = raw.trim();
        if (Array.isArray(prev) && prev.length) prev[prev.length - 1] += " " + piece;
        else meta[last] = (prev ? prev + " " : "") + piece;
      }
    }
    return { meta, order, body: (m[2] || "").replace(/^\n/, "") };
  }

  function fmtVal(v) {
    if (v == null) return '<span class="fm-null">—</span>';
    if (Array.isArray(v)) return v.length ? v.map((x) => '<span class="fm-chip">' + esc(x) + "</span>").join(" ") : '<span class="fm-null">[]</span>';
    return esc(v);
  }

  function renderFrontMatterDiff(leftText, rightText, opts) {
    opts = opts || {};
    const L = parseFrontMatter(leftText), R = parseFrontMatter(rightText);
    const keys = [];
    for (const k of R.order.concat(L.order)) if (!keys.includes(k)) keys.push(k);
    const hide = new Set(opts.hideKeys || []);
    const cnt = { mod: 0, add: 0, del: 0 };
    let rows = "";
    for (const k of keys) {
      if (hide.has(k)) continue;
      const inL = k in L.meta, inR = k in R.meta;
      const a = JSON.stringify(L.meta[k]), b = JSON.stringify(R.meta[k]);
      let kind = "eq", mark = "";
      if (inL && !inR) { kind = "del"; mark = "−"; }
      else if (!inL && inR) { kind = "add"; mark = "+"; }
      else if (a !== b) { kind = "mod"; mark = "●"; }
      if (kind !== "eq") cnt[kind]++;
      rows += '<tr class="fm-' + kind + '"><td class="fm-mark">' + mark + '</td><th>' + esc(k) + '</th><td class="fm-l">' +
        (inL ? fmtVal(L.meta[k]) : "") + '</td><td class="fm-r">' + (inR ? fmtVal(R.meta[k]) : "") + "</td></tr>";
    }
    const changed = cnt.mod + cnt.add + cnt.del;
    const parts = [];
    if (cnt.mod) parts.push('<span class="fm-s-mod">● ' + cnt.mod + " changed</span>");
    if (cnt.add) parts.push('<span class="fm-s-add">+ ' + cnt.add + " added</span>");
    if (cnt.del) parts.push('<span class="fm-s-del">− ' + cnt.del + " removed</span>");
    const summary = parts.length ? parts.join(" · ") : '<span class="fm-null">no field changes</span>';
    // Collapsed by default; caller passes the global open state.
    const html = '<details class="fm-diff"' + (opts.open ? " open" : "") + '><summary><span class="fm-title">Front matter</span> • ' +
      summary + '</summary><table><thead><tr><th></th><th>Field</th><th>' + esc(opts.leftLabel || "Jira") + "</th><th>" +
      esc(opts.rightLabel || "Local") + "</th></tr></thead><tbody>" + rows + "</tbody></table></details>";
    return { html, changed, counts: cnt, left: L, right: R };
  }

  root.MdDiff = {
    esc, renderInline, splitBlocks, renderBlocksHtml, diffBlocks,
    renderSplitDiff, renderUnifiedDiff, lineStats, parseFrontMatter, renderFrontMatterDiff, safeUrl,
  };
})(typeof window !== "undefined" ? window : globalThis);
