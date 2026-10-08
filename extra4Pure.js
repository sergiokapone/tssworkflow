'use strict';
/* TSS Workflow 0.5.1, logic without VS Code:
 *   formatTblr      options and body of tblr / longtblr / talltblr: one key per line, "=" aligned, keys grouped,
 *                   cells aligned in a grid (or one cell per line when a row is too wide)
 *   renumberBeamer  "% ==== Слайд N ====" banners around \begin{frame} ... \end{frame}
 * Nothing here touches the text it cannot parse: a table with a "%" inside a row, a \verb, a blank line inside a cell
 * or unbalanced braces is skipped with a reason. */

const P = require('./pure');

/* ------------------------------ scanning helpers ----------------------------- */
const VERB_ENVS = 'verbatim\\*?|Verbatim\\*?|lstlisting|minted|alltt|comment';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collapseWs = (s) => s.replace(/\s+/g, ' ').trim();

// ranges [from, to) of the text that are comments, verbatim-like environments or \verb|...|
function deadRanges(text) {
  const out = [];
  const n = text.length;
  const beginRe = new RegExp('^\\\\begin\\{(' + VERB_ENVS + ')\\}');
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '%') {
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      out.push([i, e]);
      i = e;
      continue;
    }
    if (c === '\\') {
      const rest = text.slice(i, i + 40);
      const vb = beginRe.exec(rest);
      if (vb) {
        const endTag = '\\end{' + vb[1] + '}';
        const e = text.indexOf(endTag, i + vb[0].length);
        const stop = e < 0 ? n : e + endTag.length;
        out.push([i, stop]);
        i = stop;
        continue;
      }
      const v = /^\\(verb\*?|lstinline|mintinline)/.exec(rest);
      if (v && rest[v[0].length] && !/[A-Za-z\s]/.test(rest[v[0].length])) {
        const d = rest[v[0].length];
        const e = text.indexOf(d, i + v[0].length + 1);
        const stop = e < 0 ? n : e + 1;
        out.push([i, stop]);
        i = stop;
        continue;
      }
      i += 2; // an escaped character: \% \& \\ ...
      continue;
    }
    i++;
  }
  return out;
}

function isDead(ranges, pos) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (pos < a) hi = mid - 1;
    else if (pos >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

// all \begin{env}...\end{env} of the given names outside comments and verbatim.
// { name, start, bodyStart, bodyEnd, end, hasNested }  (offsets in text)
function findEnvs(text, names) {
  const dead = deadRanges(text);
  const alt = names.map(escRe).join('|');
  if (!alt) return [];
  const re = new RegExp('\\\\(begin|end)\\{(' + alt + ')\\}', 'g');
  const stack = [];
  const envs = [];
  let m;
  while ((m = re.exec(text))) {
    if (isDead(dead, m.index)) continue;
    const tok = { name: m[2], index: m.index, end: m.index + m[0].length };
    if (m[1] === 'begin') { stack.push(tok); continue; }
    let k = stack.length - 1;
    while (k >= 0 && stack[k].name !== tok.name) k--;
    if (k < 0) continue;
    const b = stack[k];
    stack.length = k;
    envs.push({ name: b.name, start: b.index, bodyStart: b.end, bodyEnd: tok.index, end: tok.end });
  }
  envs.sort((a, b) => a.start - b.start);
  for (const e of envs) e.hasNested = envs.some((o) => o !== e && o.start > e.start && o.end <= e.end);
  return envs;
}

// index of the bracket that closes the one at text[i] ('{' or '['), or -1
function matchBracket(text, i, limit) {
  const open = text[i];
  let brace = 0;
  let sq = 0;
  const end = limit === undefined ? text.length : limit;
  for (let k = i; k < end; k++) {
    const ch = text[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '{') brace++;
    else if (ch === '}') {
      brace--;
      if (open === '{' && brace === 0) return k;
      if (brace < 0) return -1;
    } else if (open === '[' && brace === 0) {
      if (ch === '[') sq++;
      else if (ch === ']') { sq--; if (sq === 0) return k; }
    }
  }
  return -1;
}

const hasComment = (s) => /(^|[^\\])(\\\\)*%/.test(s);

// split s at top-level separators (outside {} and [])
function splitTop(s, sep) {
  const parts = [];
  let d = 0;
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') { cur += ch + (s[k + 1] || ''); k++; continue; }
    if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') d--;
    if (ch === sep && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// [key, value] at the first top-level "="; value is null for a flag such as "hlines"
function splitKeyVal(item) {
  let d = 0;
  for (let k = 0; k < item.length; k++) {
    const ch = item[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') d--;
    else if (ch === '=' && d === 0) return [item.slice(0, k), item.slice(k + 1)];
  }
  return [item, null];
}

/* ------------------------------ option formatting ---------------------------- */
const normColor = (s) => s.replace(/\s*!\s*/g, '!');

function fmtValue(v) {
  v = v.trim();
  if (v[0] === '{' && matchBracket(v, 0) === v.length - 1) {
    const inner = v.slice(1, -1);
    const items = splitTop(inner, ',').map((s) => s.trim()).filter(Boolean);
    if (items.some((it) => splitKeyVal(it)[1] !== null)) return '{' + items.map(fmtFlat).join(', ') + '}';
    return '{' + normColor(collapseWs(inner)) + '}';
  }
  return normColor(collapseWs(v));
}

function fmtFlat(item) {
  const [k, v] = splitKeyVal(item);
  const key = collapseWs(k);
  return v === null ? key : key + '=' + fmtValue(v);
}

// key order inside the options; the groups keep the original order within themselves, because a later
// key of the same kind overrides an earlier one. cell > row > column in tabularray does not depend on order.
const RANK_INNER = {
  colspec: 0, rowspec: 0, width: 0,
  rowhead: 1, rowfoot: 1,
  hlines: 2, vlines: 2, hline: 2, vline: 2, hborder: 2, vborder: 2,
  column: 3, columns: 3, row: 4, rows: 4, cell: 5, cells: 5
};
const RANK_OUTER = { caption: 0, entry: 1, label: 2, note: 3, remark: 4 };
const keyName = (k) => k.replace(/[\s{[].*$/s, '');

// [{key, val}] in the final order
function parseOptions(src, rankMap, sort) {
  const items = splitTop(src, ',').map((s) => s.trim()).filter(Boolean).map((it, idx) => {
    const [k, v] = splitKeyVal(it);
    const key = collapseWs(k);
    return { key, val: v === null ? null : fmtValue(v), idx, rank: keyName(key) in rankMap ? rankMap[keyName(key)] : 99 };
  });
  if (sort) items.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  return items;
}

const PAD_CAP = 16;
function optionLines(items, indent) {
  const kw = Math.max(0, ...items.filter((i) => i.val !== null && i.key.length <= PAD_CAP).map((i) => i.key.length));
  return items.map((i, n) => indent + (i.val === null ? i.key : i.key.padEnd(kw) + ' = ' + i.val) + (n < items.length - 1 ? ',' : ''));
}
const flatOptions = (items) => items.map((i) => (i.val === null ? i.key : i.key + '=' + i.val)).join(', ');

/* -------------- one-line \tikz[...]{...} laid out one statement per line (0.6.1) -------------- */
const isWordChar = (ch) => /[A-Za-z@]/.test(ch || ' ');

// statements of the body of a \tikz group:
//   { t: 'stmt', v }                      up to `;` at brace depth 0 (or up to a \foreach / \begin / \end that follows)
//   { t: 'foreach', head, body }          \foreach <header> { body }  (the last of the consecutive {..} groups is the body)
//   { t: 'begin', v } / { t: 'end', v }   \begin{scope}[...] / \end{scope}
// null when the braces do not balance
function tikzStatements(s) {
  const n = s.length;
  const out = [];
  let i = 0;
  const group = (j) => {
    let d = 0;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === '{') d++;
      else if (c === '}' && --d === 0) return j + 1;
    }
    return -1;
  };
  const bracket = (j) => {
    let d = 0;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === '{') { const e = group(j); if (e < 0) return -1; j = e - 1; continue; }
      if (c === '[') d++;
      else if (c === ']' && --d === 0) return j + 1;
    }
    return -1;
  };
  const wsEnd = (j) => { while (j < n && /\s/.test(s[j])) j++; return j; };
  const startsBlock = (j) => (s.startsWith('\\foreach', j) && !isWordChar(s[j + 8])) || /^\\(begin|end)\{/.test(s.slice(j, j + 8));
  while (true) {
    i = wsEnd(i);
    if (i >= n) break;
    if (s.startsWith('\\foreach', i) && !isWordChar(s[i + 8])) {
      let j = i + 8;
      let lastStart = -1;
      let last = -1;
      while (j < n) {
        if (s[j] === '{') {
          const e = group(j);
          if (e < 0) return null;
          lastStart = j;
          last = e;
          const p = wsEnd(e);
          if (s[p] === '{') { j = p; continue; }
          break;
        }
        if (s[j] === ';' || (j > i + 8 && startsBlock(j))) break;
        j++;
      }
      if (lastStart >= 0) {
        out.push({ t: 'foreach', head: s.slice(i, lastStart).trim(), body: s.slice(lastStart + 1, last - 1) });
        i = last;
        continue;
      }
    }
    const be = /^\\(begin|end)\{[^}]*\}/.exec(s.slice(i, i + 80));
    if (be) {
      let e = i + be[0].length;
      if (be[1] === 'begin') {
        const p = wsEnd(e);
        if (s[p] === '[') { const c = bracket(p); if (c < 0) return null; e = c; }
      }
      out.push({ t: be[1], v: s.slice(i, e) });
      i = e;
      continue;
    }
    let d = 0;
    let j = i;
    let end = -1;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '\\') {
        if (d === 0 && j > i && startsBlock(j)) { end = j; break; }
        j++;
        continue;
      }
      if (c === '{') d++;
      else if (c === '}') { d--; if (d < 0) return null; }
      else if (c === ';' && d === 0) { end = j + 1; break; }
    }
    if (d !== 0) return null;
    if (end < 0) end = n;
    out.push({ t: 'stmt', v: s.slice(i, end).trim() });
    i = end;
  }
  return out;
}

function tikzLines(stmts, level, unit, base, out) {
  let lv = level;
  for (const st of stmts) {
    const ind = base + unit.repeat(lv);
    if (st.t === 'foreach') {
      const inner = tikzStatements(st.body);
      if (!inner) return false;
      out.push(ind + st.head + ' {');
      if (!tikzLines(inner, lv + 1, unit, base, out)) return false;
      out.push(ind + '}');
    } else if (st.t === 'begin') {
      out.push(ind + st.v);
      lv++;
    } else if (st.t === 'end') {
      lv = Math.max(level, lv - 1);
      out.push(base + unit.repeat(lv) + st.v);
    } else out.push(ind + st.v);
  }
  return true;
}

// Lays out every inline \tikz[...]{...} that sits on ONE line and is at least opts.minLength (default 100) characters long:
//   \tikz[opts]{
//       statement;
//       \foreach ... {
//           statement;
//       }
//   }
// Ranges that already span several lines are not touched (so a second run changes nothing). Only whitespace changes;
// a result that differs from the input in anything else is dropped.
// opts: { unit: '    ', minLength: 100, only: [from, to] (offsets; ranges that touch it) } -> { text, formatted, skipped, found }
function formatInlineTikz(text, opts) {
  opts = opts || {};
  const unit = opts.unit || '    ';
  const minLen = typeof opts.minLength === 'number' ? opts.minLength : 100;
  const edits = [];
  const skipped = [];
  let found = 0;
  const lineOf = (o) => text.slice(0, o).split('\n').length;
  for (const [a, b] of P.tikzInlineRanges(text, [])) {
    const src = text.slice(a, b);
    if (!/^\\tikz(?![A-Za-z@])/.test(src) || src.includes('\n')) continue;
    if (opts.only && !(a < opts.only[1] && b > opts.only[0]) && !(opts.only[0] === opts.only[1] && a <= opts.only[0] && opts.only[0] <= b)) continue;
    found++;
    if (src.length < minLen) continue;
    // \tikz [options] { body }
    let j = 5;
    while (/\s/.test(src[j] || '')) j++;
    if (src[j] === '[') {
      let d = 0;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '{') { let g = 0; for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '{') g++; else if (src[j] === '}' && --g === 0) break; } continue; }
        if (src[j] === '[') d++;
        else if (src[j] === ']' && --d === 0) { j++; break; }
      }
    }
    while (/\s/.test(src[j] || '')) j++;
    if (src[j] !== '{' || src[src.length - 1] !== '}') { skipped.push({ line: lineOf(a), reason: '\\tikz без дужок {…}' }); continue; }
    const head = src.slice(0, j).trimEnd();
    const stmts = tikzStatements(src.slice(j + 1, -1));
    const ls = text.lastIndexOf('\n', a - 1) + 1;
    const base = /^[ \t]*/.exec(text.slice(ls, a))[0];
    const lines = [];
    if (!stmts || !tikzLines(stmts, 1, unit, base, lines)) { skipped.push({ line: lineOf(a), reason: 'дужки в коді TikZ не збігаються' }); continue; }
    if (lines.length < 2) continue;
    const res = head + '{\n' + lines.join('\n') + '\n' + base + '}';
    if (res.replace(/\s+/g, '') !== src.replace(/\s+/g, '')) { skipped.push({ line: lineOf(a), reason: 'результат відрізнявся б не лише пробілами' }); continue; }
    edits.push({ a, b, res });
  }
  let out = text;
  for (const e of edits.slice().reverse()) out = out.slice(0, e.a) + e.res + out.slice(e.b);
  return { text: out, formatted: edits.length, skipped, found };
}

/* ----------------------------- table body parsing ---------------------------- */
const RULE_CMD = /^\\(hline|cline|toprule|midrule|bottomrule|specialrule|cmidrule|hdashline|Hline)(?![A-Za-z])/;
const LEN_ARG = /^\s*[-+]?\s*(\d*\.?\d+)\s*[a-z]{2}\s*$|^\s*[-+]?\s*(\d*\.?\d*\s*)?\\[A-Za-z]+/;

// after \cmd: optional [..] and {..} groups
function ruleEnd(s, i) {
  let p = i;
  for (;;) {
    const c = s[p];
    if (c !== '[' && c !== '{') return p;
    const close = matchBracket(s, p);
    if (close < 0) return p;
    p = close + 1;
  }
}

// a cell keeps its line structure when it holds multi-line TikZ code (inline \tikz{...}, \tikzset{...} ...), because that code
// is written line by line on purpose, or a % comment (a comment ends at the line end: joining the lines would comment out
// the rest). Returns the cell text with "\n" between lines (the first line trimmed, the others indented relative to the
// least indented one, blank lines kept); a trailing "\n" means the last line ends with a comment, so whatever follows the
// cell (the next `&`, the row terminator) must start on a new line. null for an ordinary cell.
const lineHasComment = (l) => P.codePart(l) !== l;
function keepLines(c) {
  const hasComment = c.split('\n').some(lineHasComment);
  if (!hasComment && (!c.includes('\n') || P.tikzInlineRanges(c).length === 0)) return null;
  const ls = c.replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (ls.length && !ls[0].trim()) ls.shift();
  while (ls.length && !ls[ls.length - 1].trim()) ls.pop();
  if (ls.length < 2) {
    const one = ls.length ? ls[0].trim() : '';
    return lineHasComment(one) ? one + '\n' : one;
  }
  const rest = ls.slice(1);
  const wid = (l) => Array.from(/^[ \t]*/.exec(l)[0]).reduce((a, ch) => a + (ch === '\t' ? 4 : 1), 0);
  const min = Math.min(...rest.filter((l) => l.trim()).map(wid));
  const body = rest.map((l) => (l.trim() ? ' '.repeat(wid(l) - (Number.isFinite(min) ? min : 0)) + l.trim() : ''));
  const text = [ls[0].trim()].concat(body).join('\n');
  return lineHasComment(body[body.length - 1]) ? text + '\n' : text;
}

// body -> blocks [{type: 'row'|'rule'|'comment'|'blank', ...}] or { skip: reason, at: offset }
function parseBody(body) {
  const blocks = [];
  let cells = [];
  let buf = '';
  let depth = 0;
  let nest = 0;
  let nl = 0; // newlines seen at a row boundary since the last token
  let sameLine = false; // the last block ended on the current line
  const boundary = () => cells.length === 0 && buf.trim() === '' && depth === 0 && nest === 0;
  let blankInCell = false;
  const cleanCells = () => cells.map((c) => {
    const kept = keepLines(c);
    if (kept) return kept;
    if (/\n[ \t]*\n/.test(c)) blankInCell = true;
    return collapseWs(c);
  });
  const bad = (reason, at) => ({ skip: reason, at });
  const n = body.length;
  let i = 0;
  while (i < n) {
    const ch = body[i];
    if (boundary()) {
      if (ch === '\n') {
        nl++;
        if (nl === 2) blocks.push({ type: 'blank' });
        sameLine = false;
        buf = '';
        i++;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
      if (ch === '%') {
        let e = body.indexOf('\n', i);
        if (e < 0) e = n;
        const text = body.slice(i, e).replace(/\s+$/, '');
        const last = blocks[blocks.length - 1];
        if (sameLine && last && (last.type === 'row' || last.type === 'rule') && !last.tc) last.tc = text;
        else blocks.push({ type: 'comment', text });
        i = e;
        sameLine = false;
        nl = 0;
        continue;
      }
      const rm = RULE_CMD.exec(body.slice(i, i + 20));
      if (rm) {
        const e = ruleEnd(body, i + rm[0].length);
        blocks.push({ type: 'rule', text: body.slice(i, e) });
        i = e;
        sameLine = true;
        nl = 0;
        continue;
      }
      nl = 0;
      sameLine = false;
    }
    if (ch === '%') {
      // a comment inside a row: it stays in the cell text up to the line end (braces and & in it do not count)
      let e = body.indexOf('\n', i);
      if (e < 0) e = n;
      buf += body.slice(i, e);
      i = e;
      continue;
    }
    if (ch === '\\') {
      const nx = body[i + 1];
      if (nx === '\\') {
        if (depth === 0 && nest === 0) {
          let p = i + 2;
          let term = '\\\\';
          if (body[p] === '*') { term += '*'; p++; }
          if (body[p] === '[') {
            const close = body.indexOf(']', p);
            if (close > 0 && !body.slice(p, close).includes('\n') && LEN_ARG.test(body.slice(p + 1, close))) {
              term += body.slice(p, close + 1);
              p = close + 1;
            }
          }
          cells.push(buf);
          blocks.push({ type: 'row', cells: cleanCells(), term, tc: '' });
          cells = [];
          buf = '';
          i = p;
          sameLine = true;
          nl = 0;
          continue;
        }
        buf += '\\\\';
        i += 2;
        continue;
      }
      const rest = body.slice(i, i + 40);
      if (/^\\(verb|lstinline|mintinline)(?![A-Za-z])/.test(rest)) return bad('\\verb усередині таблиці', i);
      const be = /^\\(begin|end)\{([^}]*)\}/.exec(rest);
      if (be) {
        if (new RegExp('^(' + VERB_ENVS + ')$').test(be[2])) return bad('verbatim усередині таблиці', i);
        if (be[1] === 'begin') nest++;
        else if (nest > 0) nest--;
        buf += be[0];
        i += be[0].length;
        continue;
      }
      buf += ch + (nx === undefined ? '' : nx);
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) return bad('незбалансовані дужки', i);
    } else if (ch === '&' && depth === 0 && nest === 0) {
      cells.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (depth !== 0 || nest !== 0) return bad('незбалансовані дужки або вкладені оточення', n);
  if (cells.length || buf.trim()) {
    cells.push(buf);
    blocks.push({ type: 'row', cells: cleanCells(), term: '', tc: '' });
  }
  if (blankInCell) return bad('порожній рядок усередині клітинки', 0);
  while (blocks.length && blocks[0].type === 'blank') blocks.shift();
  while (blocks.length && blocks[blocks.length - 1].type === 'blank') blocks.pop();
  return { blocks };
}

/* ------------------------------- layout of rows ------------------------------ */
const dispLen = (s) => Array.from(s).length;
const indentWidth = (s, tab) => Array.from(s).reduce((a, c) => a + (c === '\t' ? tab : 1), 0);
const trimEnd = (s) => s.replace(/[ \t]+$/, '');

function layoutBody(blocks, indent, unit, opts) {
  const ind = indent + unit;
  const indW = indentWidth(ind, opts.tabSize);
  const rows = blocks.filter((b) => b.type === 'row');
  const isEmptyRow = (r) => r.cells.length === 1 && r.cells[0] === '';
  const isMulti = (r) => r.cells.some((c) => c.includes('\n'));
  const content = rows.filter((r) => !isEmptyRow(r) && !isMulti(r));
  // grid candidate
  const ncol = Math.max(0, ...content.map((r) => r.cells.length));
  const w = [];
  for (let j = 0; j < ncol; j++) w.push(Math.max(0, ...content.filter((r) => r.cells.length > j).map((r) => dispLen(r.cells[j]))));
  const termOf = (r) => (r.term ? ' ' + r.term : '');
  let grid = content.length > 0;
  for (const r of content) {
    let len = indW;
    for (let j = 0; j < r.cells.length; j++) len += w[j] + (j ? 3 : 0);
    len += termOf(r).length;
    if (len > opts.maxWidth) { grid = false; break; }
  }
  const lines = [];
  const withTc = (s, b) => trimEnd(s) + (b.tc ? ' ' + b.tc : '');
  for (const b of blocks) {
    if (b.type === 'blank') { lines.push(''); continue; }
    if (b.type === 'comment') { lines.push(ind + b.text); continue; }
    if (b.type === 'rule') { lines.push(withTc(ind + b.text, b)); continue; }
    if (isEmptyRow(b)) { lines.push(withTc(ind + (b.term || ''), b)); continue; }
    if (isMulti(b)) {
      // cells with multi-line TikZ code: first line as in the vertical layout, the rest one level deeper than the row
      const deeper = ind + unit;
      const last = b.cells.length - 1;
      b.cells.forEach((c, j) => {
        const brk = c.endsWith('\n'); // the last line of the cell ends with a comment
        const cl = (brk ? c.slice(0, -1) : c).split('\n');
        if (j === 0 && c === '') return;
        lines.push(trimEnd((j === 0 ? ind : deeper + '& ') + cl[0]));
        for (let k = 1; k < cl.length; k++) lines.push(trimEnd(deeper + cl[k]));
        if (j === last) {
          const t = termOf(b);
          if (!brk) lines[lines.length - 1] += t;
          else if (t) lines.push(deeper + t.trimStart());
        }
      });
      if (b.tc) lines[lines.length - 1] += ' ' + b.tc;
      continue;
    }
    if (grid) {
      const k = b.cells.length;
      const parts = b.cells.map((c, j) => (j < k - 1 || k === ncol ? c + ' '.repeat(Math.max(0, w[j] - dispLen(c))) : c));
      lines.push(withTc(ind + parts.join(' & ') + termOf(b), b));
      continue;
    }
    const single = ind + b.cells.join(' & ') + termOf(b);
    if (indentWidth(single, opts.tabSize) <= opts.maxWidth) { lines.push(withTc(single, b)); continue; }
    // vertical: the first cell, then "& cell" lines one level deeper
    const deeper = ind + unit;
    const last = b.cells.length - 1;
    b.cells.forEach((c, j) => {
      let s;
      if (j === 0) { if (c === '') return; s = ind + c; } else s = deeper + '& ' + c;
      if (j === last) s += termOf(b);
      lines.push(trimEnd(s));
    });
    if (b.tc) lines[lines.length - 1] += ' ' + b.tc;
  }
  return lines;
}

/* ---------------------------------- one table -------------------------------- */
// -> { text } or { skip: reason, at: offset }
function formatTblrEnv(src, env, opts) {
  opts = Object.assign({ maxWidth: 100, unit: '  ', tabSize: 2, sort: true }, opts);
  if (env.hasNested) return { skip: 'усередині є вкладена таблиця tblr; відформатуй внутрішню окремо', at: env.start };
  const lineStart = src.lastIndexOf('\n', env.start - 1) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart, env.start + 1))[0];
  // arguments: [outer]{inner}
  let outer = null;
  let inner = null;
  let p = env.bodyStart;
  for (;;) {
    let q = p;
    // blanks and empty "%" line-continuations between \begin{env} and the arguments; a "%" with text is kept, so the table is skipped
    for (;;) {
      while (q < env.bodyEnd && /\s/.test(src[q])) q++;
      if (src[q] !== '%') break;
      const eol = src.indexOf('\n', q);
      const text = src.slice(q + 1, eol < 0 ? src.length : eol);
      if (text.trim() !== '') return { skip: 'коментар з текстом між \\begin і параметрами', at: q };
      q = eol < 0 ? src.length : eol;
    }
    const c = src[q];
    if (c === '[' && outer === null && inner === null) {
      const close = matchBracket(src, q, env.bodyEnd);
      if (close < 0) return { skip: 'незакриті дужки в параметрах', at: q };
      outer = src.slice(q + 1, close);
      p = close + 1;
    } else if (c === '{' && inner === null) {
      const close = matchBracket(src, q, env.bodyEnd);
      if (close < 0) return { skip: 'незакриті дужки в параметрах', at: q };
      inner = src.slice(q + 1, close);
      p = close + 1;
    } else break;
  }
  if ((outer !== null && hasComment(outer)) || (inner !== null && hasComment(inner))) {
    return { skip: 'коментар усередині параметрів', at: env.start };
  }
  const body = src.slice(p, env.bodyEnd);
  const parsed = parseBody(body);
  if (parsed.skip) return { skip: parsed.skip, at: p + (parsed.at || 0) };
  const unit = opts.unit;
  let first = '\\begin{' + env.name + '}';
  const lines = [];
  let cur = first;
  const put = (src0, rank, open, close) => {
    const items = parseOptions(src0, rank, opts.sort);
    const flat = open + flatOptions(items) + close;
    if (items.length <= 2 && !items.some((i) => i.val !== null && /\n/.test(i.val)) && indentWidth(cur + flat, opts.tabSize) <= opts.maxWidth) {
      cur += flat;
    } else if (items.length === 0) {
      cur += open + close;
    } else {
      lines.push(cur + open);
      for (const l of optionLines(items, indent + unit)) lines.push(l);
      cur = indent + close;
    }
  };
  if (outer !== null) put(outer, RANK_OUTER, '[', ']');
  if (inner !== null) put(inner, RANK_INNER, '{', '}');
  lines.push(cur);
  for (const l of layoutBody(parsed.blocks, indent, unit, { maxWidth: opts.maxWidth, tabSize: opts.tabSize })) lines.push(l);
  lines.push(indent + '\\end{' + env.name + '}');
  return { text: lines.join('\n') };
}

/* ---------------------------------- whole text ------------------------------- */
const lineOf = (text, off) => text.slice(0, off).split('\n').length;

// opts: { envs, maxWidth, unit, tabSize, sort, include: Set of env.start offsets (default: all) }
// -> { text, found, formatted, skipped: [{ line, reason }] }
function formatTblr(text, opts) {
  opts = opts || {};
  const envs = findEnvs(text, opts.envs || ['tblr', 'longtblr', 'talltblr']);
  const res = { text, found: envs.length, formatted: 0, skipped: [] };
  const todo = envs.filter((e) => !opts.include || opts.include.has(e.start));
  let out = text;
  for (const e of todo.slice().reverse()) {
    const r = formatTblrEnv(text, e, opts);
    if (r.skip) { res.skipped.push({ line: lineOf(text, r.at === undefined ? e.start : r.at), reason: r.skip }); continue; }
    if (text.slice(e.start, e.end) === r.text) continue;
    out = out.slice(0, e.start) + r.text + out.slice(e.end);
    res.formatted++;
  }
  res.skipped.reverse();
  res.text = out;
  return res;
}

/* ------------------------------ beamer: slide numbers ------------------------ */
const RULE_W = 77;
const BANNER_RE = /^(\s*)%\s*=+\s*((?:Слайд|Slide))\s+(\d+|#+)\s*=+\s*$/i;
const RULE_RE = /^\s*%\s*={8,}\s*$/;

function stripComment(line) {
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '\\') { k++; continue; }
    if (line[k] === '%') return line.slice(0, k);
  }
  return line;
}

function banner(indent, word, n) {
  const mid = ' ' + word + ' ' + n + ' ';
  const fill = Math.max(3, RULE_W - 2 - 30 - mid.length);
  return indent + '% ' + '='.repeat(30) + mid + '='.repeat(fill);
}
const bottomRule = (indent) => indent + '% ' + '='.repeat(RULE_W - 2);

function isBeamerDoc(lines) {
  const code = lines.map(stripComment).join('\n');
  return /\\documentclass\s*(\[[^\]]*\])?\s*\{beamer\}/.test(code);
}

// lines -> { lines, isBeamer, frames, titleSkipped, inserted, renumbered, skipped }
// opts: { skipTitle: true, word: 'Слайд' }
function renumberBeamer(lines, opts) {
  opts = Object.assign({ skipTitle: true, word: 'Слайд' }, opts);
  const res = { lines, isBeamer: isBeamerDoc(lines), frames: 0, titleSkipped: 0, inserted: 0, renumbered: 0, skipped: 0 };
  if (!res.isBeamer) return res;
  const code = lines.map(stripComment);
  // lines inside verbatim-like environments do not count
  const vre = new RegExp('\\\\begin\\{(' + VERB_ENVS + ')\\}');
  const dead = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const m = vre.exec(code[i]);
    if (!m) continue;
    const endTag = '\\end{' + m[1] + '}';
    let j = i;
    while (j < lines.length && !code[j].includes(endTag)) { dead[j] = true; j++; }
    if (j < lines.length) dead[j] = true;
    i = j;
  }
  const frames = [];
  for (let i = 0; i < lines.length; i++) {
    if (dead[i]) continue;
    const re = /\\begin\{frame\}/g;
    let m;
    while ((m = re.exec(code[i]))) {
      let endLine = -1;
      let endCol = 0;
      for (let j = i; j < lines.length; j++) {
        const from = j === i ? m.index + m[0].length : 0;
        const k = code[j].indexOf('\\end{frame}', from);
        if (k >= 0) { endLine = j; endCol = k + '\\end{frame}'.length; break; }
      }
      let title = false;
      for (let j = i; j <= (endLine < 0 ? i : endLine); j++) if (/\\(titlepage|maketitle)(?![A-Za-z])/.test(code[j])) title = true;
      const atStart = /^\s*$/.test(code[i].slice(0, m.index));
      frames.push({ line: i, endLine, endCol, title, atStart, indent: /^[ \t]*/.exec(lines[i])[0] });
    }
  }
  res.frames = frames.length;
  if (!frames.length) return res;
  const before = new Map(); // line -> lines to insert above it
  const after = new Map(); // line -> lines to insert below it
  const replaced = new Map();
  let n = 0;
  for (const f of frames) {
    if (f.title && opts.skipTitle) { res.titleSkipped++; continue; }
    n++;
    if (!f.atStart) { res.skipped++; continue; }
    const prev = f.line > 0 ? BANNER_RE.exec(lines[f.line - 1]) : null;
    if (prev) {
      if (prev[3] !== String(n)) {
        replaced.set(f.line - 1, lines[f.line - 1].replace(/((?:Слайд|Slide)\s+)(\d+|#+)/i, '$1' + n));
        res.renumbered++;
      }
      continue;
    }
    before.set(f.line, [banner(f.indent, opts.word, n)]);
    res.inserted++;
    if (f.endLine >= 0 && /^\s*$/.test(lines[f.endLine].slice(f.endCol)) && !(f.endLine + 1 < lines.length && RULE_RE.test(lines[f.endLine + 1]))) {
      after.set(f.endLine, [bottomRule(f.indent)]);
    }
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (before.has(i)) out.push(...before.get(i));
    out.push(replaced.has(i) ? replaced.get(i) : lines[i]);
    if (after.has(i)) out.push(...after.get(i));
  }
  res.lines = out;
  return res;
}

/* ------------------------------ diff of two line lists ----------------------- */
// the smallest line range [s, e] of oldLines that has to be replaced by newLines.slice(s, ...) (at least one old line)
function diffRange(oldL, newL) {
  let p = 0;
  const max = Math.min(oldL.length, newL.length);
  while (p < max && oldL[p] === newL[p]) p++;
  let q = 0;
  while (q < max - p && oldL[oldL.length - 1 - q] === newL[newL.length - 1 - q]) q++;
  if (p === oldL.length && p === newL.length) return null;
  while (oldL.length - q - 1 < p) { if (p > 0) p--; else if (q > 0) q--; else break; }
  return { s: p, e: oldL.length - q - 1, lines: newL.slice(p, newL.length - q) };
}

module.exports = {
  deadRanges, findEnvs, matchBracket, splitTop, splitKeyVal, parseOptions, parseBody, formatTblrEnv, formatTblr,
  isBeamerDoc, renumberBeamer, banner, bottomRule, diffRange, RANK_INNER, RANK_OUTER, RULE_W,
  formatInlineTikz, tikzStatements, keepLines
};
