'use strict';
/* texBasePure.js: the base of the text helpers: splitting rows, code that typography must not touch (tikz, protected commands), line wrapping. No vscode. */
const path = require('path');

/* splitting table rows, paragraph unwrap, code ranges that no rule may touch, line wrapping */
// split one physical line into cells; returns null if the line is not a self-contained row
function splitRow(line) {
  let depth = 0;
  const cells = [];
  let cur = '';
  let tail = null;
  let comment = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      const nx = line[i + 1];
      if (nx === '\\' && depth === 0) { tail = line.slice(i).trim(); break; }
      cur += ch + (nx === undefined ? '' : nx);
      i++;
      continue;
    }
    if (ch === '%') { comment = line.slice(i).trim(); break; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === '&' && depth === 0) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (depth !== 0) return null;
  cells.push(cur);
  return { cells: cells.map((c) => c.trim()), tail, comment };
}

const dispLen = (s) => Array.from(s).length;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // a string as a regular expression
const posix = (p) => String(p).split(path.sep).join('/'); // a path with / on every system
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - dispLen(s)));

function alignLines(lines) {
  let lastContent = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && !t.startsWith('%')) lastContent = i;
  });
  const rows = lines.map((l, i) => {
    const r = splitRow(l);
    if (!r || r.cells.length < 2) return null;
    if (r.tail === null && i !== lastContent) return null; // multi-line row: leave alone
    r.indent = /^\s*/.exec(l)[0];
    return r;
  });
  // one common indent: the shortest one (a row with an empty first cell has extra spaces in front of '&')
  const found = rows.filter(Boolean);
  if (!found.length) return lines;
  const indent = found.map((r) => r.indent).reduce((a, b) => (b.length < a.length ? b : a));
  const width = [];
  rows.forEach((r) => {
    if (!r) return;
    r.indent = indent;
    r.cells.forEach((c, j) => {
      if (j === r.cells.length - 1 && r.tail === null) return; // long unterminated last cell must not push \\
      width[j] = Math.max(width[j] || 0, dispLen(c));
    });
  });
  return lines.map((l, i) => {
    const r = rows[i];
    if (!r) return l;
    const n = r.cells.length;
    let out = r.indent;
    for (let j = 0; j < n - 1; j++) out += padTo(r.cells[j], width[j]) + ' & ';
    if (r.tail !== null) out += padTo(r.cells[n - 1], width[n - 1]) + ' ' + r.tail;
    else out += r.cells[n - 1] + (r.comment ? ' ' + r.comment : '');
    return out;
  });
}


const HARD_START = new RegExp(
  '^\\s*(\\\\(begin|end|part|chapter|section|subsection|subsubsection|paragraph|label|hypertarget|' +
    'includegraphics|localinput|input|include|usepackage|documentclass|newcommand|renewcommand|def|' +
    'bigskip|medskip|smallskip|newpage|clearpage|centering|hline|midrule|toprule|bottomrule)\\b|\\\\[\\[\\]])'
);
const START_ONLY = /^\s*\\(item|caption|captionbox)\b/;
const stripEsc = (l) => l.replace(/\\./g, '');

function lineKind(l) {
  const t = l.trim();
  if (!t || t.startsWith('%')) return 'hard';
  if (HARD_START.test(l)) return 'hard';
  if (stripEsc(l).includes('&')) return 'hard';
  if (START_ONLY.test(l)) return 'start';
  return 'text';
}

function noJoinAfter(l) {
  return stripEsc(l).includes('%') || /\\\\\s*(\[[^\]]*\])?\s*$/.test(l);
}

function canJoin(a, b) {
  return lineKind(a) !== 'hard' && lineKind(b) === 'text' && !noJoinAfter(a);
}

function unwrapLines(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && canJoin(lines[j], lines[j + 1])) j++;
    if (j === i) out.push(lines[i]);
    else {
      const indent = /^\s*/.exec(lines[i])[0];
      out.push(indent + lines.slice(i, j + 1).map((x) => x.trim()).join(' '));
    }
    i = j + 1;
  }
  return out;
}


/* ===================================================================== *
 * NEW pure helpers (no VS Code API): wrap, typography, sentences, table
 * operations, labels, syntax checks, environment conversion.
 * ===================================================================== */
function codePart(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

const hasComment = (l) => stripEsc(l).includes('%');

/* ---- code that no typography rule may touch: inline \tikz{...}, \tikzset{...}, the user's own commands, % tss-ignore ---- */
// command -> number of {..} groups that are code. `tikz` and `tikzstyle` have their own forms (see tikzInlineRanges)
const TIKZ_BUILTIN = { tikzset: 1, tikzstyle: 'style', pgfkeys: 1, pgfset: 1, pgfplotsset: 1, tikzmath: 1, pgfmathsetmacro: 2, pgfmathparse: 1 };
let userProtected = {};

// ["mytikz", "\\myfig:2"] -> { mytikz: 1, myfig: 2 }; entries that are not a command name (with an optional :N) are dropped
function parseProtectedCommands(list) {
  const out = {};
  for (const it of Array.isArray(list) ? list : []) {
    const m = /^\\?([A-Za-z@]+)(?::(\d))?$/.exec(String(it).trim());
    if (m && m[1] !== 'tikz') out[m[1]] = m[2] ? Math.max(1, +m[2]) : 1;
  }
  return out;
}
// the list from tssworkflow.protectedCommands; used whenever no list is passed explicitly
function setProtectedCommands(list) { userProtected = parseProtectedCommands(list); }

const cmdReCache = new Map();
function protectedCmdRe(names) {
  const key = names.join('|');
  let re = cmdReCache.get(key);
  if (!re) { re = new RegExp('\\\\(' + names.join('|') + ')(?![A-Za-z@])', 'y'); cmdReCache.set(key, re); }
  return re;
}

// ranges [from, to) of code in `text`. `extra` (a list as in tssworkflow.protectedCommands) replaces the stored list.
//   \tikz[opts]{...}             also over several lines
//   \tikz \draw ...;             up to the first `;` outside braces (not past a blank line)
//   \tikzset{...} and the rest of TIKZ_BUILTIN, and the commands of the user's list: [opts] and the given number of {..} groups
function tikzInlineRanges(text, extra) {
  const user = extra === undefined ? userProtected : parseProtectedCommands(extra);
  const table = Object.assign({}, user, TIKZ_BUILTIN);
  const names = Object.keys(table).concat('tikz').sort((x, y) => y.length - x.length);
  const re = protectedCmdRe(names);
  const out = [];
  const n = text.length;
  const skipWs = (j) => { while (j < n && /\s/.test(text[j])) j++; return j; };
  // index just after the group opened at `j` (text[j] is the opener); -1 if it never closes
  const group = (j, open, close) => {
    let depth = 0;
    for (; j < n; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c === '%') { while (j < n && text[j] !== '\n') j++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
    }
    return -1;
  };
  // after the command name at `j`: [..] groups, then `want` {..} groups; end of the last group found, or -1
  const argsEnd = (j, want) => {
    let p = skipWs(j);
    while (text[p] === '[') { const e = group(p, '[', ']'); if (e < 0) return -1; p = skipWs(e); }
    let end = -1;
    for (let g = 0; g < want; g++) {
      if (text[p] !== '{') return end;
      const e = group(p, '{', '}');
      if (e < 0) return -1;
      end = e;
      p = skipWs(e);
    }
    return end;
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '%') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c !== '\\') { i++; continue; }
    re.lastIndex = i;
    const tm = re.exec(text);
    if (tm) {
      const name = tm[1];
      const at = i + tm[0].length;
      let end = -1;
      if (name === 'tikz') {
        let j = skipWs(at);
        if (text[j] === '[') { const e = group(j, '[', ']'); j = e < 0 ? -1 : skipWs(e); }
        if (j >= 0) {
          if (text[j] === '{') end = group(j, '{', '}');
          else {
            // `\tikz \draw ...;`: up to the first `;` outside braces, but not past a blank line
            let depth = 0;
            for (let k = j; k < n; k++) {
              const d = text[k];
              if (d === '\\') { k++; continue; }
              if (d === '%') { while (k < n && text[k] !== '\n') k++; continue; }
              if (d === '\n' && /^\s*\n/.test(text.slice(k + 1))) break;
              if (d === '{') depth++;
              else if (d === '}') depth--;
              else if (d === ';' && depth <= 0) { end = k + 1; break; }
            }
          }
        }
      } else if (table[name] === 'style') {
        // \tikzstyle{name}=[...]  or  \tikzstyle name=[...]
        const k = text.indexOf('[', skipWs(at));
        if (k >= 0 && k - at < 80) end = group(k, '[', ']');
      } else {
        end = argsEnd(at, table[name]);
      }
      if (end > i) { out.push([i, end]); i = end; continue; }
    }
    i += 2; // skip `\x`
  }
  return out;
}

// "% tss-ignore" markers -> inclusive line ranges [from, to]:
//   code % tss-ignore          this line
//   % tss-ignore-next          the next line (a bare "% tss-ignore" on a line of its own does the same)
//   % tss-ignore-start / -end  everything between (to the end of the file if -end is missing)
const IGNORE_RE = /^%+\s*tss-ignore(?:-(next|start|end))?(?![\w-])/i;
function ignoreLineRanges(lines) {
  const out = [];
  let open = -1;
  lines.forEach((l, i) => {
    const code = codePart(l);
    const m = IGNORE_RE.exec(l.slice(code.length));
    if (!m) return;
    const kind = (m[1] || '').toLowerCase();
    if (kind === 'start') { if (open < 0) open = i + 1; }
    else if (kind === 'end') { if (open >= 0) { if (i - 1 >= open) out.push([open, i - 1]); open = -1; } }
    else if (kind === 'next' || code.trim() === '') { if (i + 1 < lines.length) out.push([i + 1, i + 1]); }
    else out.push([i, i]);
  });
  if (open >= 0 && open < lines.length) out.push([open, lines.length - 1]);
  return out;
}
function ignoredLineSet(lines) {
  const s = new Set();
  for (const [a, b] of ignoreLineRanges(lines)) for (let i = a; i <= b; i++) s.add(i);
  return s;
}

// offsets [from, to) of the ignored lines (without the last line break)
function ignoreRanges(text) {
  const lines = text.split('\n');
  const starts = [];
  let o = 0;
  for (const l of lines) { starts.push(o); o += l.length + 1; }
  return ignoreLineRanges(lines).map(([a, b]) => [starts[a], starts[b] + lines[b].length]);
}

function mergeRanges(rs) {
  const s = rs.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// everything typography must leave alone: TikZ-like code and ignored lines
const codeRanges = (text, extra) => mergeRanges(tikzInlineRanges(text, extra).concat(ignoreRanges(text)));

// same text with the given ranges overwritten by spaces (newlines and length kept)
function blankRanges(text, ranges) {
  if (!ranges.length) return text;
  let r = '';
  let last = 0;
  for (const [a, b] of ranges) { r += text.slice(last, a) + text.slice(a, b).replace(/[^\n]/g, ' '); last = b; }
  return r + text.slice(last);
}


/* ------------------------------ wrap ------------------------------- */
function vlen(s, tab) {
  let n = 0;
  for (const ch of s) n += ch === '\t' ? tab : 1;
  return n;
}

function wrapLine(line, width, tab) {
  const indent = /^\s*/.exec(line)[0];
  const body = line.slice(indent.length).trim();
  if (!body) return [line];
  const cont = indent + (/^\\item\b/.test(body) ? '  ' : '');
  const words = body.split(/ +/);
  const out = [];
  let cur = indent + words[0];
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    if (vlen(cur, tab) + 1 + vlen(w, tab) <= width) cur += ' ' + w;
    else { out.push(cur); cur = cont + w; }
  }
  out.push(cur);
  return out;
}

// unwrap first (join paragraph lines), then break every long text line at `width`
function wrapLines(lines, width, tab) {
  const out = [];
  for (const l of unwrapLines(lines)) {
    if (lineKind(l) === 'hard' || hasComment(l) || vlen(l, tab) <= width) out.push(l);
    else out.push(...wrapLine(l, width, tab));
  }
  return out;
}

module.exports = {
  alignLines,
  blankRanges,
  canJoin,
  codePart,
  codeRanges,
  dispLen,
  escRe,
  hasComment,
  ignoreLineRanges,
  ignoreRanges,
  ignoredLineSet,
  lineKind,
  noJoinAfter,
  parseProtectedCommands,
  posix,
  setProtectedCommands,
  splitRow,
  stripEsc,
  tikzInlineRanges,
  unwrapLines,
  wrapLine,
  wrapLines,
};
