'use strict';
/* normalizePure.js: normalization of line breaks and blank lines, \[ ... \] -> equation*, citations, figure checks, user lint rules. No vscode. */
const { codePart, unwrapLines, wrapLines } = require('./texBasePure');
const { typography } = require('./typographyPure');
const { EQ_BEGIN_RE, VERB_BEGIN_RE, alignAllTables, braceEnd, envEnd, envTokensPure, frameSections, isRuleLine, pairEnvsPure, pushRefs } = require('./structurePure');

/* ------------------------ normalize: line breaks -------------------- */
const NB_VERBISH = /^(verbatim|Verbatim|lstlisting|minted|comment|tcblisting)\*?$/;
const NB_MATH = /^(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath)\*?$/;
const NB_BLOCKY = /^(tikzpicture|pgfpicture|tblr|longtblr|talltblr|tabular|tabularx|tabulary|longtable|array|axis)\*?$/;

// regions [s, e] (line numbers, inclusive) in which text must not be touched.
// kind 'blank': verbatim-like and formula environments; kind 'breaks': also tikz pictures and tables
function protectedRegions(lines, kind) {
  const out = [];
  const beginRe = /\\begin\{([A-Za-z]+\*?)\}/g;
  for (let i = 0; i < lines.length; i++) {
    const code = codePart(lines[i]);
    if (/(^|[^\\])\\\[/.test(code) && !/\\\]/.test(code.slice(code.search(/(^|[^\\])\\\[/)))) {
      let j = i + 1;
      while (j < lines.length && j < i + 300 && !/\\\]/.test(codePart(lines[j]))) j++;
      out.push({ s: i, e: Math.min(j, lines.length - 1) });
      i = Math.min(j, lines.length - 1);
      continue;
    }
    beginRe.lastIndex = 0;
    let m;
    let hit = null;
    while ((m = beginRe.exec(code)) !== null) {
      const n = m[1];
      if (NB_VERBISH.test(n) || NB_MATH.test(n) || (kind === 'breaks' && NB_BLOCKY.test(n))) { hit = m; break; }
    }
    if (!hit) continue;
    const end = envEnd(lines, hit[1], i, hit.index + hit[0].length);
    const last = end ? end.line : lines.length - 1;
    out.push({ s: i, e: last });
    i = last;
  }
  return out;
}

// mode: 'join' (one line per paragraph) or 'wrap' (break at `width`); formulas, verbatim, tikz, tables and the preamble are left alone
function applyLineBreaks(lines, mode, width, tab) {
  if (mode !== 'join' && mode !== 'wrap') return lines.slice();
  const n = lines.length;
  const prot = new Array(n).fill(false);
  for (const r of protectedRegions(lines, 'breaks')) for (let i = r.s; i <= r.e && i < n; i++) prot[i] = true;
  const docIdx = lines.findIndex((l) => /\\begin\{document\}/.test(codePart(l)));
  for (let i = 0; i < docIdx; i++) prot[i] = true;
  const out = [];
  let i = 0;
  while (i < n) {
    if (prot[i]) { out.push(lines[i]); i++; continue; }
    let j = i;
    while (j < n && !prot[j]) j++;
    const seg = lines.slice(i, j);
    out.push(...(mode === 'join' ? unwrapLines(seg) : wrapLines(seg, width || 90, tab || 4)));
    i = j;
  }
  return out;
}

/* ------------------------ normalize: blank lines -------------------- */
const BLANK_HEAD_RE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|addpart|addchap|addsec)\*?\s*(?:\[[^\]]*\])?\s*\{/;
const isHeadStart = (l) => BLANK_HEAD_RE.test(l) || EQ_BEGIN_RE.test(l);

// One blank line between paragraphs (`paragraph`), `heading` blank lines before and after every sectioning command
// (with its frame lines, \label and \hypertarget). Verbatim and formula environments are not touched, the blank
// lines at the very beginning and the very end of `lines` stay as they are.
function normalizeBlankLines(lines, o) {
  const para = Math.max(1, (o && o.paragraph) || 1);
  const head = Math.max(1, (o && o.heading) || 2);
  let a = 0;
  while (a < lines.length && lines[a].trim() === '') a++;
  let z = lines.length;
  while (z > a && lines[z - 1].trim() === '') z--;
  if (a >= z) return { lines: lines.slice(), count: 0 };
  const core = lines.slice(a, z);
  const n = core.length;
  const reg = new Array(n).fill(-1);
  protectedRegions(core, 'blank').forEach((r, k) => { for (let i = r.s; i <= r.e && i < n; i++) reg[i] = k; });
  const blocks = [];
  let prevEnd = -1;
  for (let i = 0; i < n; i++) {
    if (reg[i] >= 0 || !BLANK_HEAD_RE.test(core[i])) continue;
    const m = BLANK_HEAD_RE.exec(core[i]);
    const end = braceEnd(core, i, m[0].length - 1);
    let e = end ? end.line : i;
    let runIn = false;
    if (end) {
      const tail = core[end.line].slice(end.col).trim();
      if (tail && !tail.startsWith('%') && !/^(\\(label|hypertarget)\{[^}]*\}(\{[^}]*\})?\s*)+(%.*)?$/.test(tail)) runIn = true;
    }
    let s = i;
    let up = 0;
    while (s - 1 > prevEnd && up < 3 && reg[s - 1] < 0 && (/^\s*%/.test(core[s - 1]) || /^\s*\\hypertarget\{[^}]*\}(\{[^}]*\})?\s*$/.test(core[s - 1]))) { s--; up++; }
    if (!runIn) {
      while (e + 1 < n && /^\s*\\(label|hypertarget)\{[^}]*\}(\{[^}]*\})?\s*(%.*)?$/.test(core[e + 1])) e++;
      if (e + 1 < n && isRuleLine(core[e + 1]) && !(e + 2 < n && isHeadStart(core[e + 2]))) e++;
    }
    blocks.push({ s, e, runIn });
    prevEnd = e;
    i = e;
  }
  const startAt = new Map();
  const endAt = new Map();
  blocks.forEach((b) => { startAt.set(b.s, b); endAt.set(b.e, b); });
  const out = [];
  let count = 0;
  let prev = -1;
  for (let q = 0; q < n; q++) {
    if (core[q].trim() === '') continue;
    if (prev >= 0) {
      const orig = core.slice(prev + 1, q);
      const g = orig.length;
      if (reg[prev] >= 0 && reg[prev] === reg[q]) {
        out.push(...orig);
      } else {
        const pb = endAt.get(prev);
        const want = (pb && !pb.runIn) || startAt.get(q) ? head : g > 0 ? para : 0;
        if (want !== g || orig.some((l) => l !== '')) count++;
        for (let k = 0; k < want; k++) out.push('');
      }
    }
    out.push(core[q]);
    prev = q;
  }
  return { lines: lines.slice(0, a).concat(out, lines.slice(z)), count };
}

/* ------------------------------ normalize --------------------------- */
// o: { typography, displayMath, tables, lineBreaks: 'keep'|'join'|'wrap', wrapWidth, tabSize,
//      frames: { rules, opts } | null, blankLines: { paragraph, heading } | null, isTikz }
function normalizeLines(lines, o) {
  o = o || {};
  const st = { typography: 0, displayMath: 0, tables: 0, lineBreaks: 0, frames: 0, blank: 0 };
  let cur = lines.slice();
  if (o.typography !== false) {
    const t = typography(cur.join('\n'), { quotes: o.quotes });
    cur = t.text.split('\n');
    st.typography = t.count;
  }
  if (o.displayMath !== false) {
    const d = displayMathToEquation(cur);
    cur = d.lines;
    st.displayMath = d.count;
  }
  if (o.tables !== false) {
    const t = alignAllTables(cur);
    cur = t.lines;
    st.tables = t.count;
  }
  if ((o.lineBreaks === 'join' || o.lineBreaks === 'wrap') && !o.isTikz) {
    const next = applyLineBreaks(cur, o.lineBreaks, o.wrapWidth, o.tabSize);
    st.lineBreaks = next.length !== cur.length ? Math.abs(next.length - cur.length) : next.some((l, i) => l !== cur[i]) ? 1 : 0;
    cur = next;
  }
  if (o.frames) {
    const f = frameSections(cur, o.frames.rules, o.frames.opts);
    cur = f.lines;
    st.frames = f.count;
  }
  if (o.blankLines && !o.isTikz) {
    const b = normalizeBlankLines(cur, o.blankLines);
    cur = b.lines;
    st.blank = b.count;
  }
  return { lines: cur, stats: st };
}

/* ------------------- \[ ... \]  ->  equation* --------------------- */
const DEF_LINE_RE = /^\s*\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|def|gdef|edef|xdef|let|newenvironment|renewenvironment)\b/;

// Replaces every display-math pair \[ ... \] by \begin{equation*} ... \end{equation*}.
// Line breaks "\\[2pt]", verbatim-like environments, macro definitions and unpaired \[ or \] are left alone.
function displayMathToEquation(lines) {
  const skip = new Set();
  for (let i = 0; i < lines.length; i++) {
    const vb = VERB_BEGIN_RE.exec(lines[i]);
    if (!vb) continue;
    const e = envEnd(lines, vb[1], i, vb[0].length);
    const last = e ? e.line : lines.length - 1;
    for (let x = i; x <= last; x++) skip.add(x);
    i = last;
  }
  const toks = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i) || DEF_LINE_RE.test(lines[i])) continue;
    const code = codePart(lines[i]);
    for (let c = 0; c < code.length - 1; c++) {
      if (code[c] !== '\\') continue;
      const n = code[c + 1];
      if (n === '[') toks.push({ i, c, type: 'open' });
      else if (n === ']') toks.push({ i, c, type: 'close' });
      c++; // the escaped character (also pairs "\\")
    }
  }
  const edits = [];
  let open = null;
  let count = 0;
  for (const t of toks) {
    if (t.type === 'open') { open = open ? null : t; if (open === null) continue; }
    else if (open) {
      if (t.i - open.i <= 100) { edits.push(open, t); count++; }
      open = null;
    }
  }
  const out = lines.slice();
  edits.sort((a, b) => (a.i - b.i) || (b.c - a.c));
  for (const e of edits) {
    const s = out[e.i];
    out[e.i] = s.slice(0, e.c) + (e.type === 'open' ? '\\begin{equation*}' : '\\end{equation*}') + s.slice(e.c + 2);
  }
  return { lines: out, count };
}

/* ------------------------------ citations --------------------------- */
// \cite-like commands of biblatex/natbib: [{ name, line, col, len }]; `nociteAll` is true for \nocite{*}
function scanCites(text) {
  const cites = [];
  let nociteAll = false;
  const re = /\\([A-Za-z]*cite[A-Za-z]*)\*?(?:\[[^\]]*\]){0,2}\{/g;
  text.split(/\r?\n/).forEach((line, i) => {
    const code = codePart(line);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const cmd = m[1];
      if (/^(?:set|new|renew|provide|Declare|declare)|style/.test(cmd)) continue;
      const multi = /cites$/i.test(cmd);   // \cites{a}{b}, \parencites[..]{a}[..]{b}
      let pos = m.index + m[0].length - 1;  // at '{'
      for (;;) {
        const end = code.indexOf('}', pos);
        if (end < 0) break;
        const arg = code.slice(pos + 1, end);
        if (arg.trim() === '*' && /^nocite$/i.test(cmd)) nociteAll = true;
        else pushRefs(cites, arg, i, pos + 1);
        if (!multi) break;
        let q = end + 1;
        while (code[q] === '[') { const e2 = code.indexOf(']', q); if (e2 < 0) break; q = e2 + 1; }
        if (code[q] === '{') pos = q; else break;
      }
    }
  });
  return { cites, nociteAll };
}

// entries of a .bib file: [{ name, type, line, col, len }] (@comment, @string, @preamble are skipped)
function parseBibKeys(text) {
  const keys = [];
  const re = /^[ \t]*@([A-Za-z]+)[ \t]*[{(][ \t]*([^,\s{}()]+)[ \t]*,/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (/^(?:comment|string|preamble)$/i.test(m[1])) continue;
    const before = text.slice(0, m.index);
    const line = before.split('\n').length - 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    const col = m.index - lineStart + m[0].indexOf(m[2], m[0].indexOf(m[1]) + m[1].length);
    keys.push({ name: m[2], type: m[1].toLowerCase(), line, col, len: m[2].length });
  }
  return keys;
}

/* --------------------------- figure checks -------------------------- */
// figure / figure* / wrapfigure / wrapstuff[type=figure] without \caption or \label
function figureChecks(lines) {
  const out = [];
  const toks = envTokensPure(lines);
  const { pairs } = pairEnvsPure(toks);
  for (const [b, e] of pairs) {
    const t = toks[b];
    let isFig = /^(?:figure\*?|wrapfigure|sidewaysfigure\*?)$/.test(t.name);
    if (!isFig && t.name === 'wrapstuff') isFig = /type\s*=\s*figure/.test(codePart(lines[t.line]).slice(t.tokEnd));
    if (!isFig) continue;
    let cap = false;
    let lab = false;
    for (let ln = t.line; ln <= toks[e].line; ln++) {
      const code = codePart(lines[ln]);
      if (/\\(?:caption|captionof|sidecaption)\b/.test(code)) cap = true;
      if (/\\label\b/.test(code)) lab = true;
    }
    const name = t.name;
    if (!cap) out.push({ line: t.line, col: t.tokStart, len: t.tokEnd - t.tokStart, code: 'figure-no-caption', message: 'У «' + name + '» немає \\caption' });
    if (!lab) out.push({ line: t.line, col: t.tokStart, len: t.tokEnd - t.tokStart, code: 'figure-no-label', message: 'У «' + name + '» немає \\label' });
  }
  return out;
}

/* ------------------------- user lint rules -------------------------- */
// rules: [{ pattern, message, severity, flags, files }]; `files` is a regex tested against the file path (with /)
function lintRules(lines, rules, filePath) {
  const out = [];
  if (!Array.isArray(rules)) return out;
  const p = String(filePath || '').replace(/\\/g, '/');
  for (const r of rules) {
    if (!r || typeof r.pattern !== 'string' || !r.pattern) continue;
    let re;
    let fre = null;
    try {
      re = new RegExp(r.pattern, String(r.flags || '').replace(/[^imsu]/g, '') + 'g');
      if (r.files) fre = new RegExp(r.files);
    } catch (err) { continue; }
    if (fre && !fre.test(p)) continue;
    const sev = ['error', 'warning', 'information', 'hint'].includes(r.severity) ? r.severity : 'warning';
    const msg = r.message || ('Правило: ' + r.pattern);
    let n = 0;
    lines.forEach((line, i) => {
      const code = codePart(line);
      re.lastIndex = 0;
      let m;
      while (n < 500 && (m = re.exec(code)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        out.push({ line: i, col: m.index, len: m[0].length, severity: sev, code: 'lint-rule', message: msg });
        n++;
      }
    });
  }
  return out;
}

module.exports = {
  applyLineBreaks,
  displayMathToEquation,
  figureChecks,
  lintRules,
  normalizeBlankLines,
  normalizeLines,
  parseBibKeys,
  protectedRegions,
  scanCites,
};
