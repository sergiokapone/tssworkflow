'use strict';

/* moved from extension.js: table alignment + paragraph unwrap (pure functions) */
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

/* --------------------------- typography ---------------------------- */
const PROT_ENVS =
  'equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math|verbatim|minted|lstlisting|' +
  'tikzpicture|pgfpicture|circuitikz|axis|tblr|longtblr|talltblr|tabular|tabularx|longtable|array|split|cases|smallmatrix|matrix|' +
  'pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix';
const PROT_CMDS =
  'label|ref|eqref|autoref|cref|Cref|pageref|nameref|vref|subref|cite[A-Za-z]*|input|include|includegraphics|' +
  'localinput|inputcode|usepackage|documentclass|url|href|hypertarget|hyperref|begin|end|graphicspath|' +
  'setlength|hspace|vspace';

const PROT = new RegExp(
  [
    String.raw`%[^\n]*`,
    String.raw`\\begin\{((?:` + PROT_ENVS + String.raw`)\*?)\}[\s\S]*?\\end\{\1\}`,
    String.raw`\\\[[\s\S]*?\\\]`,
    String.raw`\$\$[\s\S]*?\$\$`,
    String.raw`\\\([\s\S]*?\\\)`,
    String.raw`\$[^$]*\$`,
    String.raw`\\(?:` + PROT_CMDS + String.raw`)\*?(?:\[[^\]]*\])*\{[^}]*\}`,
    String.raw`\\[A-Za-z@]+\*?`,
    String.raw`\\[\s\S]`
  ].join('|'),
  'g'
);

function protectedRanges(text) {
  const out = [];
  PROT.lastIndex = 0;
  let m;
  while ((m = PROT.exec(text)) !== null) {
    if (!m[0].length) { PROT.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  for (const r of codeRanges(text)) out.push(r);
  return out;
}

const TYPO_RULES = [
  [/(?<=\S) {2,}(?=\S)/g, () => ' '],
  // " - ", " -- ", " --- " -> "~--- " (non-breaking space before the dash); not next to & or \\
  [/(?<=[^\s&~])[ ~]+-{1,3}( +)(?=[^\s&\\-])/g, () => '~--- '],
  [/(?<=^|[\s(«"{\u0001])([вузіайоВУЗІАЙО]) +(?=[\p{L}\d\\$«"(\u0001])/gmu, (m, a) => a + '~'],
  [/([А-ЯІЇЄҐ])\.[ ~]*([А-ЯІЇЄҐ])\.[ ~]*(?=[А-ЯІЇЄҐ][а-яіїєґ'’])/gu, (m, a, b) => a + '.~' + b + '.~'],
  [/(?<!\p{L})(рис|табл|стор|розд|напр|див)\.[ ]+(?=[\d\\\u0001])/gu, (m, a) => a + '.~'],
  [/(?<!\p{L})т\.[ ~]*(д|п|ін)\./gu, (m, a) => 'т.~' + a + '.'],
  [/([№§]) *(?=\d)/g, (m, a) => a + '~'],
  [/(?<=\d) +(?=рр?\.)/g, () => '~'],
  // number and unit: a non-breaking space (10 см -> 10~см)
  [/(?<=\d) +(?=(?:мкм|мм|см|км|нм|пм|кг|мг|мкг|мкс|мс|нс|хв|год|кГц|МГц|ГГц|Гц|кПа|МПа|Па|кДж|Дж|еВ|кВт|Вт|мВ|кВ|мА|кОм|МОм|Ом|мкФ|пФ|нФ|мТл|Тл|Гс|мГн|Гн|моль|Бк|лм|лк|дБ|м|г|с|Н|В|А|Ф|К)(?![\p{L}\d]))/gu, () => '~']
];

// quotes: 'guillemets' ("..." and ``...'' -> «...»), 'enquote' ("...", ``...'', <<...>>, «...» -> \enquote{...}), 'keep'
function fixPlain(s, quotes) {
  let count = 0;
  const run = (re, fn) => {
    s = s.replace(re, (...a) => {
      const r = fn(...a);
      if (r !== a[0]) count++;
      return r;
    });
  };
  if (quotes === 'enquote') {
    run(/"([^"\n]*)"/g, (m, a) => '\\enquote{' + a + '}');
    run(/``([^`'\n]*)''/g, (m, a) => '\\enquote{' + a + '}');
    // innermost pairs first, never across a blank line
    for (let k = 0; k < 6; k++) {
      const before = s;
      run(/<<((?:(?!<<|>>|\n[ \t]*\n)[\s\S])*?)>>/g, (m, a) => '\\enquote{' + a.trim() + '}');
      run(/«((?:(?!«|»|\n[ \t]*\n)[\s\S])*?)»/g, (m, a) => '\\enquote{' + a.trim() + '}');
      if (s === before) break;
    }
  } else if (quotes !== 'keep') {
    run(/"([^"\n]*)"/g, (m, a) => '«' + a + '»');
    run(/``([^`'\n]*)''/g, (m, a) => '«' + a + '»');
  }
  for (const [re, fn] of TYPO_RULES) run(re, fn);
  return { text: s, count };
}

// decimal point -> decimal comma in math: 3.5 -> 3{,}5 (not in \hspace{2.5cm}, labels, comments)
const MATH_DEC = /\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\begin\{((?:equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math)\*?)\}[\s\S]*?\\end\{\1\}/g;
const DEC_SKIP = /(?<!\\)%[^\n]*|\\(?:hspace|vspace|kern|mkern|rule|setlength|label|ref|eqref|tag|hskip|vskip|raisebox|includegraphics)\*?(?:\[[^\]]*\])?\{[^}]*\}/g;
function commaInMath(text) {
  let count = 0;
  const out = text.replace(MATH_DEC, (span) => {
    const keep = [];
    const masked = span.replace(DEC_SKIP, (c) => { keep.push(c); return '\u0002'; });
    const fixed = masked.replace(/(?<![\w.\\])(\d+)\.(\d+)(?![\d.])/g, (m, a, b) => { count++; return a + '{,}' + b; });
    let k = 0;
    return fixed.replace(/\u0002/g, () => keep[k++]);
  });
  return { text: out, count };
}

function typography(text, opts) {
  // TikZ-like code and `% tss-ignore` lines are not text: hide them behind \u0004 and put them back at the end
  const tikzSpans = [];
  const tk = codeRanges(text, opts && opts.protectedCommands);
  if (tk.length) {
    let t2 = '';
    let l2 = 0;
    for (const [a, b] of tk) { t2 += text.slice(l2, a) + '\u0004'; tikzSpans.push(text.slice(a, b)); l2 = b; }
    text = t2 + text.slice(l2);
  }
  const spans = [];
  let masked = '';
  let last = 0;
  PROT.lastIndex = 0;
  let m;
  while ((m = PROT.exec(text)) !== null) {
    if (!m[0].length) { PROT.lastIndex++; continue; }
    masked += text.slice(last, m.index) + '\u0001';
    spans.push(m[0]);
    last = m.index + m[0].length;
  }
  masked += text.slice(last);
  const r = fixPlain(masked, (opts && opts.quotes) || 'guillemets');
  let k = 0;
  const restored = r.text.replace(/\u0001/g, () => spans[k++]);
  const dec = commaInMath(restored);
  let q = 0;
  return { text: tikzSpans.length ? dec.text.replace(/\u0004/g, () => tikzSpans[q++]) : dec.text, count: r.count + dec.count };
}

/* ---------------------------- sentences ---------------------------- */
const ABBR = new Set([
  'рис', 'табл', 'стор', 'розд', 'напр', 'див', 'ін', 'дод', 'ст', 'п', 'ім', 'проф', 'доц', 'акад', 'англ',
  'нім', 'лат', 'млн', 'млрд', 'тис', 'грн', 'коп', 'обл', 'вул', 'буд', 'кв', 'пр', 'р', 'рр', 'с', 'т', 'д',
  'пор', 'мал', 'вип'
]);

function splitSentences(text) {
  const prot = protectedRanges(text);
  const inProt = (i) => prot.some(([a, b]) => i >= a && i < b);
  const re = /([.!?…]+)([»)}\]"']*)( +)(?=[\p{Lu}«])/gu;
  const out = [];
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (inProt(m.index)) continue;
    if (m[1] === '.') {
      const w = /([\p{L}\d]+)$/u.exec(text.slice(0, m.index));
      if (w && (ABBR.has(w[1].toLowerCase()) || (w[1].length === 1 && /\p{L}/u.test(w[1])))) continue;
    }
    out.push(text.slice(start, m.index + m[1].length + m[2].length));
    start = m.index + m[0].length;
  }
  out.push(text.slice(start));
  return out.filter((s) => s.length);
}

// one line per sentence for every text line of the block (after joining paragraphs)
function sentenceLines(lines) {
  const out = [];
  for (const l of unwrapLines(lines)) {
    if (lineKind(l) === 'hard' || hasComment(l)) { out.push(l); continue; }
    const indent = /^\s*/.exec(l)[0];
    for (const s of splitSentences(l.slice(indent.length))) out.push(indent + s.trim());
  }
  return out;
}

/* -------------------------- table operations ----------------------- */
const ALIGN_ENVS = new Set([
  'tblr', 'longtblr', 'talltblr', 'tabular', 'tabular*', 'tabularx', 'tabulary', 'longtable', 'array',
  'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'Bmatrix', 'smallmatrix',
  'align', 'align*', 'aligned', 'alignat', 'alignat*', 'alignedat', 'flalign', 'flalign*',
  'eqnarray', 'eqnarray*', 'split', 'cases'
]);

function parseRows(lines) {
  let lastContent = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && !t.startsWith('%')) lastContent = i;
  });
  return lines.map((l, i) => {
    const r = splitRow(l);
    if (!r || r.cells.length < 2) return null;
    if (r.tail === null && i !== lastContent) return null;
    r.indent = /^\s*/.exec(l)[0];
    return r;
  });
}

// index of the column (number of top-level & before the cursor)
function colAt(line, ch) {
  let depth = 0;
  let n = 0;
  const end = Math.min(ch, line.length);
  for (let i = 0; i < end; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') break;
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '&' && depth === 0) n++;
  }
  return n;
}

function tableOp(lines, op, col) {
  const rows = parseRows(lines);
  const idx = [];
  rows.forEach((r, i) => { if (r) idx.push(i); });
  if (!idx.length) return { error: 'У блоці немає рядків таблиці (потрібні рядки з & в одному рядку).' };
  const build = (indent, tail, comment, cells) =>
    indent + cells.join(' & ') + (tail !== null ? ' ' + tail : comment ? ' ' + comment : '');
  const out = lines.slice();
  if (op === 'addRight' || op === 'addLeft') {
    for (const i of idx) {
      const r = rows[i];
      const cells = r.cells.slice();
      cells.splice(Math.min(op === 'addRight' ? col + 1 : col, cells.length), 0, '');
      out[i] = build(r.indent, r.tail, r.comment, cells);
    }
  } else if (op === 'delete') {
    for (const i of idx) {
      const r = rows[i];
      const cells = r.cells.slice();
      if (col < cells.length) cells.splice(col, 1);
      out[i] = build(r.indent, r.tail, r.comment, cells.length ? cells : ['']);
    }
  } else if (op === 'sort') {
    const slots = idx.slice(1); // the first table row is treated as a header
    if (slots.length < 2) return { error: 'Замало рядків для сортування.' };
    const coll = new Intl.Collator('uk', { numeric: true, sensitivity: 'base' });
    const sorted = slots.map((i) => rows[i]).sort((a, b) => coll.compare(a.cells[col] || '', b.cells[col] || ''));
    slots.forEach((slot, k) => {
      const s = rows[slot];
      out[slot] = build(s.indent, s.tail, s.comment, sorted[k].cells);
    });
  } else if (op === 'transpose') {
    const nonBlank = lines.filter((l) => l.trim()).length;
    if (nonBlank !== idx.length) return { error: 'Транспонувати можна лише таблицю, де всі рядки це рядки з &.' };
    const n = rows[idx[0]].cells.length;
    if (idx.some((i) => rows[i].cells.length !== n)) return { error: 'Рядки мають різну кількість комірок.' };
    const indent = rows[idx[0]].indent;
    const res = [];
    for (let j = 0; j < n; j++) {
      res.push(indent + idx.map((i) => rows[i].cells[j]).join(' & ') + (j < n - 1 ? ' \\\\' : ''));
    }
    return { lines: res };
  } else {
    return { error: 'Невідома дія: ' + op };
  }
  return { lines: out };
}

/* ---------------------------- environments ------------------------- */
function envTokensPure(lines) {
  const toks = [];
  const re = /\\(begin|end)\{([^{}]*)\}/g;
  lines.forEach((line, i) => {
    const code = codePart(line);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      toks.push({
        type: m[1], name: m[2], line: i,
        col: m.index + m[0].indexOf('{') + 1, len: m[2].length,
        tokStart: m.index, tokEnd: m.index + m[0].length
      });
    }
  });
  return toks;
}

function pairEnvsPure(toks) {
  const stack = [];
  const pairs = [];
  const problems = [];
  toks.forEach((t, i) => {
    if (t.type === 'begin') { stack.push(i); return; }
    if (!stack.length) { problems.push({ i, code: 'end-without-begin', msg: '\\end{' + t.name + '} без \\begin' }); return; }
    const top = stack[stack.length - 1];
    if (toks[top].name === t.name) { stack.pop(); pairs.push([top, i]); return; }
    let k = -1;
    for (let s = stack.length - 1; s >= 0; s--) if (toks[stack[s]].name === t.name) { k = s; break; }
    if (k >= 0) {
      for (let s = stack.length - 1; s > k; s--) problems.push({ i: stack[s], code: 'missing-end', msg: 'Немає \\end{' + toks[stack[s]].name + '}' });
      const b = stack[k];
      stack.length = k;
      pairs.push([b, i]);
    } else {
      stack.pop();
      pairs.push([top, i]);
      problems.push({ i, code: 'end-mismatch', msg: '\\end{' + t.name + '} не відповідає \\begin{' + toks[top].name + '}', expect: toks[top].name });
    }
  });
  stack.forEach((i) => problems.push({ i, code: 'missing-end', msg: 'Немає \\end{' + toks[i].name + '}' }));
  return { pairs, problems };
}

// first body line of an environment: skips [..] and {..} arguments (they may span lines)
function bodyStartLine(lines, line, col) {
  let l = line;
  let c = col;
  for (;;) {
    while (lines[l] !== undefined && (lines[l][c] === ' ' || lines[l][c] === '\t')) c++;
    const ch = lines[l] && lines[l][c];
    if (ch !== '{' && ch !== '[') break;
    const close = ch === '{' ? '}' : ']';
    let d = 0;
    let done = false;
    while (l < lines.length && !done) {
      while (c < lines[l].length) {
        const x = lines[l][c];
        if (x === '\\') { c += 2; continue; }
        if (x === ch) d++;
        else if (x === close) { d--; if (d === 0) { c++; done = true; break; } }
        c++;
      }
      if (!done) { l++; c = 0; }
    }
  }
  return l + 1;
}

// lines of the innermost table/align-like environment around line `cur`
function tableBlockLines(lines, cur) {
  const toks = envTokensPure(lines);
  const { pairs } = pairEnvsPure(toks);
  let best = null;
  for (const [b, e] of pairs) {
    if (!ALIGN_ENVS.has(toks[b].name)) continue;
    if (toks[b].line > cur || toks[e].line < cur) continue;
    if (!best || toks[b].line >= toks[best[0]].line) best = [b, e];
  }
  if (!best) return null;
  const bt = toks[best[0]];
  const et = toks[best[1]];
  return { startLine: bodyStartLine(lines, bt.line, bt.tokEnd), endLine: et.line - 1 };
}

const CONVERTIBLE = [
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'flalign', 'flalign*'
];
const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'displaymath', 'flalign', 'flalign*', 'alignat', 'alignat*'
]);

// choice: new environment name, '+label' or '-label'
function convertEnv(lines, cur, choice) {
  const toks = envTokensPure(lines);
  const { pairs } = pairEnvsPure(toks);
  let best = null;
  for (const [b, e] of pairs) {
    if (!CONVERTIBLE.includes(toks[b].name)) continue;
    if (toks[b].line > cur || toks[e].line < cur) continue;
    if (!best || toks[b].line >= toks[best[0]].line) best = [b, e];
  }
  if (!best) return { error: 'Курсор не всередині equation / align / gather / multline.' };
  const bt = toks[best[0]];
  const et = toks[best[1]];
  const labelRe = /\\label\{[^}]*\}\s?/;
  if (choice === '+label' || choice === '-label') {
    for (let ln = bt.line; ln <= et.line; ln++) {
      const m = labelRe.exec(codePart(lines[ln]));
      if (m) {
        if (choice === '+label') return { error: 'У цьому середовищі вже є \\label.' };
        return { edits: [{ line: ln, col: m.index, len: m[0].length, text: '' }] };
      }
    }
    if (choice === '-label') return { error: '\\label не знайдено.' };
    return { edits: [{ line: bt.line, col: bt.tokEnd, len: 0, text: '\\label{eq:}' }] };
  }
  return {
    edits: [
      { line: bt.line, col: bt.col, len: bt.len, text: choice },
      { line: et.line, col: et.col, len: et.len, text: choice }
    ]
  };
}

/* ------------------------------- labels ---------------------------- */
const REF_CMDS = 'ref|eqref|autoref|cref|Cref|crefrange|Crefrange|labelcref|cpageref|Cpageref|pageref|nameref|vref|Vref|vrefrange|vpageref|autopageref|subref';

const CURRFILE = '\\currfilebase';
const SEC_LINE_RE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;

// adds the comma-separated names of one reference argument that starts at column `off`
function pushRefs(refs, arg, line, off) {
  for (const part of arg.split(',')) {
    const name = part.trim();
    if (name && !name.includes('\\')) {
      const lead = part.length - part.trimStart().length;
      refs.push({ name, line, col: off + lead, len: name.length });
    }
    off += part.length + 1;
  }
}

// fileBase: base name of the file (without extension); \label{\currfilebase} is resolved to it.
// Other labels / refs that contain a macro (a backslash) are ignored.
function scanLabelsAndRefs(text, fileBase) {
  const labels = [];
  const refs = [];
  const labelRe = /\\label\{([^}]*)\}/g;
  const refRe = new RegExp('\\\\(?:' + REF_CMDS + ')\\*?\\{([^}]*)\\}', 'g');
  const envRe = /\\(begin|end)\{([^{}]*)\}/g;
  const hyperRe = /\\hyperref\[([^\]]*)\]/g;
  const rangeRe = /\\(?:[cC]refrange|vrefrange|Vrefrange)\*?\{[^}]*\}\{([^}]*)\}/g;
  let lastCtx = '';
  let lastSec = -100;
  const stack = [];
  const all = text.split(/\r?\n/);
  all.forEach((line, i) => {
    const code = codePart(line);
    if (SEC_LINE_RE.test(code)) lastSec = i;
    const ctxHere = code.replace(labelRe, '').replace(/\\(begin|end)\{[^}]*\}/g, '').trim();
    if (ctxHere) lastCtx = ctxHere.slice(0, 90);
    // environment events of this line, in order
    const ev = [];
    let m;
    envRe.lastIndex = 0;
    while ((m = envRe.exec(code)) !== null) ev.push({ pos: m.index, type: m[1], name: m[2].replace(/\*$/, ''), line: i });
    let ei = 0;
    const applyEnvUpTo = (pos) => {
      while (ei < ev.length && ev[ei].pos < pos) {
        const e = ev[ei++];
        if (e.type === 'begin') stack.push({ name: e.name, line: e.line });
        else {
          for (let s = stack.length - 1; s >= 0; s--) if (stack[s].name === e.name) { stack.length = s; break; }
        }
      }
    };
    labelRe.lastIndex = 0;
    while ((m = labelRe.exec(code)) !== null) {
      applyEnvUpTo(m.index);
      let name = m[1].trim();
      const lead = m[1].length - m[1].trimStart().length;
      let macro = false;
      if (name === CURRFILE) {
        if (!fileBase) continue;
        name = fileBase;
        macro = true;
      } else if (name.includes('\\')) continue;
      const envs = stack.map((s) => s.name);
      if (!stack.length || i - lastSec <= 2) { if (i - lastSec <= 2 && !stack.some((s) => /^(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath)$/.test(s.name))) envs.push('section'); }
      labels.push({
        name, line: i, col: m.index + m[0].indexOf('{') + 1 + lead, len: m[1].trim().length,
        ctx: ctxHere || lastCtx, macro, envs, envLine: stack.length ? stack[stack.length - 1].line : -1
      });
    }
    applyEnvUpTo(Infinity);
    refRe.lastIndex = 0;
    while ((m = refRe.exec(code)) !== null) {
      pushRefs(refs, m[1], i, m.index + m[0].indexOf('{') + 1);
    }
    // \hyperref[label]{text}
    hyperRe.lastIndex = 0;
    while ((m = hyperRe.exec(code)) !== null) pushRefs(refs, m[1], i, m.index + m[0].indexOf('[') + 1);
    // second argument of \crefrange{a}{b}
    rangeRe.lastIndex = 0;
    while ((m = rangeRe.exec(code)) !== null) pushRefs(refs, m[1], i, m.index + m[0].lastIndexOf('{') + 1);
  });
  for (const lb of labels) {
    if (lb.ctx) continue;
    for (let k = lb.line + 1; k < all.length && k < lb.line + 6; k++) {
      const t = codePart(all[k]).replace(/\\(begin|end)\{[^}]*\}/g, '').trim();
      if (t) { lb.ctx = t.slice(0, 90); break; }
    }
  }
  return { labels, refs };
}

function labelAtPos(line, col) {
  const { labels, refs } = scanLabelsAndRefs(line);
  for (const x of labels.concat(refs)) if (col >= x.col && col <= x.col + x.len) return x;
  return null;
}

function renamePositions(text, oldName) {
  const { labels, refs } = scanLabelsAndRefs(text);
  return labels.concat(refs).filter((x) => x.name === oldName && !x.macro);
}

/* --------------------------- syntax checks -------------------------- */
// exists(kind, name) -> boolean, kind is 'tikz' or 'pic'
function syntaxChecks(lines, exists) {
  const out = [];
  const bs = /(?<![\\A-Za-z@])(begin|end)\{([A-Za-z]+\*?)\}/g;
  lines.forEach((line, i) => {
    const code = codePart(line);
    let m;
    bs.lastIndex = 0;
    while ((m = bs.exec(code)) !== null) {
      out.push({ line: i, col: m.index, len: m[0].length, severity: 'error', code: 'missing-backslash', message: 'Пропущено «\\» перед ' + m[1] + '{' + m[2] + '}' });
    }
  });
  const toks = envTokensPure(lines);
  const { pairs, problems } = pairEnvsPure(toks);
  problems.forEach((p) => {
    const t = toks[p.i];
    out.push({ line: t.line, col: t.tokStart, len: t.tokEnd - t.tokStart, severity: 'error', code: p.code, expect: p.expect, message: p.msg });
  });
  pairs.forEach(([b, e]) => {
    if (!MATH_ENVS.has(toks[b].name)) return;
    for (let ln = toks[b].line + 1; ln < toks[e].line; ln++) {
      if (lines[ln].trim() === '') {
        out.push({ line: ln, col: 0, len: 1, severity: 'error', code: 'blank-in-math', message: 'Порожній рядок усередині формули (це \\par), LaTeX видасть помилку' });
      }
    }
  });
  if (exists) {
    const lin = /\\localinput\{([^}]*)\}/g;
    const inc = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g;
    lines.forEach((line, i) => {
      const code = codePart(line);
      for (const [re, kind, prefix] of [[lin, 'tikz', 'tikz/'], [inc, 'pic', 'Pictures/']]) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(code)) !== null) {
          const name = m[1].trim();
          if (!name) continue;
          if (!exists(kind, name)) {
            const lead = m[1].length - m[1].trimStart().length;
            out.push({ line: i, col: m.index + m[0].lastIndexOf('{') + 1 + lead, len: name.length, severity: 'warning', code: 'file-missing-' + kind, message: 'Файл не знайдено: ' + prefix + name });
          }
        }
      }
    });
  }
  return out;
}


/* --------------------- frames: headings and formulas ---------------- */
const FRAME_RULE = '%% ' + '-'.repeat(56);     // around \section etc.
const FRAME_EQ_RULE = '% ' + '='.repeat(56);   // around formula environments
const SECTION_RE = /^(\s*)\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(\[[^\]]*\])?\s*\{/;
const FRAME_EQ_ENVS = ['equation', 'align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat', 'displaymath'];
const EQ_BEGIN_RE = new RegExp('^(\\s*)\\\\begin\\{(' + FRAME_EQ_ENVS.join('|') + ')(\\*?)\\}');
const VERB_BEGIN_RE = /^\s*\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|tcblisting)\}/;
const isBlockStart = (l) => SECTION_RE.test(l) || EQ_BEGIN_RE.test(l);
const isRuleLine = (l) => /^\s*%+\s*[-=*#_~.]{8,}\s*$/.test(l);

// closing position of the {...} argument opening at (line, col); null if unbalanced
function braceEnd(lines, line, col) {
  let d = 0;
  for (let l = line; l < lines.length && l < line + 8; l++) {
    const s = lines[l];
    for (let c = l === line ? col : 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === '\\') { c++; continue; }
      if (ch === '%') break;
      if (ch === '{') d++;
      else if (ch === '}') { d--; if (d === 0) return { line: l, col: c + 1 }; }
    }
  }
  return null;
}

// end of \begin{name} ... \end{name} that starts at (line, col after \begin{name}); nesting of the same name counted
function envEnd(lines, name, line, col) {
  const re = new RegExp('\\\\(begin|end)\\{' + name.replace(/\*/g, '\\*') + '\\}', 'g');
  let depth = 1;
  for (let l = line; l < lines.length; l++) {
    const s = lines[l].replace(/(^|[^\\])%.*$/, '$1');
    re.lastIndex = l === line ? col : 0;
    let m;
    while ((m = re.exec(s))) {
      depth += m[1] === 'begin' ? 1 : -1;
      if (depth === 0) return { line: l, col: m.index + m[0].length, text: s };
    }
  }
  return null;
}

// regex of the formula environments to frame: the built-in ones plus `extra` (names from tssworkflow.frameEnvironments)
function eqReFor(extra) {
  const names = FRAME_EQ_ENVS.slice();
  for (const n of Array.isArray(extra) ? extra : []) {
    const k = String(n).trim().replace(/\*$/, '');
    if (/^[A-Za-z@][A-Za-z0-9@]*$/.test(k) && !names.includes(k)) names.push(k);
  }
  return new RegExp('^(\\s*)\\\\begin\\{(' + names.join('|') + ')(\\*?)\\}');
}

// Frames every sectioning command (except \part) with "%% ----" lines plus blank lines, and every
// formula environment with "% ====" lines. Blocks that already have a rule-comment line next to them
// are left alone; run-in headings and formulas followed by text on the same line are skipped.
// opts: { blank: bool, envs: [extra environment names], replace: bool }
// With opts.replace the existing rule lines next to a block are swapped for the current ones (re-framing).
function frameSections(lines, rules, opts) {
  rules = rules || {};
  const blank = !opts || opts.blank !== false;
  const replace = !!(opts && opts.replace);
  const eqRe = eqReFor(opts && opts.envs);
  const isStart = (l) => SECTION_RE.test(l) || eqRe.test(l);
  // rule line for a block: per-command / per-environment key, else the "headings" / "formulas" default
  // (extra environments: "environments" first); '' switches it off
  const ruleFor = (kind, name) => {
    let v = rules[name];
    if (v === undefined && kind === 'eq' && !FRAME_EQ_ENVS.includes(name)) v = rules.environments;
    if (v === undefined) v = kind === 'sec' ? rules.headings : rules.formulas;
    if (v === undefined) v = kind === 'sec' ? FRAME_RULE : FRAME_EQ_RULE;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const ranges = [];
  const stat = { sections: 0, equations: 0, already: 0, skipped: 0, found: 0, replaced: 0 };
  for (let i = 0; i < lines.length; i++) {
    const vb = VERB_BEGIN_RE.exec(lines[i]);
    if (vb) {
      const e = envEnd(lines, vb[1], i, vb[0].length);
      if (!e) break;
      i = e.line;
      continue;
    }
    const m = SECTION_RE.exec(lines[i]);
    if (m) {
      const rule = ruleFor('sec', m[2]);
      if (!rule) continue;
      stat.found++;
      const end = braceEnd(lines, i, m[0].length - 1);
      if (!end) { stat.skipped++; continue; }
      const tail = lines[end.line].slice(end.col).trim();
      if (tail && !tail.startsWith('%') && !/^(\\(label|hypertarget)\{[^}]*\}(\{[^}]*\})?\s*)+(%.*)?$/.test(tail)) { stat.skipped++; i = end.line; continue; }
      let s = i;
      let e = end.line;
      while (s > 0 && /^\s*\\hypertarget\{[^}]*\}(\{[^}]*\})?\s*$/.test(lines[s - 1])) s--;
      while (e + 1 < lines.length && /^\s*\\(label|hypertarget)\{[^}]*\}(\{[^}]*\})?\s*(%.*)?$/.test(lines[e + 1])) e++;
      ranges.push({ kind: 'sec', s, e, indent: m[1], rule });
      i = e;
      continue;
    }
    const q = eqRe.exec(lines[i]);
    if (q) {
      const rule = ruleFor('eq', q[2]);
      if (!rule) continue;
      stat.found++;
      const end = envEnd(lines, q[2] + q[3], i, q[0].length);
      if (!end) { stat.skipped++; continue; }
      const tail = end.text.slice(end.col).trim();
      if (tail) { stat.skipped++; i = end.line; continue; }
      ranges.push({ kind: 'eq', s: i, e: end.line, indent: q[1], rule });
      i = end.line;
    }
  }
  const out = [];
  let k = 0;
  for (const r of ranges) {
    const above = r.s > 0 && isRuleLine(lines[r.s - 1]);
    // a rule right below belongs to this block unless it is the top rule of the next block
    const below = r.e + 1 < lines.length && isRuleLine(lines[r.e + 1]) && !(r.e + 2 < lines.length && isStart(lines[r.e + 2]));
    let dropAbove = false;
    let dropBelow = false;
    if (above || below) {
      if (!replace) { stat.already++; continue; }
      // re-framing: nothing to do when both rules are already exactly the wanted ones
      if (above && below && lines[r.s - 1].trim() === r.rule && lines[r.e + 1].trim() === r.rule) { stat.already++; continue; }
      dropAbove = above && r.s - 1 >= k;
      dropBelow = below;
      stat.replaced++;
    }
    for (let x = k; x < r.s; x++) {
      if (dropAbove && x === r.s - 1) continue;
      out.push(lines[x]);
    }
    const rule = r.indent + r.rule;
    if (blank && r.kind === 'sec' && out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(rule);
    for (let x = r.s; x <= r.e; x++) out.push(lines[x]);
    out.push(rule);
    const nxt = r.e + 1 + (dropBelow ? 1 : 0);
    if (blank && r.kind === 'sec' && nxt < lines.length && lines[nxt].trim() !== '') out.push('');
    k = nxt;
    if (r.kind === 'sec') stat.sections++; else stat.equations++;
  }
  for (let x = k; x < lines.length; x++) out.push(lines[x]);
  return { lines: out, count: stat.sections + stat.equations, stat };
}


/* ------------------------------ headings ---------------------------- */
const HEADING_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/;
const HEADING_LEVEL = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };

function cleanTitle(s) {
  return s
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\(?:texorpdfstring)\{([^{}]*)\}\{[^{}]*\}/g, '$1')
    .replace(/\\[A-Za-z]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scanHeadings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const vb = VERB_BEGIN_RE.exec(lines[i]);
    if (vb) {
      const e = envEnd(lines, vb[1], i, vb[0].length);
      if (!e) break;
      i = e.line;
      continue;
    }
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    const end = braceEnd(lines, i, m[0].length - 1);
    let raw;
    if (end) {
      const parts = [];
      for (let l = i; l <= end.line; l++) {
        const from = l === i ? m[0].length : 0;
        const to = l === end.line ? end.col - 1 : lines[l].length;
        parts.push(lines[l].slice(from, to));
      }
      raw = parts.join(' ');
    } else raw = lines[i].slice(m[0].length);
    out.push({ kind: m[1], level: HEADING_LEVEL[m[1]], star: !!m[2], title: cleanTitle(raw) || '(без назви)', line: i });
  }
  return out;
}

/* --------------------------- align all tables ----------------------- */
// aligns every outermost table-like environment of the file; returns { lines, count }
function alignAllTables(lines) {
  const toks = envTokensPure(lines);
  const { pairs } = pairEnvsPure(toks);
  const blocks = [];
  for (const [b, e] of pairs) {
    if (!ALIGN_ENVS.has(toks[b].name)) continue;
    const s = bodyStartLine(lines, toks[b].line, toks[b].tokEnd);
    const en = toks[e].line - 1;
    if (en >= s) blocks.push({ s, e: en, bl: toks[b].line, el: toks[e].line });
  }
  blocks.sort((x, y) => x.s - y.s);
  const top = [];
  for (const bl of blocks) {
    const last = top[top.length - 1];
    if (last && bl.bl >= last.bl && bl.el <= last.el) continue; // nested: the outer one is aligned
    top.push(bl);
  }
  const out = lines.slice();
  let count = 0;
  for (const bl of top) {
    const old = lines.slice(bl.s, bl.e + 1);
    const neu = alignLines(old);
    if (neu.some((l, i) => l !== old[i])) {
      count++;
      for (let i = 0; i < neu.length; i++) out[bl.s + i] = neu[i];
    }
  }
  return { lines: out, count };
}

/* ------------------------- suggestions, outline --------------------- */
function editDistance(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

// up to `max` candidates close to `name` (typos, different case, one is the beginning of the other)
function suggest(name, candidates, max) {
  const low = name.toLowerCase();
  const limit = Math.max(2, Math.floor(name.length / 4));
  const scored = [];
  const seen = new Set();
  for (const c of candidates) {
    if (c === name || seen.has(c)) continue;
    seen.add(c);
    const cl = c.toLowerCase();
    let d = editDistance(low, cl);
    if (low.length >= 3 && (cl.startsWith(low) || low.startsWith(cl))) d = Math.min(d, 1);
    if (d <= limit) scored.push({ c, d });
  }
  scored.sort((p, q) => p.d - q.d || p.c.localeCompare(q.c));
  return scored.slice(0, max || 3).map((x) => x.c);
}

// nested tree of headings for the Outline view: [{ title, kind, level, line, endLine, children }]
function outlineTree(lines) {
  const heads = scanHeadings(lines);
  const root = { level: -1, children: [] };
  const stack = [root];
  for (const h of heads) {
    const node = { title: h.title, kind: h.kind, star: h.star, level: h.level, line: h.line, endLine: lines.length - 1, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) {
      const done = stack.pop();
      done.endLine = Math.max(done.line, node.line - 1);
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

/* --------------------------- pplatex output ------------------------- */
// `pplatex -i job.log` prints blocks like
//   ** Warning in ./test.tex: No file chapter.tex.
//   ** Error   in ./test.tex, Line 9:
//      Undefined control sequence Something \unknown
// (documented in the pplatex README; the exact BadBox / "Warning ..., Line N" shapes are parsed tolerantly)
// -> [{ kind: 'Error'|'Warning'|'BadBox', file, line (0-based or null), endLine, message }]
function parsePplatex(text, overfullThreshold) {
  const head = /^\*\*\s+(Error|Warning|Bad\s?Box)\s+in\s+((?:[A-Za-z]:)?[^:]*?)(?:,\s*Lines?\s+(\d+)(?:\s*[-\u2013]\s*(\d+))?)?\s*:\s*(.*)$/i;
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const parts = m[5] ? [m[5].trim()] : [];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j]) && !/^\*\*/.test(lines[j])) { parts.push(lines[j].trim()); j++; }
    i = j - 1;
    const kind = /^bad/i.test(m[1]) ? 'BadBox' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const message = parts.join(' ').replace(/\s+/g, ' ').trim() || kind;
    if (kind === 'BadBox' && overfullThreshold) {
      const w = /Overfull .hbox \((\d+(?:\.\d+)?)pt too wide\)/.exec(message);
      if (w && parseFloat(w[1]) <= overfullThreshold) continue;
    }
    out.push({
      kind,
      file: m[2].trim(),
      line: m[3] ? Math.max(0, parseInt(m[3], 10) - 1) : null,
      endLine: m[4] ? Math.max(0, parseInt(m[4], 10) - 1) : m[3] ? Math.max(0, parseInt(m[3], 10) - 1) : null,
      message
    });
  }
  return out;
}

/* ---------------------- errors straight from the .log --------------- */
// -file-line-error lines in <job>.log:  ./Plasma/Plasma.tex:197: Undefined control sequence.  (+ `l.197 \eras` below)
function parseLogErrors(log) {
  const lines = String(log).split(/\r?\n/);
  const re = /^((?:[A-Za-z]:)?[^\s:][^:]*?\.(?:tex|tikz|sty|cls|def|cfg|lua|aux|bbl|toc|out|lof|lot|ldf|fd|clo|sto|cut|ltx|pgf|dtx|ins)):(\d+):\s*(.+)$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let ctx = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      const c = /^l\.\d+\s*(.*)$/.exec(lines[j]);
      if (c) { ctx = c[1].trim(); break; }
      if (re.test(lines[j])) break;
    }
    const ln = parseInt(m[2], 10) - 1;
    out.push({ kind: 'Error', file: m[1], line: ln, endLine: ln, message: m[3].trim() + (ctx ? '  [' + ctx + ']' : '') });
  }
  return out;
}

/* ------------------------- texlogsieve output ----------------------- */
// `texlogsieve job.log` prints blocks like
//   From file ./Plasma/Plasma.tex:
//   pg 4: Overfull \hbox (14.7pt too wide) in paragraph at lines 53--194
//         Offending text: ...
//   pg 4: ./Plasma/Plasma.tex:197: Undefined control sequence.
//         l.197 \eras
//   After last page:
//   ====  Summary:  ====
//   Missing characters:
//       char X (U+041D), font cmmi12 in page 6 (file ./Plasma/Plasma.tex)
// -> [{ kind: 'Error'|'Warning'|'BadBox'|'Missing', file, line (0-based or null), endLine, message }]
/* ------------- Missing character: line from the log, honest hint ------------- */
// text of the diagnostic; `line` (1-based) is where the log context points, or null
function missingCharMessage(g, line) {
  const shown = g.chars.slice(0, 12).join(' ') + (g.chars.length > 12 ? ' …' : '');
  let msg = 'Немає гліфів у шрифті ' + g.font + ' (стор. ' + g.page + '): ' + shown + '.';
  if (line) {
    msg += ' Приблизно рядок ' + line + ': там TeX закінчив абзац чи сторінку, а сам символ може бути в колонтитулі, фоні або плаваючому обʼєкті.';
  }
  if (g.chars.some((c) => /[\u0400-\u04FF]/.test(c))) {
    msg += ' Схоже на кирилицю в математичному режимі: загорни її в \\text{...} або винеси з $...$';
  } else if (g.font === 'nullfont') {
    msg += ' Символ набрано без шрифту (nullfont): зазвичай це код, що виконується при виводі сторінки (колонтитул, фон, TikZ-накладка), або пакет, що друкує до вибору шрифту. Додай \\tracinglostchars=3: тоді буде помилка з реальним рядком.';
  } else {
    msg += ' Заміни символ або шрифт, у якому цього гліфа немає.';
  }
  return msg;
}

// "Missing character: There is no ; (U+003B) in font nullfont!" followed by l.NNN in the context
function missingCharLines(logText) {
  const lines = String(logText).split(/\r?\n/);
  const RE = /^Missing character: There is no (.+?)(?: \(U\+([0-9A-Fa-f]+)\))? in (?:font )?(.+?)!\s*$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RE.exec(lines[i]);
    if (!m) continue;
    const code = m[2] ? parseInt(m[2], 16) : (m[1].codePointAt(0) || 0);
    let line = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 200); j++) {
      if (RE.test(lines[j])) break;
      const l = /^l\.(\d+)\b/.exec(lines[j]);
      if (l) { line = parseInt(l[1], 10); break; }
    }
    out.push({ code, font: m[3], line });
  }
  return out;
}

// gives the 'Missing' items of parseTexlogsieve a line (0-based) and the matching message
function attachMissingLines(items, logText) {
  const found = missingCharLines(logText).filter((f) => f.line !== null);
  for (const it of items) {
    if (it.kind !== 'Missing' || !it.codes) continue;
    const hit = found.find((f) => f.font === it.font && it.codes.includes(f.code)) || found.find((f) => it.codes.includes(f.code));
    if (hit) { it.line = hit.line - 1; it.endLine = it.line; }
    it.message = missingCharMessage(it, hit ? hit.line : null);
  }
  return items;
}

// extra explanation for messages whose cause is well known (empty string when there is none)
function logHint(message) {
  const m = /graphics layer [`'‘]([^`'’]+)['’]/.exec(String(message));
  if (m) return 'Оголоси шар і додай його в список: \\pgfdeclarelayer{' + m[1] + '} \\pgfsetlayers{bg, background, ' + m[1] + ', main}';
  if (/pgf@layerbox/.test(String(message))) return 'Шар pgf у \\pgfsetlayers не оголошено: додай \\pgfdeclarelayer{назва_шару} перед \\pgfsetlayers';
  return '';
}

// output of \ShowHook from a log: [{hook, text}]
function parseShowHooks(logText) {
  const lines = String(logText).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // `> The hook ...` or, in the log of a recent TeX Live, `-> The hook ...`
    const m = /^(?:-?> )?The hook '([^']+)'/.exec(lines[i]);
    if (!m) continue;
    const body = [lines[i].replace(/^-?> /, '')];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^l\.\d+|^<recently read>|^<to be read again>|^!/.test(lines[j])) break;
      body.push(lines[j].replace(/^> ?/, ''));
    }
    out.push({ hook: m[1], text: body.join('\n').trim() });
  }
  return out;
}

/* ------------------- page output hooks: what to run and why nothing was found (0.3.13) ------------------- */
// the chapter (and figure) a file belongs to, like the compile button sees it; null: a file in the project root
// (main.tex, alone.tex, ...) or not a .tex/.tikz file. `rel` is the path from the project folder.
function hooksTarget(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const file = parts[parts.length - 1];
  const m = /^(.*)\.(tex|tikz)$/i.exec(file);
  if (!m) return null;
  if (m[2].toLowerCase() === 'tikz' && parts.length >= 3 && parts[parts.length - 2].toLowerCase() === 'tikz') {
    return { chapter: parts[parts.length - 3], tikz: m[1] };
  }
  return { chapter: m[1], tikz: null };
}

// the argument of lualatex: optional \TargetChapter/\TargetTikz, the hook dump at the start of the document, the input file
function hooksInject(names, target, inputFile) {
  const pre = target ? '\\def\\TargetChapter{' + target.chapter + '}' + (target.tikz ? '\\def\\TargetTikz{' + target.tikz + '}' : '') : '';
  return pre + '\\AddToHook{begindocument/end}{' + names.map((n) => '\\ShowHook{' + n + '}').join('') + '\\csname@@end\\endcsname}\\input{' + inputFile + '}';
}

// why a log has no \ShowHook output: { empty, date, old, error }; `old` only when the LaTeX date is before 2021
function diagnoseHooksLog(logText) {
  const log = String(logText || '');
  if (!log.trim()) return { empty: true, date: null, old: false, error: null };
  const d = /LaTeX2e <(\d{4})-(\d\d)-(\d\d)/.exec(log);
  const date = d ? d[1] + '-' + d[2] + '-' + d[3] : null;
  let error = null;
  for (const line of log.split(/\r?\n/)) {
    if (/^! /.test(line) || /^[^\s:][^:]*:\d+: /.test(line)) { error = line.trim().slice(0, 200); break; }
  }
  return { empty: false, date, old: !!d && Number(d[1]) < 2021, error };
}

/* ------------------- pass counter of a latexmk build ------------------- */
// Every LaTeX run rewrites <job>.log from scratch, so a log that is fresh (written during this build) marks run 1
// and a log that becomes smaller than it was marks the next run. biber and the like do not touch it.
function makePassCounter(startedMs) {
  let pass = 0;
  let prev = -1;
  return {
    get pass() { return pass; },
    feed(size, mtimeMs) {
      if (mtimeMs < startedMs - 50) return pass; // the log of an earlier build
      if (pass === 0) pass = 1;
      else if (size < prev) pass++;
      prev = size;
      return pass;
    }
  };
}

function passWord(n) {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m10 === 1 && m100 !== 11) return 'прохід';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'проходи';
  return 'проходів';
}

function parseTexlogsieve(text, overfullThreshold) {
  const lines = String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/[^\n]\x08/g, '').replace(/\x08/g, '').split(/\r?\n/);
  const out = [];
  let curFile = null;
  let entry = null;
  const missing = new Map();
  let inSummary = false;
  let inMissing = false;

  const flush = () => {
    if (!entry) return;
    const e = entry;
    entry = null;
    const text1 = e.parts.join(' ').replace(/\s+/g, ' ').trim();
    const ctx = e.parts.map((x) => /^l\.(\d+)\s*(.*)$/.exec(x)).find(Boolean);
    let m = /^Overfull \\hbox \(([\d.]+)pt too wide\)/.exec(text1);
    if (!m) m = /^Underfull \\hbox \(badness (\d+)\)/.exec(text1);
    if (m) {
      const isOver = /^Overfull/.test(text1);
      if (isOver && overfullThreshold && parseFloat(m[1]) < overfullThreshold) return;
      const at = /(?:at )?lines (\d+)--(\d+)|at line (\d+)/.exec(text1);
      if (!at || !curFile) return; // e.g. "Underfull \vbox ... \output is active": no line to point at
      const l0 = parseInt(at[1] || at[3], 10) - 1;
      const l1 = at[2] ? parseInt(at[2], 10) - 1 : l0;
      out.push({ kind: 'BadBox', file: curFile, line: l0, endLine: l1, message: text1.replace(/\s*Offending text:.*$/, '') });
      return;
    }
    m = /^((?:[A-Za-z]:)?[^\s:][^:]*?\.(?:tex|tikz|sty|cls|def|cfg|lua|aux|bbl|toc|out|lof|lot|ldf|fd|clo|sto|cut|ltx|pgf|dtx|ins)):(\d+):\s*(.*)$/.exec(text1);
    if (m) {
      const first = e.parts[0].replace(/^[^:]*?\.(?:tex|tikz|sty|cls|def|cfg|lua|aux|bbl|toc|out|lof|lot|ldf|fd|clo|sto|cut|ltx|pgf|dtx|ins):\d+:\s*/, '');
      const msg = first + (ctx && ctx[2] ? '  [' + ctx[2].trim() + ']' : '');
      const ln = parseInt(m[2], 10) - 1;
      out.push({ kind: 'Error', file: m[1], line: ln, endLine: ln, message: msg });
      return;
    }
    m = /^! (.*)$/.exec(e.parts[0]);
    if (m && curFile) {
      const ln = ctx ? parseInt(ctx[1], 10) - 1 : null;
      out.push({ kind: 'Error', file: curFile, line: ln, endLine: ln, message: m[1].trim() + (ctx && ctx[2] ? '  [' + ctx[2].trim() + ']' : '') });
      return;
    }
    if (/^(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning:/.test(text1) && curFile) {
      const on = /on input line (\d+)/.exec(text1);
      const ln = on ? parseInt(on[1], 10) - 1 : null;
      out.push({ kind: 'Warning', file: curFile, line: ln, endLine: ln, message: text1.replace(/\(\w[\w-]*\)\s+/g, '') });
    }
    // everything else (Info, page numbers, chapter titles printed on the terminal) is ignored
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^=+\s+Summary:/.test(line)) { flush(); inSummary = true; continue; }
    if (inSummary) {
      const pg = /^\s+page \d+ \(file (.+?)\):\s*$/.exec(line);
      if (pg) { curFile = pg[1]; inMissing = false; continue; }
      if (/^\s+(?:Over|Under)full \\hbox/.test(line)) { curFile = curFile || null; entry = { parts: [line.trim()] }; flush(); continue; }
      if (/^Missing characters:/.test(line)) { inMissing = true; continue; }
      if (inMissing) {
        const mm = /^\s+char .*? \(U\+([0-9A-Fa-f]+)\), font (\S+) in page (\d+) \(file (.+?)\)\s*$/.exec(line);
        if (mm) {
          const key = mm[4] + '|' + mm[2] + '|' + mm[3];
          if (!missing.has(key)) missing.set(key, { file: mm[4], font: mm[2], page: mm[3], chars: [], codes: [] });
          missing.get(key).chars.push(String.fromCodePoint(parseInt(mm[1], 16)));
          missing.get(key).codes.push(parseInt(mm[1], 16));
        } else if (line.trim()) inMissing = false;
      }
      continue;
    }
    let m = /^From file (.+):\s*$/.exec(line);
    if (m) { flush(); curFile = m[1].trim(); continue; }
    if (/^After last page:/.test(line)) { flush(); curFile = null; continue; }
    if (/^-{5,}\s*$/.test(line) || !line.trim()) { flush(); continue; }
    m = /^pg (?:\d+|\?):\s?(.*)$/.exec(line);
    if (m) { flush(); entry = { parts: [m[1]] }; continue; }
    if (entry && /^\s+\S/.test(raw)) entry.parts.push(line.trim());
  }
  flush();
  for (const g of missing.values()) {
    out.push({
      kind: 'Missing', file: g.file, line: null, endLine: null,
      font: g.font, page: g.page, chars: g.chars, codes: g.codes,
      message: missingCharMessage(g, null)
    });
  }
  return out;
}

/* ------------------------------- log parser ------------------------- */
const LOG_FILE_RE = /^(?:\.{0,2}\/|[A-Za-z]:[\\/]|\/)?[^\s()]+\.(?:tex|tikz|sty|cls|def|cfg|clo|fd|aux|bbl|lua|ldf|cnf|cut|sto|out|toc|lof|lot|code\.tex)$/i;
const LOG_MSG_START = /^(?:Overfull|Underfull|LaTeX (?:Font )?(?:Warning|Info|Error)|Package|Class|Missing|Runaway|!|l\.\d|\[\]|\s*\\|\s*\(\w[\w-]*\)\s{2,})/;

// Extracts overfull boxes and undefined references / citations together with the source file.
// `log` should be produced with max_print_line=10000 (no wrapped lines).
function parseLog(log, minOverfull) {
  const lines = log.split(/\r?\n/);
  const stack = [];
  const issues = [];
  const top = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i] && /\.(tex|tikz)$/i.test(stack[i])) return stack[i];
    return null;
  };
  for (const line of lines) {
    let m = /^Overfull \\hbox \(([\d.]+)pt too wide\) (?:in paragraph at lines (\d+)--\d+|in alignment at lines (\d+)--\d+|detected at line (\d+)|in paragraph at lines (\d+))/.exec(line);
    if (m) {
      const pts = parseFloat(m[1]);
      const ln = parseInt(m[2] || m[3] || m[4] || m[5], 10);
      const f = top();
      if (f && pts >= minOverfull) issues.push({ file: f, line: ln - 1, severity: 'warning', message: 'Overfull \\hbox: ' + pts + 'pt завширшки' });
      continue;
    }
    m = /^LaTeX Warning: (Reference|Citation) `([^']*)' on page \S+ undefined on input line (\d+)\./.exec(line);
    if (m) {
      const f = top();
      if (f) issues.push({ file: f, line: parseInt(m[3], 10) - 1, severity: 'warning', message: (m[1] === 'Reference' ? 'Невизначене посилання «' : 'Невизначена цитата «') + m[2] + '» (за логом LaTeX)' });
      continue;
    }
    // biblatex: Package biblatex Warning: Citation 'key' undefined on input line N.
    // natbib:   Package natbib Warning: Citation `key' on page P undefined on input line N.
    m = /^Package (?:biblatex|natbib) Warning: Citation [`']([^'`]*)'(?: on page \S+)? undefined on input line (\d+)\./.exec(line);
    if (m) {
      const f = top();
      if (f) issues.push({ file: f, line: parseInt(m[2], 10) - 1, severity: 'warning', message: 'Невизначена цитата «' + m[1] + '» (за логом LaTeX)' });
      continue;
    }
    if (LOG_MSG_START.test(line)) continue;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        const mm = /^[^\s()]+/.exec(line.slice(i + 1));
        const tok = mm ? mm[0] : '';
        stack.push(tok && LOG_FILE_RE.test(tok) ? tok : null);
      } else if (ch === ')') {
        if (stack.length) stack.pop();
      }
    }
  }
  return issues;
}


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

/* ------------------- project .vscode/settings.json template --------- */
// What a project should carry itself (style of the text, build job). Machine-specific values (paths to programs,
// the log parser tool, themes, LaTeX Workshop tools) stay in the user settings.
const PROJECT_SETTINGS_TEMPLATE = {
  'tssworkflow.jobname': 'main',
  'tssworkflow.driver': 'alone.tex',
  'tssworkflow.pdfBeside': true,
  'tssworkflow.forceRebuild': true,
  'tssworkflow.normalizeLineBreaks': 'wrap',
  'tssworkflow.blankLinesParagraph': 1,
  'tssworkflow.blankLinesHeading': 3,
  'tssworkflow.normalizeFrames': false,
  'tssworkflow.normalizeTables': false,
  'tssworkflow.normalizeTypography': true,
  'tssworkflow.displayMathToEquation': true,
  'tssworkflow.normalizeBlankLines': true,
  'tssworkflow.quoteStyle': 'enquote',
  'tssworkflow.frameRules': {
    headings: '%% --------------------------------------------------------',
    section: '%% --------------------------------------------------------',
    formulas: '% ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    align: '% ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'
  }
};

// comments out of JSONC text (string-aware)
function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inStr = false;
  while (i < n) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

// trailing commas before } or ] (string-aware); expects comment-free text
function dropTrailingCommas(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

// index of the last code character (not whitespace, not inside a comment) before `end`
function lastCodeIndex(text, end) {
  let last = -1;
  let inStr = false;
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (inStr) {
      last = i;
      if (c === '\\') { i++; last = i; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; last = i; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < end && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < end && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    if (!/\s/.test(c)) last = i;
  }
  return last;
}

// Adds the keys of `template` that the settings text lacks (top-level keys only, existing ones are never touched);
// comments and formatting of the existing text are kept. -> { text, added: [keys] } or { error }
function mergeMissingSettings(existing, template, comments) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  // `comments`: { 'top.key': { 'nested key': '// comment line put above that nested key' } }
  const entry = (k) => {
    let v = JSON.stringify(template[k], null, 2);
    const cm = comments && comments[k];
    if (cm) {
      v = v.split('\n').map((line) => {
        const m = /^(\s*)("(?:[^"\\]|\\.)*"):/.exec(line);
        let key = null;
        if (m) { try { key = JSON.parse(m[2]); } catch (e) { key = null; } }
        return key !== null && cm[key] ? m[1] + cm[key] + '\n' + line : line;
      }).join('\n');
    }
    return '  ' + JSON.stringify(k) + ': ' + v.replace(/\n/g, '\n  ');
  };
  if (!existing.trim()) {
    const keys = Object.keys(template);
    return { text: '{' + eol + keys.map(entry).join(',' + eol).replace(/\n/g, eol) + eol + '}' + eol, added: keys };
  }
  let obj;
  try { obj = JSON.parse(dropTrailingCommas(stripJsonc(existing.replace(/^\uFEFF/, '')))); } catch (e) { return { error: 'не вдалося розібрати існуючий settings.json' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'settings.json має бути JSON-об\'єктом' };
  const missing = Object.keys(template).filter((k) => !Object.prototype.hasOwnProperty.call(obj, k));
  if (!missing.length) return { text: existing, added: [] };
  const close = existing.lastIndexOf('}');
  if (close < 0) return { error: 'у settings.json немає закриваючої }' };
  const last = lastCodeIndex(existing, close);
  if (last < 0) return { error: 'не вдалося знайти місце вставки' };
  const needComma = existing[last] !== ',' && existing[last] !== '{';
  const body = missing.map(entry).join(',' + eol).replace(/\r?\n/g, eol);
  let lineEnd = existing.indexOf('\n', last);
  if (lineEnd < 0 || lineEnd > close) {
    // the closing brace is on the same line: insert right after the last code character
    const text = existing.slice(0, last + 1) + (needComma ? ',' : '') + eol + body + eol + existing.slice(last + 1);
    return { text, added: missing };
  }
  if (existing[lineEnd - 1] === '\r') lineEnd--;
  const text = existing.slice(0, last + 1) + (needComma ? ',' : '') + existing.slice(last + 1, lineEnd) + eol + body + existing.slice(lineEnd);
  return { text, added: missing };
}

/* ----------- 0.4.3: main file, built-in settings, PATH search ---------- */
// The settings object of a settings.json text: {} for an empty text, null if it cannot be parsed.
function parseSettings(text) {
  if (!String(text).trim()) return {};
  try {
    const o = JSON.parse(dropTrailingCommas(stripJsonc(String(text).replace(/^\uFEFF/, ''))));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (e) { return null; }
}

// Which root .tex file is the main one. `names`: file names of the project root. The driver (alone.tex) is not a
// candidate unless it is the only file. -> { file, source: 'single'|'main'|'default' } or { choose: [names] }
function pickMainTex(names, driver) {
  let tex = (names || []).filter((n) => /\.tex$/i.test(n)).sort((a, b) => a.localeCompare(b));
  const drv = String(driver || 'alone.tex').toLowerCase();
  const rest = tex.filter((n) => n.toLowerCase() !== drv);
  if (rest.length) tex = rest;
  if (!tex.length) return { file: 'main.tex', source: 'default' };
  if (tex.length === 1) return { file: tex[0], source: 'single' };
  const m = tex.find((n) => n.toLowerCase() === 'main.tex');
  if (m) return { file: m, source: 'main' };
  return { choose: tex };
}

// comment lines put above some keys of the generated settings (see mergeMissingSettings)
const PROJECT_SETTINGS_COMMENTS = {
  'files.exclude': { '**/desktop.ini': '// --- Файли ---', '**/.archive': '// --- Папки ---' }
};

// The settings.json of a new project: the style of the text, the build job, the formula preview and the files
// hidden in the Explorer. o: { mainFile, macroFiles: [paths], texlogsieve: bool (the program was found) }
function buildProjectSettings(o) {
  const opt = o || {};
  const mainFile = opt.mainFile || 'main.tex';
  const s = {};
  s['tssworkflow.mainFile'] = mainFile;
  s['tssworkflow.jobname'] = mainFile.replace(/\.[^./\\]*$/, '');
  if (opt.macroFiles && opt.macroFiles.length) s['tssworkflow.macroFiles'] = opt.macroFiles.slice();
  Object.assign(s, {
    'tssworkflow.pdfBeside': true,
    'tssworkflow.forceRebuild': true,
    'tssworkflow.normalizeLineBreaks': 'wrap',
    'tssworkflow.blankLinesParagraph': 1,
    'tssworkflow.blankLinesHeading': 3,
    'tssworkflow.normalizeFrames': false,
    'tssworkflow.normalizeTables': false,
    'tssworkflow.normalizeTypography': true,
    'tssworkflow.displayMathToEquation': true,
    'tssworkflow.normalizeBlankLines': true,
    'tssworkflow.quoteStyle': 'enquote',
    'tssworkflow.singlePass': false
  });
  if (opt.texlogsieve) {
    s['tssworkflow.logParser'] = 'texlogsieve';
    s['tssworkflow.texlogsieveTerminal'] = 'always';
  }
  s['tssworkflow.frameRules'] = PROJECT_SETTINGS_TEMPLATE['tssworkflow.frameRules'];
  s['latex-workshop.hover.preview.newcommand.newcommandFile'] = 'mathjax-macros.tex';
  s['latex-workshop.hover.preview.mathjax.extensions'] = ['boldsymbol'];
  s['files.exclude'] = {
    '**/desktop.ini': true, '**/google*.html': true, '**/descript.ion': true,
    '**/*.bak*': true, '**/*.out': true, '**/*.aux': true, '**/*.log': true, '**/*.gz': true,
    '**/*.bbl': true, '**/*.blg': true, '**/*.bcf': true, '**/*.toc': true, '**/*.idx': true,
    '**/*.ind': true, '**/*.ilg': true, '**/*.nlg': true, '**/*.nlo': true, '**/*.nls': true,
    '**/*.snm': true, '**/*.nav': true, '**/*.fdb_latexmk': true, '**/*.fls': true,
    '**/*.run.xml': true, '**/*.table': true, '**/*.gnuplot': true, '**/*.thm': true,
    '**/*.bbl-*': true, '**/*.bcf-*': true,
    '**/.archive': true, '**/build': true, '**/out': true, '**/.vscode': false, '**/__pycache__': true
  };
  return s;
}

// Finds a program like the shell would. `cmd` is a name or a path. o: { env, platform, exists(file) } (for tests).
// -> the full path or null
function findInPath(cmd, o) {
  const opt = o || {};
  const path = require('path');
  const env = opt.env || process.env;
  const platform = opt.platform || process.platform;
  const win = platform === 'win32';
  const pp = win ? path.win32 : path.posix;
  const exists = opt.exists || ((f) => { try { return require('fs').statSync(f).isFile(); } catch (e) { return false; } });
  const name = String(cmd || '').trim().replace(/^"(.*)"$/, '$1');
  if (!name) return null;
  const exts = win ? [''].concat(String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)) : [''];
  const tryIn = (base) => {
    for (const e of exts) {
      const f = base + (e && !base.toLowerCase().endsWith(e.toLowerCase()) ? e : '');
      if (exists(f)) return f;
    }
    return null;
  };
  if (/[\\/]/.test(name)) return tryIn(name);
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const d of dirs) {
    const r = tryIn(pp.join(d, name));
    if (r) return r;
  }
  return null;
}

// Markdown report of "Check environment". rows: [{ name, what, state: 'ok'|'missing'|'optional', detail }]
function formatEnvReport(rows, o) {
  const opt = o || {};
  const mark = { ok: '✅', missing: '❌', optional: '○' };
  const lines = ['# TSS Workflow: перевірка середовища', ''];
  if (opt.folder) lines.push('Папка: `' + opt.folder + '`', '');
  lines.push('| Що | Стан | Де / версія | Навіщо |', '|---|---|---|---|');
  for (const r of rows) {
    lines.push('| ' + r.name + ' | ' + mark[r.state] + ' | ' + (r.detail || '') + ' | ' + (r.what || '') + ' |');
  }
  const bad = rows.filter((r) => r.state === 'missing');
  lines.push('');
  lines.push(bad.length
    ? '**Бракує потрібного (' + bad.length + '):** ' + bad.map((r) => r.name).join(', ') + '. Додай програму в `PATH` (і перезапусти VS Code) або вкажи повний шлях у налаштуванні розширення.'
    : '**Усе потрібне для поточних налаштувань знайдено.**');
  lines.push('', '✅ знайдено · ❌ немає, а потрібно за поточними налаштуваннями · ○ немає, але зараз не потрібно');
  return lines.join('\n') + '\n';
}

/* --------------- texlogsieve report for the Output channel ------------- */
// entries: [{ kind: 'Error'|'Warning'|'Missing'|'BadBox', file (shown as is), line (0-based or null), message }]
// opts: { job, time, outside }.  Returns an array of lines: sections by kind, sorted by file and line.
function formatTexlogsieveReport(entries, opts) {
  const o = opts || {};
  const SECTIONS = [
    ['Error', 'ПОМИЛКИ'],
    ['Warning', 'ПОПЕРЕДЖЕННЯ'],
    ['Missing', 'MISSING CHARACTERS'],
    ['BadBox', 'OVERFULL / UNDERFULL']
  ];
  const WIDTH = 72;
  const rule = (title) => {
    const head = '── ' + title + ' ';
    return head + '─'.repeat(Math.max(3, WIDTH - head.length));
  };
  const loc = (e) => e.file + (e.line === null || e.line === undefined ? '' : ':' + (e.line + 1));
  const by = (k) => entries.filter((e) => e.kind === k);
  const counts = SECTIONS.map(([k]) => by(k).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const head = '══ texlogsieve · ' + (o.job ? o.job + '.log' : 'log') + (o.time ? ' · ' + o.time : '') + ' ';
  const out = [head + '═'.repeat(Math.max(3, WIDTH - head.length))];
  const sum = [];
  if (counts[0]) sum.push('помилок: ' + counts[0]);
  if (counts[1]) sum.push('попереджень: ' + counts[1]);
  if (counts[2]) sum.push('missing characters: ' + counts[2]);
  if (counts[3]) sum.push('overfull/underfull: ' + counts[3]);
  out.push(total ? sum.join(' · ') : '✓ Проблем у файлах проєкту немає');
  if (o.outside) out.push('(ще ' + o.outside + ' попереджень з пакетів TeX-дерева відкинуто)');
  SECTIONS.forEach(([k, title], i) => {
    const list = by(k).slice().sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return (a.line === null || a.line === undefined ? -1 : a.line) - (b.line === null || b.line === undefined ? -1 : b.line);
    });
    if (!list.length) return;
    out.push('', rule(title + ' (' + list.length + ')'));
    const w = Math.min(60, Math.max.apply(null, list.map((e) => loc(e).length)));
    for (const e of list) {
      const l = loc(e);
      const msg = String(e.message).replace(/\s+/g, ' ').trim();
      out.push('  ' + l + ' '.repeat(Math.max(2, w - l.length + 2)) + msg);
    }
  });
  return out;
}

/* ---------------- \documentclass in a file ------------------------------ */
// true if the text declares \documentclass: outside comments, verbatim-like environments and \verb / \lstinline
// class / package / style files: they are loaded by a document and cannot be built on their own
// (neither as a chapter in the driver nor as a document)
function isPackageFile(fileName) {
  return /\.(?:cls|sty|clo|def|cfg|ldf|bbx|cbx|lbx|fd|bst)$/i.test(String(fileName || ''));
}

function hasDocumentClass(text) {
  const BEGIN = /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|tcblisting)\}/;
  const INLINE = /\\(?:verb\*?|lstinline(?:\[[^\]]*\])?)(.)(.*?)\1/g;
  const DOCCLASS = /(?:^|[^\\])(?:\\\\)*\\documentclass(?![A-Za-z@])/;
  let endRe = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (endRe) {
      if (endRe.test(raw)) endRe = null;
      continue;
    }
    const line = codePart(raw.replace(INLINE, ''));
    const m = BEGIN.exec(line);
    if (m) {
      if (DOCCLASS.test(line.slice(0, m.index))) return true;
      const name = m[1].replace(/\*/g, '\\*');
      const endLocal = new RegExp('\\\\end\\{' + name + '\\}');
      if (!endLocal.test(line.slice(m.index + m[0].length))) endRe = endLocal;
      continue;
    }
    if (DOCCLASS.test(line)) return true;
  }
  return false;
}

/* ------------------- image preview in the hover ------------------------- */
// 91 KB -> "91 КБ", 2.4 MB -> "2,4 МБ"
function formatFileSize(n) {
  if (n < 1048576) return Math.max(1, Math.round(n / 1024)) + ' КБ';
  return (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
}
// largest file shown as a data: URI; a markdown string with a longer base64 body was printed as raw text instead of an image
const DATA_URI_MAX = 64 * 1024;
// what the hover on \includegraphics shows: 'file' (image by file: URI), 'data' (base64 image), 'link' (only the open link),
// 'too-big' (over imagePreviewMaxMB), 'data-too-big' (mode data, file over DATA_URI_MAX)
function imagePreviewPlan(size, mode, maxMB) {
  const mb = Number.isFinite(Number(maxMB)) ? Number(maxMB) : 1;
  if (mode === 'link' || mb <= 0) return { kind: 'link' };
  if (size > mb * 1048576) return { kind: 'too-big', limitMB: mb };
  if (mode === 'data') return size > DATA_URI_MAX ? { kind: 'data-too-big' } : { kind: 'data' };
  return { kind: 'file' };
}

module.exports = {
  splitRow, alignLines, lineKind, noJoinAfter, canJoin, unwrapLines, stripEsc,
  codePart, tikzInlineRanges, blankRanges, codeRanges, ignoreLineRanges, ignoredLineSet, ignoreRanges, setProtectedCommands, parseProtectedCommands, wrapLines, wrapLine, typography, splitSentences, sentenceLines,
  ALIGN_ENVS, parseRows, colAt, tableOp, envTokensPure, pairEnvsPure, bodyStartLine, tableBlockLines,
  convertEnv, CONVERTIBLE, scanLabelsAndRefs, labelAtPos, renamePositions, syntaxChecks,
  frameSections, FRAME_RULE, FRAME_EQ_RULE,
  scanHeadings, alignAllTables, parseLog, envEnd, MATH_ENVS, isRuleLine, displayMathToEquation,
  REF_CMDS, editDistance, suggest, outlineTree,
  protectedRegions, applyLineBreaks, normalizeBlankLines, normalizeLines, parsePplatex, parseTexlogsieve, parseLogErrors, formatTexlogsieveReport, hasDocumentClass, isPackageFile, missingCharMessage, missingCharLines, attachMissingLines, logHint, parseShowHooks, hooksTarget, hooksInject, diagnoseHooksLog, makePassCounter, passWord, formatFileSize, imagePreviewPlan, DATA_URI_MAX,
  scanCites, parseBibKeys, figureChecks, lintRules,
  PROJECT_SETTINGS_TEMPLATE, stripJsonc, dropTrailingCommas, mergeMissingSettings,
  parseSettings, pickMainTex, buildProjectSettings, PROJECT_SETTINGS_COMMENTS, findInPath, formatEnvReport
};
