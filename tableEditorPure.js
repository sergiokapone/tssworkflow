'use strict';
/* TSS Workflow 0.8.0, logic without VS Code: the model behind "Edit table visually".
 *   locateTables    tblr / longtblr / talltblr / tabular / tabular* / tabularx / array / longtable in a text
 *   parseTable      -> model { head, spec tokens, rows[{ pre, lead, cells, trail, sep, raw }], tail } or { skip: reason }
 *   applyOp         setCell / addRow / delRow / moveRow / addCol / delCol / moveCol / setAlign / fill  (on a copy)
 *   serialize       the new text of the whole environment; rows that were not touched keep their exact original text
 *   toView          what the webview draws
 * A table with a "%" inside a row, \verb, a nested table or an unreadable preamble is refused with a reason. */

const E4 = require('./formattersPure');

const SUPPORTED = ['tblr', 'longtblr', 'talltblr', 'tabular', 'tabular*', 'tabularx', 'array', 'longtable', 'spreadtab'];
const BASE_OK = ['tblr', 'longtblr', 'talltblr', 'tabular', 'tabular*', 'tabularx', 'array', 'longtable'];
const TBLR = new Set(['tblr', 'longtblr', 'talltblr']);
// arguments after \begin{env}: "[" optional [..], "{" mandatory {..}; the LAST {..} is the column specification
const ARGS = { tblr: '[{', longtblr: '[{', talltblr: '[{', tabular: '[{', array: '[{', longtable: '[{', 'tabular*': '{[{', tabularx: '{[{', spreadtab: '[{' };

const RULE_RE = new RegExp('^(?:' + [
  '\\\\(?:hline|toprule|midrule|bottomrule|endhead|endfirsthead|endfoot|endlastfoot|firsthline|lasthline|noalign\\{[^}]*\\}|cline\\{[^}]*\\})',
  '\\\\cmidrule(?:\\[[^\\]]*\\])?(?:\\([^)]*\\))?\\{[^}]*\\}',
  '\\\\addlinespace(?:\\[[^\\]]*\\])?',
  '\\\\specialrule\\{[^}]*\\}\\{[^}]*\\}\\{[^}]*\\}',
  '\\\\Set(?:Hline|Vline|Row|Column)(?:\\[[^\\]]*\\])?\\{[^}]*\\}(?:\\{[^}]*\\})?',
  '\\\\(?:hline|rowcolor|rowcolors|rowfont)(?:\\[[^\\]]*\\])?(?:\\{[^}]*\\})?'
].join('|') + ')');

const clone = (o) => JSON.parse(JSON.stringify(o));

/* --------------------------------- locating --------------------------------- */
// all supported environments of the text: [{ name, start, bodyStart, bodyEnd, end, hasNested }]
function locateTables(text) {
  return E4.findEnvs(text, SUPPORTED);
}

// the innermost table that contains `offset`, or null
function tableAt(text, offset) {
  const around = locateTables(text).filter((e) => e.start <= offset && offset <= e.end);
  if (!around.length) return null;
  return around.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

/* ---------------------------------- helpers --------------------------------- */
// end (exclusive) of a group that starts at text[i] ('{' or '['), or -1
function groupEnd(s, i) {
  const k = E4.matchBracket(s, i);
  return k < 0 ? -1 : k + 1;
}

// reads the arguments of the environment: { headEnd, groups: [{ kind: '['|'{', a, b }] } (a, b: offsets inside the group)
function readArgs(text, from, pattern) {
  const groups = [];
  let i = from;
  // spaces, line breaks and %-comments (\begin{tblr}%<newline>{...}: the comment swallows the line break, the group goes on)
  const skipWs = (k) => {
    for (;;) {
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] !== '%') return k;
      while (k < text.length && text[k] !== '\n') k++;
    }
  };
  for (const want of pattern) {
    const j = skipWs(i);
    if (text[j] === want) {
      const e = groupEnd(text, j);
      if (e < 0) return null;
      groups.push({ kind: want, a: j + 1, b: e - 1 });
      i = e;
    } else if (want === '{') return null;
  }
  return { headEnd: i, groups };
}

/* ------------------------------ column specification ------------------------------ */
// tokens: [{ pre, unit }] + post. unit = (>{..})* letter (group)* (<{..})*
function tokenizeSpec(s) {
  const tokens = [];
  let pre = '';
  let i = 0;
  const n = s.length;
  const grp = (k) => { const e = groupEnd(s, k); return e; };
  const unitAt = (k) => {
    let j = k;
    let u = '';
    while (s[j] === '>' && s[j + 1] === '{') { const e = grp(j + 1); if (e < 0) return null; u += s.slice(j, e); j = e; }
    if (!/[A-Za-z]/.test(s[j] || '')) return null;
    const letter = s[j];
    u += letter;
    j++;
    const take = (ch) => { if (s[j] === ch) { const e = grp(j); if (e < 0) return false; u += s.slice(j, e); j = e; } return true; };
    if ('pmb'.includes(letter)) { if (!take('{')) return null; }
    else if (letter === 'w' || letter === 'W') { if (!take('{') || !take('{')) return null; }
    else if ('XQSs'.includes(letter)) { if (!take('[')) return null; }
    while (s[j] === '<' && s[j + 1] === '{') { const e = grp(j + 1); if (e < 0) return null; u += s.slice(j, e); j = e; }
    return { u, end: j };
  };
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c) || c === '|') { pre += c; i++; continue; }
    if ((c === '@' || c === '!') && s[i + 1] === '{') { const e = grp(i + 1); if (e < 0) return null; pre += s.slice(i, e); i = e; continue; }
    if (c === '*' && s[i + 1] === '{') {
      const e1 = grp(i + 1);
      if (e1 < 0 || s[e1] !== '{') return null;
      const e2 = grp(e1);
      if (e2 < 0) return null;
      const times = parseInt(s.slice(i + 2, e1 - 1), 10);
      const inner = tokenizeSpec(s.slice(e1 + 1, e2 - 1));
      if (!inner || !Number.isFinite(times) || times < 0 || times > 60) return null;
      for (let t = 0; t < times; t++) {
        inner.tokens.forEach((tk, k) => { tokens.push({ pre: (k === 0 ? pre : '') + tk.pre, unit: tk.unit }); if (k === 0) pre = ''; });
        pre = inner.post;
      }
      i = e2;
      continue;
    }
    const u = unitAt(i);
    if (!u) return null;
    tokens.push({ pre, unit: u.u });
    pre = '';
    i = u.end;
  }
  return { tokens, post: pre };
}

const specToString = (sp) => sp.tokens.map((t) => t.pre + t.unit).join('') + sp.post;

function alignOf(unit) {
  if (/^[lcr]$/.test(unit)) return unit;
  const m = /^[XQSs]\[([^\]]*)\]/.exec(unit);
  if (m) { const a = m[1].split(',').map((x) => x.trim()).find((x) => /^[lcrj]$/.test(x)); return a || ''; }
  if (/^[XQ]$/.test(unit)) return 'l';
  return '';
}

function withAlign(unit, a) {
  if (/^[lcr]$/.test(unit)) return a;
  if (/^[XQ]$/.test(unit)) return unit + '[' + a + ']';
  const m = /^([XQSs])\[([^\]]*)\](.*)$/s.exec(unit);
  if (m) {
    const parts = m[2].split(',').map((x) => x.trim()).filter(Boolean);
    const k = parts.findIndex((x) => /^[lcrj]$/.test(x));
    if (k >= 0) parts[k] = a; else parts.unshift(a);
    return m[1] + '[' + parts.join(',') + ']' + m[3];
  }
  return unit;
}

/* ----------------------------------- rows ----------------------------------- */
function splitPrefix(text) {
  let i = 0;
  for (;;) {
    const m = /^\s*/.exec(text.slice(i));
    const j = i + m[0].length;
    if (text[j] === '%') { const e = text.indexOf('\n', j); i = e < 0 ? text.length : e; continue; }
    const r = RULE_RE.exec(text.slice(j));
    if (!r) break;
    i = j + r[0].length;
  }
  return { pre: text.slice(0, i), rest: text.slice(i) };
}

// splits at a top-level separator; returns pieces and what followed each (for "\\" the optional [..])
function splitTop(s, mode) {
  const out = [];
  let depth = 0;
  let envDepth = 0;
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '%') { const e = s.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '\\') {
      if (mode === 'row' && s[i + 1] === '\\' && depth === 0 && envDepth === 0) {
        const m = /^\\\\\*?(?:\[[^\]\n]*\])?/.exec(s.slice(i));
        out.push({ text: s.slice(start, i), sep: m[0] });
        i += m[0].length;
        start = i;
        continue;
      }
      const b = /^\\(begin|end)\{/.exec(s.slice(i, i + 8));
      if (b) { if (b[1] === 'begin') envDepth++; else envDepth--; i += b[0].length; continue; }
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (mode === 'cell' && c === '&' && depth === 0 && envDepth === 0) { out.push({ text: s.slice(start, i), sep: '&' }); i++; start = i; continue; }
    i++;
  }
  out.push({ text: s.slice(start), sep: '', last: true });
  return { pieces: out, balanced: depth === 0 && envDepth === 0 };
}

const hasBareComment = (s) => { for (let i = 0; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '%') return true; } return false; };

/* ------------------------------ merged cells ------------------------------ */
// a cell: { t raw, span (columns it consumes in the row), cs / rs (colspan / rowspan to draw), kind, head, tail, inner, align }
function classify(t) {
  // spreadtab: "@ text" marks a text cell; "@ \\SetCell..." is still a merged cell
  const at = /^@\s*(?=\\(?:SetCell|multicolumn)\b)/.exec(t);
  if (at) { const c = classify(t.slice(at[0].length)); c.t = t; c.head = at[0] + c.head; return c; }
  const base = { t, span: 1, cs: 1, rs: 1, kind: 'plain', head: '', tail: '', inner: t, align: '' };
  const mc = /^\\multicolumn\s*/.exec(t);
  if (mc) {
    let i = mc[0].length;
    const g = [];
    for (let k = 0; k < 3; k++) {
      while (/\s/.test(t[i] || '')) i++;
      if (t[i] !== '{') break;
      const e = E4.matchBracket(t, i);
      if (e < 0) break;
      g.push({ a: i, b: e });
      i = e + 1;
    }
    if (g.length && /^\s*\d+\s*$/.test(t.slice(g[0].a + 1, g[0].b))) {
      const n = Math.max(1, parseInt(t.slice(g[0].a + 1, g[0].b), 10));
      if (g.length === 3 && t.slice(i).trim() === '') {
        return { t, span: n, cs: n, rs: 1, kind: 'mc', head: t.slice(0, g[2].a + 1), tail: t.slice(g[2].b), inner: t.slice(g[2].a + 1, g[2].b), align: (/[lcr]/.exec(t.slice(g[1].a + 1, g[1].b)) || [''])[0] };
      }
      base.span = n; base.cs = n;
    }
    return base;
  }
  const sc = /^\\SetCell\s*/.exec(t);
  if (sc) {
    let i = sc[0].length;
    let opts = '';
    if (t[i] === '[') { const e = E4.matchBracket(t, i); if (e > 0) { opts = t.slice(i + 1, e); i = e + 1; } }
    while (/\s/.test(t[i] || '')) i++;
    if (t[i] === '{') { const e = E4.matchBracket(t, i); if (e > 0) i = e + 1; }
    const cs = /(?:^|,)\s*c\s*=\s*(\d+)/.exec(opts);
    const rs = /(?:^|,)\s*r\s*=\s*(\d+)/.exec(opts);
    return { t, span: 1, cs: cs ? Math.max(1, +cs[1]) : 1, rs: rs ? Math.max(1, +rs[1]) : 1, kind: 'sc', head: t.slice(0, i), tail: '', inner: t.slice(i).trim(), align: '' };
  }
  return base;
}

// the raw text of a cell after its visible text became `text`
function rebuild(cell, text) {
  if (cell.kind === 'mc') return cell.head + text + cell.tail;
  if (cell.kind === 'sc') return cell.head + (text ? ' ' + text : '');
  return text;
}

const withMcSpan = (c, n) => classify(c.t.replace(/^((?:@\s*)?\\multicolumn\s*\{\s*)\d+/, '$1' + Math.max(1, n)));
// key (c / r) of the span options of \SetCell
function withScOpt(c, key, n) {
  n = Math.max(1, n);
  const m = /^((?:@\s*)?\\SetCell\s*)(\[([^\]]*)\])?/.exec(c.t);
  let opts = m[3] === undefined ? '' : m[3];
  const re = new RegExp('(^|,)(\\s*' + key + '\\s*=\\s*)\\d+');
  if (re.test(opts)) opts = opts.replace(re, '$1$2' + n);
  else opts = (opts ? opts + ',' : '') + key + '=' + n;
  return classify(m[1] + '[' + opts + ']' + c.t.slice(m[0].length));
}
const mkEmpty = () => classify('');

/* --------------------------------- the model --------------------------------- */
// env: an item of locateTables(); returns { model } or { skip }
function parseTable(text, env) {
  const name = env.name;
  if (env.hasNested) return { skip: 'усередині є інша таблиця' };
  const a = readArgs(text, env.bodyStart, ARGS[name] || '[{');
  if (!a) return { skip: 'не вдалося прочитати параметри після \\begin{' + name + '}' };
  const head = text.slice(env.bodyStart, a.headEnd);
  let specGroup = [...a.groups].reverse().find((g) => g.kind === '{');
  if (!specGroup) return { skip: 'немає опису стовпців' };
  let base = name;
  if (name === 'spreadtab') {
    // \begin{spreadtab}{{tblr}{spec}}: the real environment and its preamble are two groups inside the argument
    const skip = (k) => { while (k < text.length && /\s/.test(text[k])) k++; return k; };
    const i1 = skip(specGroup.a);
    if (text[i1] !== '{') return { skip: 'spreadtab без {{тип}{опис}}' };
    const e1 = groupEnd(text, i1);
    const i2 = e1 < 0 ? -1 : skip(e1);
    if (e1 < 0 || text[i2] !== '{') return { skip: 'spreadtab без {{тип}{опис}}' };
    const e2 = groupEnd(text, i2);
    if (e2 < 0) return { skip: 'не збалансовані дужки в параметрах spreadtab' };
    base = text.slice(i1 + 1, e1 - 1).trim();
    if (!BASE_OK.includes(base)) return { skip: 'spreadtab з типом «' + base + '» не підтримується' };
    specGroup = { kind: '{', a: i2 + 1, b: e2 - 1 };
  }
  const isTblr = TBLR.has(base);
  let specRange = null; // [a, b) in `head`
  const specSrc = text.slice(specGroup.a, specGroup.b);
  let spec = null;
  if (isTblr) {
    const m = /(^|[,\s])colspec\s*=\s*\{/.exec(specSrc);
    if (m) {
      const open = m.index + m[0].length - 1;
      const close = E4.matchBracket(specSrc, open);
      if (close > 0) specRange = [specGroup.a - env.bodyStart + open + 1, specGroup.a - env.bodyStart + close];
    } else if (!/=/.test(specSrc)) specRange = [specGroup.a - env.bodyStart, specGroup.b - env.bodyStart];
  } else specRange = [specGroup.a - env.bodyStart, specGroup.b - env.bodyStart];
  if (specRange) spec = tokenizeSpec(head.slice(specRange[0], specRange[1]));
  const kinfo = isTblr ? keyInfo(specSrc) : { auto: false, manual: false };
  const optSp = isTblr ? parseOptSpans(specSrc) : { spans: [], complex: false };

  const body = text.slice(a.headEnd, env.bodyEnd);
  if (/\\verb\b|\\lstinline|\\mintinline/.test(body)) return { skip: 'у таблиці є \\verb або код' };
  const rowsSplit = splitTop(body, 'row');
  if (!rowsSplit.balanced) return { skip: 'не збалансовані дужки або \\begin/\\end' };
  const rows = [];
  let tail = '';
  rowsSplit.pieces.forEach((p, idx) => {
    const { pre, rest } = splitPrefix(p.text);
    if (p.last) {
      if (!rest.trim()) { tail = p.text; return; }
    }
    rows.push({ pre, rest, sep: p.sep, raw: p.text });
  });
  const out = [];
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (hasBareComment(r.rest)) return { skip: 'у рядку ' + (k + 1) + ' є коментар % усередині клітинок' };
    const core = r.rest.trim();
    const lead = /^\s*/.exec(r.rest)[0];
    const trail = r.rest.slice(lead.length + core.length);
    const cs = splitTop(core, 'cell');
    if (!cs.balanced) return { skip: 'у рядку ' + (k + 1) + ' не збалансовані дужки' };
    const cells = cs.pieces.map((c) => classify(c.text.trim()));
    out.push({ pre: r.pre, lead, trail, cells, sep: r.sep, raw: r.raw, rest: r.rest, dirty: false });
  }
  if (!out.length) return { skip: 'у таблиці немає рядків' };
  const model = {
    env: name, base, isTblr, spread: name === 'spreadtab', tailText: tail, head, specRange, spec, specDirty: false,
    groupRange: [specGroup.a - env.bodyStart, specGroup.b - env.bodyStart], keyOps: [], keyInfo: kinfo,
    rows: out, styles: isTblr ? parseStyleRules(specSrc) : [], optSpans: optSp.spans, optComplex: optSp.complex,
    prefix: text.slice(env.start, env.bodyStart), suffix: text.slice(env.bodyEnd, env.end)
  };
  model.origBody = serializeBody(model);
  model.alignInfo = detectAlign(out);
  return { model };
}

/* Where the rows of a parsed table stand in the text it was parsed from: [{ start, content, end }] (offsets), one per
 * row of the model. `start`..`end` is the row with what stands before it (\hline, comments) and its \\ ; `content` is where
 * the first cell begins. `bodyAt` is where the rows begin: env.bodyStart + model.head.length. */
function rowSpans(model, bodyAt) {
  const out = [];
  let pos = bodyAt;
  for (const r of model.rows) {
    const end = pos + r.raw.length + r.sep.length;
    out.push({ start: pos, content: Math.min(end, pos + r.pre.length + r.lead.length), end });
    pos = end;
  }
  return out;
}

/* The merged cells of a table where they stand in the file (for the lightbulb and the warnings of the editor).
 * Offsets of every cell of a freshly parsed table: [row][cell] -> [start, end) in the text it was parsed from. */
function cellRanges(model, bodyAt) {
  const sp = rowSpans(model, bodyAt);
  return model.rows.map((r, i) => {
    let pos = sp[i].start + r.pre.length + r.lead.length;
    return splitTop(r.rest.trim(), 'cell').pieces.map((p) => {
      const ws = /^\s*/.exec(p.text)[0].length;
      const a = pos + ws;
      pos += p.text.length + 1;
      return [a, a + p.text.trim().length];
    });
  });
}

// { model, spans: [{ r, c, rs, cs, src, range: [from, to] | null }], conflicts } of the table `env` of `text`, or null when it cannot be read
function spanMap(text, env) {
  const res = parseTable(text, env);
  if (res.skip) return null;
  const m = res.model;
  if (!m.isTblr) return { model: m, spans: [], conflicts: [] };
  const cr = cellRanges(m, env.bodyStart + m.head.length);
  const base = env.bodyStart + m.groupRange[0];
  const spans = spanList(m).map((s) => {
    if (s.src === 'opts') return Object.assign({}, s, { range: [base + s.opt.a, base + s.opt.b] });
    const k = cellIndexAt(m.rows[s.r], s.c);
    return Object.assign({}, s, { range: k >= 0 && cr[s.r] && cr[s.r][k] ? cr[s.r][k] : null });
  });
  const conflicts = spanConflicts(m, spans);
  return { model: m, spans, conflicts, headRange: [env.start, env.bodyStart + m.head.length] };
}

// the text of the whole environment after `op` (spansToOptions, spansToCells, spanKeep, merge, unmerge) or { error }
function convertSpans(text, env, op) {
  const res = parseTable(text, env);
  if (res.skip) return { error: res.skip };
  const r = applyOp(res.model, op);
  if (r.error) return { error: r.error };
  if (r.confirm) return { error: r.confirm };
  return { text: serialize(r.model) };
}

const width = (m) => Math.max(m.spec ? m.spec.tokens.length : 0, ...m.rows.map((r) => r.cells.reduce((s, c) => s + c.span, 0)));
const hasSpans = (m) => (m.optSpans || []).length > 0 || m.rows.some((r) => r.cells.some((c) => c.cs > 1 || c.rs > 1));

function joinCells(cells) {
  let s = cells[0] ? cells[0].t : '';
  for (let i = 1; i < cells.length; i++) s += (s === '' ? '' : ' ') + '&' + (cells[i].t ? ' ' + cells[i].t : '');
  return s;
}

function serializeBody(m) {
  let s = '';
  for (const r of m.rows) s += (r.dirty ? r.pre + r.lead + joinCells(r.cells) + r.trail : r.raw) + r.sep;
  return s + m.tailText;
}

const dlen = (t) => [...t].length;
function ampPos(line) {
  const p = [];
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') d++;
    else if (c === '}') d--;
    else if (c === '&' && d === 0) p.push(i);
  }
  return p;
}
const plainRow = (r) => r.cells.length >= 2 && r.cells.every((c) => c.cs === 1 && c.rs === 1 && c.kind === 'plain' && !/\n/.test(c.t));

// is the table written with padded cells (the & stand under each other)? { aligned, padLast }
function detectAlign(rows) {
  const rs = rows.filter((r) => !r.dirty && r.rest !== undefined && plainRow(r) && !/\n/.test(r.rest.trim()));
  if (rs.length < 2) return { aligned: false, padLast: false };
  const pos = rs.map((r) => ampPos(r.rest));
  let evidence = false;
  const maxN = Math.max(...pos.map((p) => p.length));
  for (let j = 0; j < maxN; j++) {
    const set = new Set(pos.filter((p) => p.length > j).map((p) => p[j]));
    if (set.size > 1) return { aligned: false, padLast: false };
  }
  for (const r of rs) if (/\s{2,}&/.test(r.rest) || /\s{2,}$/.test(r.rest.trimEnd() + ' ') && /\S\s{2,}\S/.test(r.rest)) evidence = true;
  const withSep = rs.filter((r) => r.sep);
  const padLast = withSep.length >= 2 && new Set(withSep.map((r) => dlen(r.rest.replace(/\s+$/, '')) + (/\s$/.test(r.rest) ? 1 : 0))).size === 1 && withSep.some((r) => /\S\s{2,}$/.test(r.rest));
  return { aligned: evidence, padLast };
}

// the text of the rows of the body; plain rows are padded to common widths when the original table was aligned
function bodyText(m, doAlign) {
  const eligible = (r) => plainRow(r);
  const widths = [];
  if (doAlign) {
    for (const r of m.rows) if (eligible(r)) r.cells.forEach((c, j) => { widths[j] = Math.max(widths[j] || 0, dlen(c.t)); });
  }
  let s = '';
  for (const r of m.rows) {
    if (doAlign && eligible(r)) {
      const n = r.cells.length;
      const parts = r.cells.map((c, j) => (j < n - 1 || (m.alignInfo.padLast && r.sep) ? c.t + ' '.repeat(Math.max(0, widths[j] - dlen(c.t))) : c.t));
      let cells = parts[0];
      for (let j = 1; j < n; j++) cells += ' &' + (parts[j] === '' ? '' : ' ' + parts[j]);
      const trail = m.alignInfo.padLast && r.sep ? ' ' : r.trail;
      s += r.pre + r.lead + cells + trail + r.sep;
    } else s += (r.dirty ? r.pre + r.lead + joinCells(r.cells) + r.trail : r.raw) + r.sep;
  }
  return s + m.tailText;
}

function serialize(m, o) {
  let head = m.head;
  let delta = 0;
  if (m.specDirty && m.specRange && m.spec) {
    const ns = specToString(m.spec);
    delta = ns.length - (m.specRange[1] - m.specRange[0]);
    head = head.slice(0, m.specRange[0]) + ns + head.slice(m.specRange[1]);
  }
  if (m.keyOps && m.keyOps.length && m.isTblr && m.groupRange) {
    const ga = m.groupRange[0];
    const gb = m.groupRange[1] + delta;
    head = head.slice(0, ga) + applyKeyOps(head.slice(ga, gb), m.keyOps) + head.slice(gb);
  }
  const doAlign = !!(o && o.align && m.alignInfo && m.alignInfo.aligned && (!m.isTblr || m.spread));
  const body = doAlign ? bodyText(m, true) : serializeBody(m);
  return m.prefix + head + body + m.suffix;
}

// a tblr table that was in the "Format tblr" style stays in it after an edit
function restyleTblr(docText, env, out, opts) {
  const names = ['tblr', 'longtblr', 'talltblr'];
  const orig = docText.slice(env.start, env.end);
  const e0 = E4.findEnvs(docText, names).find((e) => e.start === env.start);
  if (!e0) return out;
  const f0 = E4.formatTblrEnv(docText, e0, opts);
  if (f0.skip || f0.text !== orig) return out;
  const nd = docText.slice(0, env.start) + out + docText.slice(env.end);
  const e1 = E4.findEnvs(nd, names).find((e) => e.start === env.start);
  if (!e1) return out;
  const f1 = E4.formatTblrEnv(nd, e1, opts);
  return f1.skip ? out : f1.text;
}

/* ---------------------------------- editing ---------------------------------- */
const hlineOnly = (pre) => /^\s*\\hline\s*$/.test(pre);

// whether `t` can stand inside one cell: no bare & \\ % and balanced braces
function checkCellText(t) {
  const s = splitTop(t, 'cell');
  if (!s.balanced) return 'дужки { } у клітинці не збалансовані';
  if (s.pieces.length > 1) return 'у клітинці «&» розділяє клітинки; для символу пиши \\&';
  if (splitTop(t, 'row').pieces.length > 1) return 'у клітинці «\\\\» починає новий рядок; щоб розбити рядок у клітинці, використай \\makecell або \\shortstack';
  if (hasBareComment(t)) return 'у клітинці «%» починає коментар; для символу пиши \\%';
  return '';
}

function padRows(m) {
  const w = width(m);
  for (const r of m.rows) {
    const have = r.cells.reduce((s, c) => s + c.span, 0);
    for (let k = have; k < w; k++) r.cells.push(mkEmpty());
    if (have < w) r.dirty = true;
  }
}

// logical start of every cell of a row
const starts = (row) => { let p = 0; return row.cells.map((c) => { const s = p; p += c.span; return s; }); };

// \SetCell anchors: [{ r, cell, s }] with the logical start in the row
function anchors(m) {
  const out = [];
  m.rows.forEach((row, r) => { const st = starts(row); row.cells.forEach((cell, k) => { if (cell.kind === 'sc' && (cell.cs > 1 || cell.rs > 1)) out.push({ r, cell, s: st[k] }); }); });
  return out;
}

// the index of the cell that starts at the logical column `l` of the row (-1: that column lies inside a \multicolumn)
const cellIndexAt = (row, l) => starts(row).indexOf(l);

/* ------------------------- merged cells: both ways of writing them ------------------------- */
// \SetCell[r=2,c=3]{…} in the body, or cell{i}{j} = {r=2,c=3}{…} in the options of tblr
const SPAN_KEY_RE = /^\s*[rc]\s*=\s*\d+\s*$/;
const HAS_SPAN_RE = /(?:^|,)\s*[rc]\s*=\s*\d+/;
const spanKey = (src, k) => { const m = new RegExp('(?:^|,)\\s*' + k + '\\s*=\\s*(\\d+)').exec(src); return m ? Math.max(1, +m[1]) : 1; };
// the {…} groups at the start of the value of an item: "{r=2}{c}" -> ['r=2', 'c']
function valueGroups(val) {
  const out = [];
  let k = 0;
  for (;;) {
    while (/\s/.test(val[k] || '')) k++;
    if (val[k] !== '{') break;
    const e = E4.matchBracket(val, k);
    if (e < 0) break;
    out.push(val.slice(k + 1, e));
    k = e + 1;
  }
  return out;
}

// the merged cells written in the options: cell{2}{1} = {r=2,c=3}{…}. Only plain numbers in both selectors can be followed
// (lists, ranges, odd / even are reported as `complex` and left as they are). a, b: where the item stands in the options text
function parseOptSpans(specSrc) {
  const spans = [];
  let complex = false;
  rewriteKeys(specSrc, (key, sels, val, a, b) => {
    if (key === 'cell') {
      const g = valueGroups(val);
      if (g.length && HAS_SPAN_RE.test(g[0])) {
        const rs = spanKey(g[0], 'r');
        const cs = spanKey(g[0], 'c');
        if (rs > 1 || cs > 1) {
          if (/^\d+$/.test(sels[0].trim()) && /^\d+$/.test(sels[1].trim())) spans.push({ r: +sels[0] - 1, c: +sels[1] - 1, rs, cs, groups: g, a, b });
          else complex = true;
        }
      }
    }
    return sels;
  });
  return { spans, complex };
}

// every merged cell of the table, from both places: { r, c (0-based, c logical), rs, cs, src: 'cell' | 'opts', opt }
function spanList(m) {
  const out = [];
  for (const a of anchors(m)) out.push({ r: a.r, c: a.s, rs: a.cell.rs, cs: a.cell.cs, src: 'cell' });
  for (const o of m.optSpans || []) out.push({ r: o.r, c: o.c, rs: o.rs, cs: o.cs, src: 'opts', opt: o });
  return out;
}

const spanHit = (a, b) => !(a.r > b.r + b.rs - 1 || b.r > a.r + a.rs - 1 || a.c > b.c + b.cs - 1 || b.c > a.c + a.cs - 1);
const where1 = (s) => '(' + (s.r + 1) + ', ' + (s.c + 1) + ')';
const whereSrc = (s) => (s.src === 'cell' ? '\\SetCell' : 'cell{' + (s.r + 1) + '}{' + (s.c + 1) + '} у параметрах');

// what is wrong with the merged cells: two of them on one cell or on top of each other, one that leaves the table,
// text in a cell that a merge covers. [{ kind, msg, at: [span…], cells: [{ r, c }] }]
function spanConflicts(m, list) {
  const L = list || spanList(m);
  const nr = m.rows.length;
  const w = width(m);
  const out = [];
  for (const s of L) if (s.r + s.rs > nr || s.c + s.cs > w) out.push({ kind: 'bounds', at: [s], cells: [{ r: s.r, c: s.c }], msg: 'Об\'єднання в клітинці ' + where1(s) + ' (' + whereSrc(s) + ') виходить за межі таблиці.' });
  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      const a = L[i];
      const b = L[j];
      if (a.r === b.r && a.c === b.c) {
        out.push({ kind: a.src === b.src ? 'dup-same' : 'dup', at: [a, b], cells: [{ r: a.r, c: a.c }], msg: 'Клітинка ' + where1(a) + ' об\'єднана двічі: ' + (a.src === b.src ? 'у параметрах таблиці є два записи cell{' + (a.r + 1) + '}{' + (a.c + 1) + '} із r=/c=' : 'і в \\SetCell, і в параметрах таблиці (cell{' + (a.r + 1) + '}{' + (a.c + 1) + '})') + '. Результат у PDF неоднозначний: залиш одне.' });
      } else if (spanHit(a, b)) {
        out.push({ kind: 'overlap', at: [a, b], cells: [{ r: a.r, c: a.c }, { r: b.r, c: b.c }], msg: 'Об\'єднання клітинок ' + where1(a) + ' (' + whereSrc(a) + ') і ' + where1(b) + ' (' + whereSrc(b) + ') перекриваються.' });
      }
    }
  }
  const seen = new Set();
  for (const s of L) {
    if (s.r + s.rs > nr || s.c + s.cs > w) continue;
    for (let rr = s.r; rr < s.r + s.rs; rr++) {
      const row = m.rows[rr];
      const st = starts(row);
      for (let ll = s.c; ll < s.c + s.cs; ll++) {
        if (rr === s.r && ll === s.c) continue;
        const k = st.indexOf(ll);
        const key = rr + ':' + ll;
        if (k >= 0 && row.cells[k].inner.trim() && !seen.has(key)) {
          seen.add(key);
          out.push({ kind: 'hidden', at: [s], cells: [{ r: rr, c: ll }], msg: 'У клітинці (' + (rr + 1) + ', ' + (ll + 1) + '), закритій об\'єднанням ' + where1(s) + ', є текст: у PDF його, найімовірніше, не буде видно.' });
        }
      }
    }
  }
  if (m.optComplex) out.push({ kind: 'complex', at: [], cells: [], msg: 'У параметрах таблиці є об\'єднання зі складним селектором (cell{1-3}{2}, odd, список): редактор їх не показує, правь їх у коді.' });
  return out;
}

// \SetCell[opts]{mand} rest, taken apart. lead: the "@ " of spreadtab
function scParse(t) {
  const m = /^((?:@\s*)?)\\SetCell\s*/.exec(t);
  if (!m) return null;
  let i = m[0].length;
  let opts = null;
  let mand = null;
  if (t[i] === '[') { const e = E4.matchBracket(t, i); if (e > 0) { opts = t.slice(i + 1, e); i = e + 1; } }
  while (/\s/.test(t[i] || '')) i++;
  if (t[i] === '{') { const e = E4.matchBracket(t, i); if (e > 0) { mand = t.slice(i + 1, e); i = e + 1; } }
  return { lead: m[1], opts, mand, rest: t.slice(i).replace(/^\s+/, '') };
}
const scBuild = (p) => p.lead + '\\SetCell' + (p.opts ? '[' + p.opts + ']' : '') + '{' + (p.mand || '') + '}' + (p.rest ? ' ' + p.rest : '');
// the optional argument of \SetCell with the spans rs / cs (1 = no key)
function optsWith(opts, rs, cs) {
  const keep = splitCommas(opts || '').map((x) => x.trim()).filter((x) => x && !SPAN_KEY_RE.test(x));
  if (rs > 1) keep.push('r=' + rs);
  if (cs > 1) keep.push('c=' + cs);
  return keep.join(',');
}
// a cell that already has \SetCell gets other spans (1×1: the key goes, and the command with it when nothing else is in it)
function setScSpan(cell, rs, cs) {
  const p = scParse(cell.t);
  if (!p) return cell;
  p.opts = optsWith(p.opts, rs, cs);
  if (!p.opts && !(p.mand || '').trim()) return classify(p.lead + p.rest);
  return classify(scBuild(p));
}
// a plain cell becomes \SetCell[…]{mand} text
function toSc(m, cell, rs, cs, mand) {
  const at = m.spread ? /^@\s*/.exec(cell.t) : null;
  return classify(scBuild({ lead: at ? at[0] : '', opts: optsWith('', rs, cs), mand: mand || '', rest: at ? cell.t.slice(at[0].length) : cell.t }));
}

const OPT_MSG = 'Тут діє об\'єднання з параметрів таблиці (cell{…}{…} = {r=…,c=…}): перенеси його в \\SetCell (лампочка в редакторі), і тоді рядки та стовпці можна додавати й видаляти.';
const optInsideRow = (m, at) => (m.optSpans || []).some((o) => o.rs > 1 && o.r < at && at <= o.r + o.rs - 1);
const optInsideCol = (m, at) => (m.optSpans || []).some((o) => o.cs > 1 && o.c < at && at <= o.c + o.cs - 1);
const optCoversRow = (m, r) => (m.optSpans || []).some((o) => o.rs > 1 && o.r <= r && r <= o.r + o.rs - 1);
const optCoversCol = (m, c) => (m.optSpans || []).some((o) => o.cs > 1 && o.c <= c && c <= o.c + o.cs - 1);
const optRowsHit = (m, r1, r2) => (m.optSpans || []).some((o) => o.rs > 1 && !(o.r + o.rs - 1 < r1 || o.r > r2));

function replaceCell(m, ref, next) {
  for (const row of m.rows) { const k = row.cells.indexOf(ref); if (k >= 0) { row.cells[k] = next; row.dirty = true; return; } }
}

function insertRow(m, at, cells, below) {
  const w = width(m);
  const nBefore = m.rows.length;
  // a merged \SetCell[r=..] region that the new row falls into grows by one row
  const grow = anchors(m).filter((a) => a.cell.rs > 1 && a.r < at && at <= a.r + a.cell.rs - 1);
  const ref = m.rows[below && at > 0 ? at - 1 : Math.min(at, nBefore - 1)];
  const row = { pre: '', lead: ref.lead, trail: ref.trail, cells: cells || Array.from({ length: w }, mkEmpty), sep: ref.sep, raw: '', dirty: true };
  if (at < nBefore) {
    if (below) {
      // "below row r": the new row stays in the zone of row r, above the rules that precede the next row (an \hline is repeated)
      row.pre = hlineOnly(m.rows[at].pre) ? m.rows[at].pre : '';
    } else {
      // "above row k": the rules above row k move up to the new row
      row.pre = m.rows[at].pre;
      if (!hlineOnly(m.rows[at].pre)) { m.rows[at].pre = ''; m.rows[at].dirty = true; }
    }
    if (!row.sep) row.sep = ' \\\\';
    m.rows.splice(at, 0, row);
  } else {
    const last = m.rows[m.rows.length - 1];
    if (!last.sep) { last.sep = ' \\\\'; last.dirty = true; row.sep = ''; row.trail = last.trail; last.trail = ''; }
    else row.sep = last.sep;
    row.pre = '';
    m.rows.push(row);
  }
  for (const g of grow) replaceCell(m, g.cell, withScOpt(g.cell, 'r', g.cell.rs + 1));
  const op = { t: 'rowIns', at, n: nBefore };
  m.keyOps.push(op);
  shiftFormulas(m, op);
}

const hasSpan = (m) => hasSpans(m);

// ops: setCell {r,c,text} · addRow {at} · delRow {r} · moveRow {r,dir} · addCol {at} · delCol {c} · moveCol {c,dir} · setAlign {c,a} · fill {r,c,rows}
function applyOp(model, op) {
  const m = clone(model);
  const err = (e) => ({ error: e });
  const nRows = m.rows.length;
  switch (op.type) {
    case 'setCell': {
      const row = m.rows[op.r];
      if (!row || !row.cells[op.c]) return err('Немає такої клітинки.');
      const t = String(op.text).replace(/\s*[\r\n]+\s*/g, ' ').trim();
      const bad = checkCellText(t);
      if (bad) return err(bad);
      const cell = row.cells[op.c];
      if (cell.inner === t) return { model: m, same: true };
      row.cells[op.c] = classify(rebuild(cell, t));
      row.dirty = true;
      return { model: m };
    }
    case 'addRow': {
      const at0 = Math.max(0, Math.min(nRows, op.at));
      if (optInsideRow(m, at0)) return err(OPT_MSG);
      insertRow(m, at0, null, !!op.below);
      return { model: m };
    }
    case 'delRow': {
      if (nRows <= 1) return err('Не можна видалити єдиний рядок.');
      const r = op.r;
      if (!m.rows[r]) return err('Немає такого рядка.');
      if (optCoversRow(m, r)) return err(OPT_MSG);
      const shrink = anchors(m).filter((a) => a.cell.rs > 1 && a.r < r && r <= a.r + a.cell.rs - 1);
      const [gone] = m.rows.splice(r, 1);
      m.keyOps.push({ t: 'rowDel', at: r });
      shiftFormulas(m, { t: 'rowDel', at: r });
      for (const g of shrink) replaceCell(m, g.cell, withScOpt(g.cell, 'r', g.cell.rs - 1));
      if (r < m.rows.length) { m.rows[r].pre = gone.pre + (hlineOnly(gone.pre) && hlineOnly(m.rows[r].pre) ? '' : m.rows[r].pre); m.rows[r].dirty = true; }
      else {
        const prev = m.rows[m.rows.length - 1];
        if (!m.tailText.trim() && !gone.sep) { prev.sep = ''; prev.trail = gone.trail; prev.dirty = true; }
        else if (gone.pre.trim()) m.tailText = gone.pre + m.tailText;
      }
      return { model: m };
    }
    case 'moveRow': {
      const a = op.r;
      const b = a + (op.dir < 0 ? -1 : 1);
      if (!m.rows[a] || !m.rows[b]) return err('Далі пересувати нікуди.');
      if (m.rows[a].cells.concat(m.rows[b].cells).some((c) => c.rs > 1)) return err('Рядок входить в об\'єднану по вертикалі клітинку (\\SetCell[r=…]): переставляй у коді.');
      if (optRowsHit(m, Math.min(a, b), Math.max(a, b))) return err(OPT_MSG);
      const t = m.rows[a].cells;
      m.rows[a].cells = m.rows[b].cells;
      m.rows[b].cells = t;
      m.rows[a].dirty = m.rows[b].dirty = true;
      m.keyOps.push({ t: 'rowSwap', a: a + 1, b: b + 1 });
      return { model: m };
    }
    case 'dupRows': {
      const r1 = Math.max(0, op.r1);
      const r2 = Math.min(nRows - 1, op.r2);
      if (!(r1 <= r2)) return err('Немає такого рядка.');
      for (let k = r1; k <= r2; k++) if (m.rows[k].cells.some((c) => c.rs > 1)) return err('Рядок входить в об\'єднану по вертикалі клітинку (\\SetCell[r=…]): дублюй у коді.');
      if (optRowsHit(m, r1, r2 + 1)) return err(OPT_MSG);
      const copies = m.rows.slice(r1, r2 + 1).map((r) => r.cells.map((c) => classify(c.t)));
      copies.forEach((cells, k) => insertRow(m, r2 + 1 + k, cells, true));
      return { model: m };
    }
    case 'clear': {
      for (let r = Math.max(0, op.r1); r <= Math.min(nRows - 1, op.r2); r++) {
        const row = m.rows[r];
        for (let c = Math.max(0, op.c1); c <= Math.min(row.cells.length - 1, op.c2); c++) row.cells[c] = classify(rebuild(row.cells[c], ''));
        row.dirty = true;
      }
      return { model: m };
    }
    case 'addCol': {
      padRows(m);
      const w = width(m);
      const at = Math.max(0, Math.min(w, op.at));
      if (optInsideCol(m, at)) return err(OPT_MSG);
      const grow = anchors(m).filter((x) => x.cell.cs > 1 && x.s < at && at <= x.s + x.cell.cs - 1);
      for (const row of m.rows) {
        const st = starts(row);
        let done = false;
        for (let k = 0; k < row.cells.length && !done; k++) {
          const c = row.cells[k];
          if (at <= st[k]) { row.cells.splice(k, 0, mkEmpty()); done = true; }
          else if (at < st[k] + c.span) { row.cells[k] = withMcSpan(c, c.span + 1); done = true; } // inside \multicolumn: it stays merged and grows
        }
        if (!done) row.cells.push(mkEmpty());
        row.dirty = true;
      }
      for (const g of grow) replaceCell(m, g.cell, withScOpt(g.cell, 'c', g.cell.cs + 1));
      m.keyOps.push({ t: 'colIns', at, n: w });
      shiftFormulas(m, { t: 'colIns', at });
      if (m.spec) {
        const toks = m.spec.tokens;
        const ref = toks[Math.min(at, toks.length - 1)];
        if (ref) { toks.splice(at, 0, { pre: ref.pre, unit: ref.unit }); m.specDirty = true; }
      }
      return { model: m };
    }
    case 'delCol': {
      padRows(m);
      if (width(m) <= 1) return err('Не можна видалити єдиний стовпець.');
      const col = op.c;
      if (col < 0 || col >= width(m)) return err('Немає такого стовпця.');
      if (optCoversCol(m, col)) return err(OPT_MSG);
      const shrink = anchors(m).filter((x) => x.cell.cs > 1 && x.s < col && col <= x.s + x.cell.cs - 1);
      for (const row of m.rows) {
        const st = starts(row);
        for (let k = 0; k < row.cells.length; k++) {
          const c = row.cells[k];
          if (col < st[k] || col >= st[k] + c.span) continue;
          if (c.span > 1) row.cells[k] = withMcSpan(c, c.span - 1);
          else if (c.kind === 'sc' && c.cs > 1 && row.cells[k + 1]) {
            // the merged cell loses its first column: the next cell becomes the anchor
            const a2 = withScOpt(c, 'c', c.cs - 1);
            row.cells[k + 1] = classify(a2.head + (c.inner ? ' ' + c.inner : ''));
            row.cells.splice(k, 1);
          } else row.cells.splice(k, 1);
          break;
        }
        row.dirty = true;
      }
      for (const g of shrink) replaceCell(m, g.cell, withScOpt(g.cell, 'c', g.cell.cs - 1));
      m.keyOps.push({ t: 'colDel', at: col });
      shiftFormulas(m, { t: 'colDel', at: col });
      if (m.spec && m.spec.tokens[col]) { m.spec.tokens.splice(col, 1); m.specDirty = true; }
      return { model: m };
    }
    case 'moveCol': {
      if (hasSpan(m)) return err('Є об\'єднані клітинки: стовпці в таблиці з ними переставляй у коді (додавати й видаляти можна).');
      padRows(m);
      const a = op.c;
      const b = a + (op.dir < 0 ? -1 : 1);
      if (a < 0 || b < 0 || a >= width(m) || b >= width(m)) return err('Далі пересувати нікуди.');
      for (const r of m.rows) { const t = r.cells[a]; r.cells[a] = r.cells[b]; r.cells[b] = t; r.dirty = true; }
      m.keyOps.push({ t: 'colSwap', a: a + 1, b: b + 1 });
      if (m.spec && m.spec.tokens[a] && m.spec.tokens[b]) { const t = m.spec.tokens[a].unit; m.spec.tokens[a].unit = m.spec.tokens[b].unit; m.spec.tokens[b].unit = t; m.specDirty = true; }
      return { model: m };
    }
    case 'setAlign': {
      if (!m.spec || !m.spec.tokens[op.c]) return err('Немає опису стовпця (colspec).');
      const u = m.spec.tokens[op.c].unit;
      const nu = withAlign(u, op.a);
      if (nu === u) return err('Вирівнювання цього типу стовпця (' + u + ') змінюй у коді.');
      m.spec.tokens[op.c].unit = nu;
      m.specDirty = true;
      return { model: m };
    }
    case 'fill': {
      const rowsIn = op.rows || [];
      for (let i = 0; i < rowsIn.length; i++) {
        while (op.r + i >= m.rows.length) insertRow(m, m.rows.length);
        const row = m.rows[op.r + i];
        for (let j = 0; j < rowsIn[i].length; j++) {
          const c = op.c + j;
          if (!row.cells[c]) break;
          const t = String(rowsIn[i][j]).replace(/\s*[\r\n]+\s*/g, ' ').trim();
          const bad = checkCellText(t);
          if (bad) return err('Рядок ' + (op.r + i + 1) + ': ' + bad);
          row.cells[c] = classify(rebuild(row.cells[c], t));
        }
        row.dirty = true;
      }
      return { model: m };
    }
    case 'merge': {
      if (!m.isTblr) return err('Об\'єднання клітинок працює в tblr, longtblr і talltblr. У tabular використовуй \\multicolumn і \\multirow у коді.');
      padRows(m);
      const w = width(m);
      let a = { r1: Math.max(0, Math.min(op.r1, op.r2)), r2: Math.min(nRows - 1, Math.max(op.r1, op.r2)), c1: Math.max(0, Math.min(op.c1, op.c2)), c2: Math.min(w - 1, Math.max(op.c1, op.c2)) };
      const L = spanList(m);
      // a merged cell that the selection only touches is taken whole (as in a spreadsheet)
      for (let again = true; again;) {
        again = false;
        for (const sp of L) {
          const sr2 = sp.r + sp.rs - 1;
          const sc2 = sp.c + sp.cs - 1;
          const touches = !(sp.r > a.r2 || sr2 < a.r1 || sp.c > a.c2 || sc2 < a.c1);
          if (touches && (sp.r < a.r1 || sr2 > a.r2 || sp.c < a.c1 || sc2 > a.c2)) {
            if (sr2 >= nRows || sc2 >= w) return err('Існуюче об\'єднання виходить за межі таблиці: спершу виправ його в коді.');
            a = { r1: Math.min(a.r1, sp.r), r2: Math.max(a.r2, sr2), c1: Math.min(a.c1, sp.c), c2: Math.max(a.c2, sc2) };
            again = true;
          }
        }
      }
      if (a.r1 === a.r2 && a.c1 === a.c2) return err('Виділи кілька клітинок, щоб їх об\'єднати.');
      const R = a.r2 - a.r1 + 1;
      const C = a.c2 - a.c1 + 1;
      if (L.some((sp) => sp.r === a.r1 && sp.c === a.c1 && sp.rs === R && sp.cs === C)) return err('Ці клітинки вже об\'єднані.');
      const inside = [];
      for (let rr = a.r1; rr <= a.r2; rr++) {
        const row = m.rows[rr];
        const st = starts(row);
        for (let ll = a.c1; ll <= a.c2; ll++) {
          const k = st.indexOf(ll);
          if (k < 0 || row.cells[k].kind === 'mc') return err('У виділенні є \\multicolumn: об\'єднуй такі клітинки в коді.');
          inside.push({ rr, k });
        }
      }
      const lost = inside.slice(1).filter((x) => m.rows[x.rr].cells[x.k].inner.trim()).length;
      if (lost && !op.confirmed) return { confirm: (lost === 1 ? 'В одній клітинці' : 'У ' + lost + ' клітинках') + ' виділення є текст: після об\'єднання лишиться тільки текст верхньої лівої клітинки. Об\'єднати?' };
      // merges written in the options that now lie inside the new one go (their span keys; other keys of the item stay)
      for (const sp of L) if (sp.src === 'opts' && sp.r >= a.r1 && sp.r + sp.rs - 1 <= a.r2 && sp.c >= a.c1 && sp.c + sp.cs - 1 <= a.c2) m.keyOps.push({ t: 'optDel', r: sp.r + 1, c: sp.c + 1, all: false });
      inside.slice(1).forEach((x) => { m.rows[x.rr].cells[x.k] = mkEmpty(); m.rows[x.rr].dirty = true; });
      const top = inside[0];
      const tc = m.rows[top.rr].cells[top.k];
      m.rows[top.rr].cells[top.k] = tc.kind === 'sc' ? setScSpan(tc, R, C) : toSc(m, tc, R, C, '');
      m.rows[top.rr].dirty = true;
      return { model: m };
    }
    case 'unmerge': {
      padRows(m);
      const L = spanList(m);
      const seen = new Set();
      let done = 0;
      for (const p of op.list || [{ r: op.r, c: op.c }]) {
        const sp = L.find((x) => p.r >= x.r && p.r <= x.r + x.rs - 1 && p.c >= x.c && p.c <= x.c + x.cs - 1);
        if (!sp) continue;
        const key = sp.src + ':' + sp.r + ':' + sp.c;
        if (seen.has(key)) continue;
        seen.add(key);
        if (sp.src === 'cell') {
          const row = m.rows[sp.r];
          const k = cellIndexAt(row, sp.c);
          if (k < 0) continue;
          row.cells[k] = setScSpan(row.cells[k], 1, 1);
          row.dirty = true;
        } else m.keyOps.push({ t: 'optDel', r: sp.r + 1, c: sp.c + 1, all: false });
        done++;
      }
      if (!done) return err('У виділенні немає об\'єднаних клітинок.');
      return { model: m };
    }
    case 'spansToOptions':
    case 'spansToCells': {
      const toOpts = op.type === 'spansToOptions';
      if (!m.isTblr) return err('Параметри таблиці (cell{…}{…}) є лише в tblr, longtblr і talltblr.');
      if (toOpts) {
        if (!m.spec) return err('Не вдалося знайти colspec у параметрах таблиці: перенеси об\'єднання в код вручну.');
        if (appendKeys(m.head.slice(m.groupRange[0], m.groupRange[1]), ['x']) === null) return err('Параметри таблиці закінчуються коментарем %: прибери його й повтори.');
      }
      padRows(m);
      const L = spanList(m);
      let list = L.filter((x) => x.src === (toOpts ? 'cell' : 'opts'));
      if (Number.isInteger(op.r) && Number.isInteger(op.c)) list = list.filter((x) => op.r >= x.r && op.r <= x.r + x.rs - 1 && op.c >= x.c && op.c <= x.c + x.cs - 1);
      if (!list.length) return err(toOpts ? 'Немає об\'єднань у \\SetCell, які можна перенести.' : 'Немає об\'єднань у параметрах таблиці (cell{i}{j} = {r=…,c=…}), які можна перенести.' + (m.optComplex ? ' Ті, що зі складним селектором (діапазон, список), переноси в коді.' : ''));
      const items = [];
      for (const sp of list) {
        const same = L.filter((x) => x.r === sp.r && x.c === sp.c && x !== sp);
        if (same.length) return err('Клітинка ' + where1(sp) + ' має два об\'єднання (' + whereSrc(same[0]) + '): спершу розв\'яжи конфлікт.');
        const row = m.rows[sp.r];
        const k = row ? cellIndexAt(row, sp.c) : -1;
        if (k < 0) return err('Клітинку ' + where1(sp) + ' не знайдено в таблиці.');
        const cell = row.cells[k];
        if (cell.kind === 'mc') return err('Клітинка ' + where1(sp) + ' містить \\multicolumn: переносити нічого.');
        if (toOpts) {
          const p = scParse(cell.t);
          items.push('cell{' + (sp.r + 1) + '}{' + (sp.c + 1) + '} = {' + (p.opts || '') + '}' + (p.mand && p.mand.trim() ? '{' + p.mand.trim() + '}' : ''));
          row.cells[k] = classify(p.lead + p.rest);
        } else if (cell.kind === 'sc') {
          // the cell has its own \SetCell already: only the span moves to it, the other keys of the item stay in the options
          row.cells[k] = setScSpan(cell, sp.rs, sp.cs);
          m.keyOps.push({ t: 'optDel', r: sp.r + 1, c: sp.c + 1, all: false });
        } else {
          const extra = splitCommas(sp.opt.groups[0]).map((x) => x.trim()).filter((x) => x && !SPAN_KEY_RE.test(x)).concat(sp.opt.groups.slice(1).map((x) => x.trim()).filter(Boolean));
          row.cells[k] = toSc(m, cell, sp.rs, sp.cs, extra.join(', '));
          m.keyOps.push({ t: 'optDel', r: sp.r + 1, c: sp.c + 1, all: true });
        }
        row.dirty = true;
      }
      if (toOpts) m.keyOps.push({ t: 'optAdd', items });
      return { model: m };
    }
    case 'spanKeep': {
      const L = spanList(m);
      const inCell = L.find((x) => x.src === 'cell' && x.r === op.r && x.c === op.c);
      const inOpts = L.find((x) => x.src === 'opts' && x.r === op.r && x.c === op.c);
      if (!inCell || !inOpts) return err('У цій клітинці немає конфлікту об\'єднань.');
      if (op.keep === 'cell') m.keyOps.push({ t: 'optDel', r: op.r + 1, c: op.c + 1, all: false });
      else {
        const row = m.rows[op.r];
        const k = cellIndexAt(row, op.c);
        if (k < 0) return err('Клітинку не знайдено в таблиці.');
        row.cells[k] = setScSpan(row.cells[k], 1, 1);
        row.dirty = true;
      }
      return { model: m };
    }
    default:
      return err('Невідома дія ' + op.type);
  }
}

/* ------------------------------------ colours ------------------------------------ */
const BASIC_COLORS = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255], magenta: [255, 0, 255], yellow: [255, 255, 0], gray: [128, 128, 128], darkgray: [64, 64, 64], lightgray: [191, 191, 191], orange: [255, 128, 0], brown: [191, 128, 64], lime: [191, 255, 0], olive: [128, 128, 0], pink: [255, 191, 191], purple: [191, 0, 64], teal: [0, 128, 128], violet: [128, 0, 128] };

// \definecolor / \colorlet of the project -> Map name -> { rgb } | { expr }
function colorDefs(texts) {
  const defs = new Map();
  const num = (s) => s.split(',').map((x) => parseFloat(x));
  for (const text of texts) {
    const src = String(text).split('\n').map((l) => { const i = l.search(/(^|[^\\])%/); return i < 0 ? l : l.slice(0, i + (l[i] === '%' ? 0 : 1)); }).join('\n');
    let m;
    const reD = /\\(?:definecolor|providecolor)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}\s*\{([^}]+)\}\s*\{([^}]*)\}/g;
    while ((m = reD.exec(src)) !== null) {
      const name = m[1].trim();
      const model = m[2].trim();
      const v = m[3].trim();
      let rgb = null;
      if (/^html$/i.test(model) && /^[0-9a-fA-F]{6}$/.test(v)) rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
      else if (model === 'rgb') { const n = num(v); if (n.length === 3 && n.every(Number.isFinite)) rgb = n.map((x) => Math.round(x * 255)); }
      else if (model === 'RGB') { const n = num(v); if (n.length === 3 && n.every(Number.isFinite)) rgb = n; }
      else if (model === 'gray') { const g = parseFloat(v); if (Number.isFinite(g)) rgb = [Math.round(g * 255), Math.round(g * 255), Math.round(g * 255)]; }
      else if (model === 'cmyk') { const n = num(v); if (n.length === 4 && n.every(Number.isFinite)) rgb = [0, 1, 2].map((i) => Math.round(255 * (1 - n[i]) * (1 - n[3]))); }
      if (rgb) defs.set(name, { rgb });
    }
    const reL = /\\colorlet\s*\{([^}]+)\}\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    while ((m = reL.exec(src)) !== null) defs.set(m[1].trim(), { expr: m[2].trim() });
  }
  return defs;
}

function colorByName(name, defs, depth) {
  if (depth > 8) return null;
  if (defs && defs.has(name)) { const d = defs.get(name); return d.rgb ? d.rgb : colorExpr(d.expr, defs, depth + 1); }
  return BASIC_COLORS[name] ? BASIC_COLORS[name] : null;
}

// xcolor expressions: name, name!30, name!30!other, chained
function colorExpr(expr, defs, depth) {
  const parts = String(expr).trim().split('!').map((x) => x.trim());
  let cur = colorByName(parts[0], defs, depth || 0);
  if (!cur) return null;
  for (let i = 1; i < parts.length; i += 2) {
    const p = parseFloat(parts[i]);
    if (!Number.isFinite(p)) return null;
    const other = parts[i + 1] ? colorByName(parts[i + 1], defs, depth || 0) : [255, 255, 255];
    if (!other) return null;
    cur = cur.map((v, k) => Math.round(v * p / 100 + other[k] * (100 - p) / 100));
  }
  return cur;
}

const css = (rgb) => 'rgb(' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(',') + ')';
const lum = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;


/* ------------------------- numbered keys of the tblr preamble ------------------------- */
// each numbered selector in row{..}, column{..}, cell{..}{..}, hline{..}, vline{..} of the preamble goes through
// f(key, sels, value, from, to) -> sels | { sels, val } | null (drop the item). value: the text after "=" ({r=2}{c} of cell{1}{1} = {r=2}{c}),
// from / to: where the item stands in `spec`
function rewriteKeys(spec, f) {
  let out = '';
  let i = 0;
  let depth = 0;
  const n = spec.length;
  while (i < n) {
    const c = spec[i];
    if (c === '%') { const e = spec.indexOf('\n', i); const j = e < 0 ? n : e; out += spec.slice(i, j); i = j; continue; }
    if (c === '\\') { out += spec.slice(i, i + 2); i += 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && /[a-z]/.test(c) && (i === 0 || /[\s,]/.test(spec[i - 1]))) {
      const m = /^(row|column|cell|hline|vline)((?:\s*\{[^{}]*\}){1,2})(\s*=\s*)/.exec(spec.slice(i));
      if (m) {
        const sels = [];
        m[2].replace(/\{([^{}]*)\}/g, (all, g) => { sels.push(g); return all; });
        const want = m[1] === 'cell' ? 2 : 1;
        // end of the value: a {...} group or text up to the next top-level comma
        let j = i + m[0].length;
        if (spec[j] === '{') {
          const e = E4.matchBracket(spec, j);
          j = e < 0 ? n : e + 1;
          // cell{1}{1} = {r=2}{c}: the keys of the cell stand in a second group
          if (m[1] === 'cell' && e >= 0) { let k = j; while (/\s/.test(spec[k] || '')) k++; if (spec[k] === '{') { const e2 = E4.matchBracket(spec, k); if (e2 >= 0) j = e2 + 1; } }
        } else { let d = 0; for (; j < n; j++) { const ch = spec[j]; if (ch === '{') d++; else if (ch === '}') { if (d === 0) break; d--; } else if (ch === ',' && d === 0) break; } }
        if (sels.length === want) {
          const res = f(m[1], sels, spec.slice(i + m[0].length, j), i, j);
          const next = res === null || Array.isArray(res) ? res : res.sels;
          if (next === null) {
            let k = j;
            while (k < n && /[ \t]/.test(spec[k])) k++;
            if (spec[k] === ',') k++;
            // a line that held only this item disappears with it
            const lineStartBlank = /\n[ \t]*$/.test(out);
            while (k < n && /[ \t]/.test(spec[k])) k++;
            if (lineStartBlank && spec[k] === '\n') { out = out.replace(/[ \t]*$/, ''); k++; }
            i = k;
            continue;
          }
          out += m[1] + next.map((g) => '{' + g + '}').join('') + m[3] + (res && !Array.isArray(res) && res.val !== undefined ? res.val : spec.slice(i + m[0].length, j));
          i = j;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

// maps every number / range of a selector list; fn(a, b) -> [a, b] | null. odd, even, "-", "2-", Z stay as they are
function mapSel(sel, fn) {
  const out = [];
  for (const p0 of splitCommas(sel)) {
    const p = p0.trim();
    let m;
    if ((m = /^(\d+)$/.exec(p))) { const r = fn(+m[1], +m[1]); if (r) out.push(r[0] === r[1] ? String(r[0]) : r[0] + '-' + r[1]); }
    else if ((m = /^(\d+)\s*-\s*(\d+)$/.exec(p))) { const r = fn(+m[1], +m[2]); if (r) out.push(r[0] === r[1] ? String(r[0]) : r[0] + '-' + r[1]); }
    else out.push(p);
  }
  return out.length ? out.join(',') : null;
}

// numbers of the selectors of this preamble: { auto: they can be shifted, manual: odd / even / open ranges that depend on the count }
function keyInfo(spec) {
  const info = { auto: false, manual: false };
  rewriteKeys(spec, (key, sels) => {
    for (const sel of sels) for (const p0 of splitCommas(sel)) {
      const p = p0.trim();
      if (/^\d+$/.test(p) || /^\d+\s*-\s*\d+$/.test(p)) info.auto = true;
      else if (/^(odd|even)$/.test(p) || /^\d*\s*-\s*\d*$/.test(p) && p !== '-') info.manual = true;
    }
    return sels;
  });
  return info;
}

const insMap = (n1) => (a, b) => (a >= n1 ? [a + 1, b + 1] : b >= n1 ? [a, b + 1] : [a, b]);
const delMap = (n0) => (a, b) => (b < n0 ? [a, b] : a > n0 ? [a - 1, b - 1] : a === b ? null : [a, b - 1]);
const swapMap = (x, y) => (a, b) => (a === b ? (a === x ? [y, y] : a === y ? [x, x] : [a, b]) : [a, b]);

// the span keys r= / c= of the item cell{R}{C} (1-based) go; what else the item says stays (in one group), an empty item goes
// altogether, and with `all` the whole item goes
function dropOptSpan(spec, R, C, all) {
  const out = rewriteKeys(spec, (key, sels, val) => {
    if (key !== 'cell' || sels[0].trim() !== String(R) || sels[1].trim() !== String(C)) return sels;
    const g = valueGroups(val);
    if (!g.length || !HAS_SPAN_RE.test(g[0])) return sels;
    if (all) return null;
    const keys = splitCommas(g[0]).map((x) => x.trim()).filter((x) => x && !SPAN_KEY_RE.test(x)).concat(g.slice(1).map((x) => x.trim()).filter(Boolean));
    if (!keys.length) return null;
    return { sels, val: '{' + keys.join(', ') + '}' };
  });
  // the item that stood last took its comma with it, the one before keeps its own: a comma that was not there before goes
  return /,\s*$/.test(out) && !/,\s*$/.test(spec) ? out.replace(/,(\s*)$/, '$1') : out;
}

// new items at the end of the options (the text between the braces of \begin{tblr}{…}); null when a comment ends them.
// A bare column specification (\begin{tblr}{ccc}) becomes colspec={ccc}
function appendKeys(spec, items) {
  if (!items || !items.length) return spec;
  if (!/=/.test(spec)) return 'colspec={' + spec.trim() + '}, ' + items.join(', ');
  const trimmed = spec.replace(/\s+$/, '');
  const tail = spec.slice(trimmed.length);
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
  if (/(^|[^\\])%/.test(lastLine)) return null;
  const multi = /\n/.test(trimmed);
  const indent = multi ? (/\n([ \t]*)\S[^\n]*$/.exec(trimmed) || ['', ''])[1] : '';
  const sep = multi ? ',\n' + indent : ', ';
  const comma = /,$/.test(trimmed);
  return (comma ? trimmed.slice(0, -1) : trimmed) + sep + items.join(sep) + (comma ? ',' : '') + tail;
}

// op: { t: 'rowIns'|'rowDel'|'rowSwap'|'colIns'|'colDel'|'colSwap', at, n, a, b } · { t: 'optDel', r, c, all } · { t: 'optAdd', items }
function applyKeyOps(spec, ops) {
  let cur = spec;
  for (const op of ops) {
    if (op.t === 'optDel') { cur = dropOptSpan(cur, op.r, op.c, !!op.all); continue; }
    if (op.t === 'optAdd') { cur = appendKeys(cur, op.items) || cur; continue; }
    const rows = op.t.startsWith('row');
    let fn;
    let lineFn;
    if (op.t.endsWith('Ins')) {
      fn = insMap(op.at + 1);
      lineFn = (N) => (op.at === op.n ? (N >= op.at + 1 ? N + 1 : N) : (N >= op.at + 2 ? N + 1 : N));
    } else if (op.t.endsWith('Del')) {
      fn = delMap(op.at + 1);
      lineFn = (N) => (N >= op.at + 2 ? N - 1 : N);
    } else { fn = swapMap(op.a, op.b); lineFn = null; }
    cur = rewriteKeys(cur, (key, sels) => {
      const out = sels.slice();
      if (rows) {
        if (key === 'row' || key === 'cell') { const r = mapSel(sels[0], fn); if (r === null) return null; out[0] = r; }
        else if (key === 'hline' && lineFn) { const r = mapSel(sels[0], (a, b) => [lineFn(a), lineFn(b)]); if (r === null) return null; out[0] = r; }
      } else if (key === 'column' || (key === 'cell')) {
        const k = key === 'cell' ? 1 : 0;
        const r = mapSel(sels[k], fn);
        if (r === null) return null;
        out[k] = r;
      } else if (key === 'vline' && lineFn) { const r = mapSel(sels[0], (a, b) => [lineFn(a), lineFn(b)]); if (r === null) return null; out[0] = r; }
      return out;
    });
  }
  return cur;
}

// spreadtab formulas: c2 = column c, row 2. After inserting / deleting rows or columns the absolute references follow the cells
function shiftFormulas(m, op) {
  if (!m.spread) return;
  const fix = (t) => t.replace(/(?<![A-Za-z\\\d])([a-z])(\d+)(?![\d(A-Za-z])/g, (all, L, N) => {
    let col = L.charCodeAt(0) - 97;
    let row = +N;
    if (op.t === 'rowIns' && row >= op.at + 1) row++;
    else if (op.t === 'rowDel' && row > op.at + 1) row--;
    else if (op.t === 'colIns' && col >= op.at) col++;
    else if (op.t === 'colDel' && col > op.at) col--;
    else return all;
    return String.fromCharCode(97 + col) + row;
  });
  for (const r of m.rows) for (const c of r.cells) if (isFormula(m, c.t) && fix(c.t) !== c.t) { const nc = classify(fix(c.t)); Object.assign(c, nc); r.dirty = true; }
}

const REF_RE = /(?<![A-Za-z\\\d])[a-z]\d+(?![\d(A-Za-z])/;
const isFormula = (m, t) => !!m.spread && t !== '' && !/^@/.test(t) && !/^\\/.test(t) && /[A-Za-z]/.test(t);

/* ------------------------------ tblr styles (view only) ------------------------------ */
function splitCommas(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseProps(v) {
  const p = {};
  for (const it of splitCommas(v)) {
    const t = it.trim();
    let m;
    if ((m = /^bg\s*=\s*(.+)$/s.exec(t))) p.bg = m[1].trim();
    else if ((m = /^fg\s*=\s*(.+)$/s.exec(t))) p.fg = m[1].trim();
    else if ((m = /^font\s*=\s*(.+)$/s.exec(t))) { if (/\\bfseries|\\bf\b|\\textbf/.test(m[1])) p.bold = true; }
    else if ((m = /^mode\s*=\s*(i?math|dmath|text)\s*$/.exec(t))) p.mode = m[1] === 'text' ? 'text' : m[1] === 'dmath' ? 'dmath' : 'math';
    else if ((m = /^halign\s*=\s*([lcr])\s*$/.exec(t))) p.align = m[1];
    else if (/^[lcr]$/.test(t)) p.align = t;
  }
  return p;
}

function selMatch(sel, i, n) {
  for (const part0 of splitCommas(sel)) {
    const part = part0.trim();
    if (part === 'odd') { if (i % 2 === 1) return true; }
    else if (part === 'even') { if (i % 2 === 0) return true; }
    else if (part === '-' || part === '') { return true; }
    else if (part === 'Z') { if (i === n) return true; }
    else if (/^-?\d+$/.test(part)) { const k = parseInt(part, 10); if (k > 0 ? k === i : n + 1 + k === i) return true; }
    else {
      const r = /^(\d*|Z)\s*-\s*(\d*|Z)$/.exec(part); // Z = the last index
      if (r) { const end = (x, d) => (x === 'Z' ? n : x ? +x : d); if (i >= end(r[1], 1) && i <= end(r[2], n)) return true; }
    }
  }
  return false;
}

// the preamble of tblr (without colspec) -> [{ kind: 'row'|'column'|'cell', sels: [..], props }]
function parseStyleRules(specSrc) {
  const rules = [];
  for (const item of splitCommas(specSrc)) {
    const m = /^\s*(row|column|cell)((?:\s*\{[^{}]*\})+)\s*=\s*([\s\S]*)$/.exec(item);
    if (!m) continue;
    const sels = [];
    m[2].replace(/\{([^{}]*)\}/g, (all, g) => { sels.push(g); return all; });
    let v = m[3].trim();
    if (v.startsWith('{')) {
      if (m[1] === 'cell') v = valueGroups(v).join(',');
      else { const e = E4.matchBracket(v, 0); if (e > 0) v = v.slice(1, e); }
    }
    const props = parseProps(v);
    if (Object.keys(props).length) rules.push({ kind: m[1], sels, props });
  }
  return rules;
}

function styleOf(rules, r, c, nr, nc) {
  const out = {};
  for (const ru of rules) {
    const ok = ru.kind === 'row' ? selMatch(ru.sels[0], r, nr) : ru.kind === 'column' ? selMatch(ru.sels[0], c, nc) : (ru.sels.length >= 2 && selMatch(ru.sels[0], r, nr) && selMatch(ru.sels[1], c, nc));
    if (ok) Object.assign(out, ru.props);
  }
  return out;
}

// mode=math|imath|dmath|text in the options of a column type, e.g. Q[l,m,mode=dmath] -> 'dmath'
function modeOfUnit(unit) {
  const m = /^[A-Za-z]\[([^\]]*)\]/.exec(unit || '');
  return m ? (parseProps(m[1]).mode || '') : '';
}

// mode=... in the braces of \SetCell[r=2]{mode=dmath}
function modeOfSetCell(head) {
  const m = /^(?:@\s*)?\\SetCell\s*/.exec(head);
  if (!m) return '';
  let i = m[0].length;
  if (head[i] === '[') { const e = E4.matchBracket(head, i); if (e < 0) return ''; i = e + 1; }
  while (/\s/.test(head[i] || '')) i++;
  if (head[i] !== '{') return '';
  const e = E4.matchBracket(head, i);
  return e > 0 ? (parseProps(head.slice(i + 1, e)).mode || '') : '';
}

// mode= of the last \SetRow[r=2]{...} / \SetColumn[c=2]{...} in the commands before a row: { mode, n } or null
function setCmdMode(pre, name, key) {
  const re = new RegExp('\\\\' + name + '(?![A-Za-z])\\s*', 'g');
  let m, out = null;
  while ((m = re.exec(pre))) {
    let i = m.index + m[0].length, n = 1;
    if (pre[i] === '[') {
      const e = E4.matchBracket(pre, i);
      if (e < 0) break;
      const k = new RegExp('(?:^|,)\\s*' + key + '\\s*=\\s*(\\d+)').exec(pre.slice(i + 1, e));
      if (k) n = +k[1];
      i = e + 1;
    }
    while (/\s/.test(pre[i] || '')) i++;
    if (pre[i] !== '{') continue;
    const e = E4.matchBracket(pre, i);
    if (e < 0) break;
    const mode = parseProps(pre.slice(i + 1, e)).mode;
    if (mode) out = { mode, n };
  }
  return out;
}

/* ------------------------------------ view ------------------------------------ */
function toView(m, defs) {
  const w = width(m);
  const nr = m.rows.length;
  // regions covered by \SetCell[r=, c=] and by cell{i}{j} = {r=, c=} of the options; the latter are drawn on their cell
  const covered = new Set();
  const fromOpts = new Map();
  const spans = spanList(m);
  for (const a of spans) {
    for (let rr = a.r; rr < Math.min(nr, a.r + a.rs); rr++) {
      for (let cc = a.c; cc < a.c + a.cs; cc++) if (rr !== a.r || cc !== a.c) covered.add(rr + ':' + cc);
    }
    if (a.src === 'opts' && m.rows[a.r]) { const k = cellIndexAt(m.rows[a.r], a.c); if (k >= 0) fromOpts.set(a.r + ':' + k, a); }
  }
  const conflicts = spanConflicts(m, spans);
  const conflictAt = new Set();
  for (const c of conflicts) for (const p of c.cells) conflictAt.add(p.r + ':' + p.c);
  const resolve = (e) => (e ? colorExpr(e, defs, 0) : null);
  const modes = m.isTblr && m.spec ? m.spec.tokens.map((t) => modeOfUnit(t.unit)) : null;
  const rowSet = [], colSet = []; // mode= from \SetRow / \SetColumn (a \SetColumn before a row speaks about the columns from the first one)
  if (m.isTblr) {
    m.rows.forEach((row, r) => {
      const sr = setCmdMode(row.pre || '', 'SetRow', 'r');
      if (sr) for (let k = 0; k < sr.n; k++) rowSet[r + k] = sr.mode;
      const sc = setCmdMode(row.pre || '', 'SetColumn', 'c');
      if (sc) for (let k = 0; k < sc.n; k++) colSet[k] = sc.mode;
    });
  }
  const rows = m.rows.map((row, r) => {
    const st = starts(row);
    const rowColor = /\\rowcolor(?:\[[^\]]*\])?\{([^}]*)\}/.exec(row.pre);
    return {
      cells: row.cells.map((c, k) => {
        const col = st[k];
        let text = c.inner;
        let bgExpr = rowColor ? rowColor[1] : '';
        const cc = /^\\cellcolor(?:\[[^\]]*\])?\{([^}]*)\}\s*/.exec(text);
        if (cc) { bgExpr = cc[1]; text = text.slice(cc[0].length); }
        const sr = styleOf(m.styles || [], r + 1, col + 1, nr, w);
        const mode = (c.kind === 'sc' && modeOfSetCell(c.head)) || rowSet[r] || colSet[col] || sr.mode || (modes && modes[col]) || '';
        if (sr.bg) bgExpr = sr.bg;
        const bg = resolve(bgExpr);
        let fg = resolve(sr.fg);
        if (bg && !fg) fg = lum(bg) > 0.55 ? [0, 0, 0] : [255, 255, 255];
        const unknown = !!bgExpr && !bg;
        const hidden = covered.has(r + ':' + col) && !c.inner;
        const op = fromOpts.get(r + ':' + k);
        return {
          t: text, raw: c.inner, span: op ? op.cs : c.cs, rowspan: op ? op.rs : c.rs, kind: c.kind, hidden, formula: isFormula(m, c.t),
          fromOpts: !!op, conflict: conflictAt.has(r + ':' + col),
          style: { bg: bg ? css(bg) : '', fg: fg ? css(fg) : '', bold: !!sr.bold, align: sr.align || c.align || '', mode, unknownColor: unknown ? bgExpr : '' },
          cellcolor: cc ? cc[0] : ''
        };
      }),
      rule: /\\(hline|toprule|midrule|cline|cmidrule|specialrule|SetHline)/.test(row.pre),
      extra: row.pre.trim() ? row.pre.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
    };
  });
  return {
    env: m.env,
    width: w,
    align: m.spec ? m.spec.tokens.map((t) => alignOf(t.unit)) : null,
    units: m.spec ? m.spec.tokens.map((t) => t.unit) : null,
    canCols: true,
    colsWhy: '',
    merged: hasSpans(m),
    canMerge: !!m.isTblr,
    conflicts: conflicts.map((c) => c.msg),
    optSpans: (m.optSpans || []).length,
    spread: m.spread,
    indexedKeys: m.keyInfo.manual,
    keysAuto: m.keyInfo.auto,
    absRefs: m.spread && m.rows.some((r) => r.cells.some((c) => isFormula(m, c.t) && REF_RE.test(c.t))),
    rows,
    tailRule: /\\(hline|bottomrule)/.test(m.tailText)
  };
}

module.exports = { spanMap, convertSpans, spanList, spanConflicts, rowSpans, restyleTblr, applyKeyOps, rewriteKeys, keyInfo, classify, colorDefs, colorExpr, parseStyleRules, SUPPORTED, locateTables, tableAt, parseTable, applyOp, serialize, toView, tokenizeSpec, specToString, alignOf, withAlign, checkCellText, width, splitPrefix, splitTop };
