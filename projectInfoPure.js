'use strict';
/* Pure helpers (no vscode API) for: .aux parsing, project statistics, TODO scan,
 * extra typography checks, numbered equations nobody refers to. Tested by tests/projectInfo.test.js. */
const P = require('./corePure');

/* ------------------------------ .aux ------------------------------- */
// reads the balanced {...} group that starts at s[i] (after whitespace); null if there is none
function group(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== '{') return null;
  let d = 0;
  for (let c = i; c < s.length; c++) {
    const ch = s[c];
    if (ch === '\\') { c++; continue; }
    if (ch === '{') d++;
    else if (ch === '}') { d--; if (d === 0) return { text: s.slice(i + 1, c), end: c + 1 }; }
  }
  return null;
}

const cleanAux = (t) => String(t || '').replace(/\\(?:relax|protect|nobreakspace)\s*(\{\})?/g, ' ').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

// \newlabel{name}{{number}{page}{title}{anchor}{}}  ->  Map name -> { num, page, title }
function parseAux(text) {
  const out = new Map();
  const re = /\\newlabel\{/g;
  let m;
  while ((m = re.exec(text))) {
    const ns = m.index + m[0].length;
    const ne = text.indexOf('}', ns);
    if (ne < 0) break;
    const name = text.slice(ns, ne);
    const outer = group(text, ne + 1);
    if (!outer) continue;
    re.lastIndex = outer.end;
    if (/@cref$/.test(name)) continue; // cleveref duplicates
    const parts = [];
    let j = 0;
    while (j < outer.text.length) {
      const g = group(outer.text, j);
      if (!g) break;
      parts.push(g.text);
      j = g.end;
    }
    out.set(name, { num: cleanAux(parts[0]), page: cleanAux(parts[1]), title: cleanAux(parts[2]) });
  }
  return out;
}

// names of the sub-aux files mentioned by \@input{...}
function auxInputs(text) {
  const out = [];
  const re = /\\@input\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

/* ------------------------- words and statistics -------------------- */
const VERB_ENVS = 'verbatim\\*?|Verbatim\\*?|lstlisting|minted|comment|tcblisting|tikzpicture';
const NUMBERED = ['equation', 'align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat'];
const MATH_ENV_NAMES = NUMBERED.concat(['displaymath', 'math']);

// text without comments, verbatim-like environments (and tikz pictures)
function stripComments(text) {
  let t = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => P.codePart(l)).join('\n');
  t = t.replace(new RegExp('\\\\begin\\{(' + VERB_ENVS + ')\\}[\\s\\S]*?\\\\end\\{\\1\\}', 'g'), ' ');
  return t;
}

function stripMath(t) {
  t = t.replace(new RegExp('\\\\begin\\{(' + MATH_ENV_NAMES.join('|') + ')(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}', 'g'), ' ');
  t = t.replace(/\\\$/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$]*\$/g, ' ');
  t = t.replace(/\\\[[\s\S]*?\\\]/g, ' ').replace(/\\\([\s\S]*?\\\)/g, ' ');
  return t;
}

// number of words of the running text: no comments, formulas, verbatim, no arguments of \label \ref \cite ...
function countWords(text) {
  let t = stripMath(stripComments(text));
  t = t.replace(/\\hypertarget\*?\{[^}]*\}\{[^}]*\}/g, ' ');
  t = t.replace(/\\(?:label|ref|eqref|pageref|autoref|nameref|cref|Cref|cite[A-Za-z]*|includegraphics|localinput|includechapter|includetikz|hyperlink|hyperref|begin|end|usepackage|documentclass|RequirePackage|input|include|url|href|pagestyle|bibliographystyle|bibliography)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, ' ');
  t = t.replace(/\\[A-Za-z@]+\*?/g, ' ').replace(/\\./g, ' ');
  let n = 0;
  const re = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
  let m;
  while ((m = re.exec(t))) if (/\p{L}/u.test(m[0])) n++;
  return n;
}

function countRe(t, re) {
  const m = t.match(re);
  return m ? m.length : 0;
}

// counters of a piece of text; extra: { name: regexSource }
function textStats(text, extra) {
  const t = stripComments(text);
  const st = {
    words: countWords(text),
    eqNum: countRe(t, new RegExp('\\\\begin\\{(?:' + NUMBERED.join('|') + ')\\}', 'g')),
    eqStar: countRe(t, new RegExp('\\\\begin\\{(?:' + NUMBERED.join('|') + '|displaymath)\\*\\}', 'g')) + countRe(t, /\\\[/g) + countRe(t, /\$\$/g) / 2,
    figures: countRe(t, /\\begin\{(?:figure\*?|SCfigure|wrapfigure|sidewaysfigure\*?)\}/g),
    tables: countRe(t, /\\begin\{(?:table\*?|longtable|sidewaystable\*?)\}/g),
    tikz: countRe(t, /\\localinput\{/g) + countRe(t, /\\begin\{tikzpicture\}/g),
    cites: countRe(t, /\\cite[A-Za-z]*\*?(?:\[[^\]]*\])*\{/g),
    extra: {}
  };
  st.eqStar = Math.floor(st.eqStar);
  for (const [name, src] of Object.entries(extra || {})) {
    try { st.extra[name] = countRe(t, new RegExp(src, 'g')); } catch (e) { st.extra[name] = 0; }
  }
  return st;
}

// rows for one file: the total and one row per \chapter / \section (up to the next one)
function fileStats(text, extra) {
  const lines = String(text).split(/\r?\n/);
  const heads = P.scanHeadings(lines).filter((h) => h.level >= 1 && h.level <= 2);
  const total = textStats(text, extra);
  const rows = [];
  const part = (from, to) => lines.slice(from, to).join('\n');
  if (heads.length) {
    const intro = textStats(part(0, heads[0].line), extra);
    if (intro.words || intro.eqNum || intro.eqStar || intro.figures) rows.push({ title: '(до першого заголовка)', level: 0, st: intro });
    heads.forEach((h, i) => rows.push({
      title: h.title, level: h.level, kind: h.kind, line: h.line,
      st: textStats(part(h.line, i + 1 < heads.length ? heads[i + 1].line : lines.length), extra)
    }));
  }
  return { total, rows };
}

function addStats(a, b) {
  const r = { words: a.words + b.words, eqNum: a.eqNum + b.eqNum, eqStar: a.eqStar + b.eqStar, figures: a.figures + b.figures,
    tables: a.tables + b.tables, tikz: a.tikz + b.tikz, cites: a.cites + b.cites, extra: Object.assign({}, a.extra) };
  for (const [k, v] of Object.entries(b.extra)) r.extra[k] = (r.extra[k] || 0) + v;
  return r;
}

const emptyStats = () => ({ words: 0, eqNum: 0, eqStar: 0, figures: 0, tables: 0, tikz: 0, cites: 0, extra: {} });

/* ------------------------------- TODO ------------------------------ */
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// [{ line, kw, text }] : keywords inside % comments, and \todo{...} commands
function scanTodos(text, keywords) {
  const kws = (Array.isArray(keywords) && keywords.length ? keywords : ['TODO', 'FIXME']).map(String).filter(Boolean);
  const kwRe = new RegExp('(?<![\\p{L}\\p{N}_])(' + kws.map(escRe).join('|') + ')(?![\\p{L}\\p{N}_])[\\s:.\\-—]*(.*)$', 'u');
  const out = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const code = P.codePart(line);
    const td = /\\todo(?:\[[^\]]*\])?\{([^}]*)\}/.exec(code);
    if (td) out.push({ line: i, kw: 'TODO', text: td[1].trim() });
    if (code.length < line.length) {
      const comment = line.slice(code.length);
      const m = kwRe.exec(comment);
      if (m) out.push({ line: i, kw: m[1], text: m[2].trim() });
    }
  });
  return out;
}

/* ------------------------- typography checks ----------------------- */
const UNITS = ['мкм', 'мм', 'см', 'дм', 'км', 'нм', 'пм', 'м', 'кг', 'мг', 'г', 'т', 'мкс', 'мс', 'нс', 'хв', 'год', 'с', 'Гц', 'кГц', 'МГц', 'ГГц',
  'кДж', 'МДж', 'Дж', 'кеВ', 'МеВ', 'ГеВ', 'еВ', 'кВт', 'МВт', 'Вт', 'кВ', 'мВ', 'В', 'мА', 'А', 'кОм', 'МОм', 'Ом', 'мТл', 'Тл', 'Гс',
  'кН', 'Н', 'кПа', 'МПа', 'ГПа', 'Па', 'атм', 'К', 'моль', 'Кл', 'Ф', 'Гн', 'Вб', 'Бк', 'мл', 'л', 'дБ', 'рад', '\\\\%'];
const UNIT_RE = new RegExp('(?<![\\p{L}\\p{N}_\\\\])(\\d+(?:[.,]\\d+)?)([ \\u00a0])(' + UNITS.join('|') + ')(?![\\p{L}\\p{N}])', 'gu');
const ABBR_BEFORE = ['рис', 'табл', 'дод', 'див', 'стор', 'розд', 'гл', 'ст', 'пп', 'п', 'т', 'с', 'Рис', 'Табл', 'Дод', 'Див', 'Стор', 'Розд', 'Гл', 'Ст'];
const ABBR_RE = new RegExp('(?<![\\p{L}\\p{N}])(' + ABBR_BEFORE.join('|') + ')\\.( )', 'gu');
const ABBR_AFTER_RE = /(?<![\p{L}\p{N}])(\d+)( )((?:рр?|ст)\.|тис\.|млн|млрд|грн)(?![\p{L}\p{N}])/gu;
const DASH_RE = /(?<=[\p{L}\p{N})\]}.,:;!?»”"'])( -{1,2} )(?=[\p{L}\p{N}(\[«“"'\\])/gu;
const HOMOGLYPH = { a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' };
const CYR = /\p{Script=Cyrillic}/u;
const LAT = /\p{Script=Latin}/u;

// replaces `s` by spaces of the same length
const blank = (s) => s.replace(/[^\n]/g, ' ');

// text of a line with commands, their non-text arguments, inline math and \verb blanked out (same length)
function maskLine(code) {
  let t = code.replace(/\\verb\*?(.).*?\1/g, blank);
  t = t.replace(/\\\$/g, '  ');
  t = t.replace(/\$[^$]*\$/g, blank).replace(/\\\([^)]*?\\\)/g, blank);
  t = t.replace(/\\(?:label|ref|eqref|pageref|autoref|nameref|cref|Cref|cite[A-Za-z]*|includegraphics|localinput|includechapter|includetikz|hypertarget|hyperlink|hyperref|usepackage|input|include|url|href|begin|end|documentclass|RequirePackage|pagestyle)\*?(?:\[[^\]]*\])?(?:\{[^}]*\}){1,2}/g, blank);
  t = t.replace(/\\[A-Za-z@]+\*?/g, blank).replace(/\\[^A-Za-z]/g, '  ');
  return t;
}

const DEF_LINE = /^\s*\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|def|gdef|edef|xdef|let|DeclareMathOperator|newenvironment|renewenvironment|NewDocumentEnvironment|newtheorem|newtcolorbox|usepackage|RequirePackage)\b/;
const SKIP_ENVS = /^(?:verbatim\*?|Verbatim\*?|lstlisting|minted|comment|tcblisting|tikzpicture|pgfpicture|circuitikz|axis|equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|flalign\*?|alignat\*?|displaymath|math|filecontents\*?)$/;

// extra typography checks: non-breaking spaces, dashes, mixed-script words, mixed \vec / \vect
// returns [{ line, col, len, code, message }]
function typographyChecks(lines, opts) {
  // TikZ-like code (inline \tikz{...}, \tikzset{...}, the user's protectedCommands; also across lines) is not text:
  // blank it out, columns stay the same. Lines marked `% tss-ignore` are dropped from the result at the end.
  const joined = lines.join('\n');
  const ignored = P.ignoredLineSet(lines);
  lines = P.blankRanges(joined, P.tikzInlineRanges(joined, opts && opts.protectedCommands)).split('\n');
  const out = [];
  const stack = [];
  let dollars = false; // inside a $$ ... $$ block
  let bracket = false; // inside \[ ... \]
  let inline = false; // an inline $...$ formula continues from the previous line
  lines.forEach((raw, i) => {
    const code = P.codePart(raw);
    const wasInline = inline;
    if (code.trim() === '') inline = false;
    else {
      const c = (code.replace(/\\\$/g, '').replace(/\$\$/g, '').match(/\$/g) || []).length;
      inline = wasInline ? c % 2 === 0 : c % 2 === 1;
    }
    const envRe = /\\(begin|end)\{([^{}]*)\}/g;
    const wasSkipping = stack.length > 0 || dollars || bracket;
    let m;
    while ((m = envRe.exec(code))) {
      if (m[1] === 'begin' && SKIP_ENVS.test(m[2])) stack.push(m[2]);
      else if (m[1] === 'end' && stack.length && stack[stack.length - 1] === m[2]) stack.pop();
    }
    if ((code.match(/\$\$/g) || []).length % 2 === 1) dollars = !dollars;
    if (/\\\[/.test(code) && !/\\\]/.test(code)) bracket = true;
    else if (/\\\]/.test(code)) bracket = false;
    if (wasSkipping || stack.length || dollars || bracket) return;
    if (DEF_LINE.test(code)) return;
    const t = wasInline ? maskLine('$' + code).slice(1) : maskLine(code);
    const push = (col, len, c, message) => out.push({ line: i, col, len, code: c, message });
    let r;
    UNIT_RE.lastIndex = 0;
    while ((r = UNIT_RE.exec(t))) push(r.index, r[0].length, 'typo-nbsp', 'Між числом і одиницею — нерозривний пробіл («~» або «\\,»)');
    ABBR_RE.lastIndex = 0;
    while ((r = ABBR_RE.exec(t))) if (/[\d\\(\[]/.test(code[r.index + r[0].length] || '')) push(r.index, r[0].length, 'typo-nbsp', 'Після скорочення «' + r[1] + '.» — нерозривний пробіл («~»)');
    ABBR_AFTER_RE.lastIndex = 0;
    while ((r = ABBR_AFTER_RE.exec(t))) push(r.index, r[0].length, 'typo-nbsp', 'Між числом і «' + r[3] + '» — нерозривний пробіл («~»)');
    DASH_RE.lastIndex = 0;
    while ((r = DASH_RE.exec(t))) push(r.index, r[0].length, 'typo-dash', 'Дефіс замість тире: у тексті ставиться « --- »');
    const wre = /\p{L}+/gu;
    while ((r = wre.exec(t))) {
      if (CYR.test(r[0]) && LAT.test(r[0])) push(r.index, r[0].length, 'typo-mixed-script', 'Слово «' + r[0] + '» змішує кирилицю й латиницю');
    }
  });
  // \vec in some places and \vect in others
  for (const pair of (opts && opts.mixedMacros) || []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const found = [[], []];
    const res = pair.map((n) => new RegExp('\\\\' + escRe(String(n)) + '(?![A-Za-z@])', 'g'));
    lines.forEach((raw, i) => {
      const code = P.codePart(raw);
      if (DEF_LINE.test(code)) return;
      res.forEach((re, k) => {
        re.lastIndex = 0;
        let r;
        while ((r = re.exec(code))) found[k].push({ line: i, col: r.index, len: r[0].length });
      });
    });
    if (found[0].length && found[1].length) {
      const minority = found[0].length < found[1].length ? 0 : 1;
      const major = 1 - minority;
      for (const f of found[minority]) {
        out.push({ line: f.line, col: f.col, len: f.len, code: 'typo-mixed-macro',
          message: 'У файлі змішано \\' + pair[0] + ' (' + found[0].length + ') і \\' + pair[1] + ' (' + found[1].length + '); частіше — \\' + pair[major] });
      }
    }
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return ignored.size ? out.filter((r) => !ignored.has(r.line)) : out;
}

// Latin letters of a mixed word -> Cyrillic look-alikes; null when some letter has none
function fixHomoglyphs(word) {
  let res = '';
  for (const ch of word) {
    if (/\p{Script=Latin}/u.test(ch)) {
      if (!HOMOGLYPH[ch]) return null;
      res += HOMOGLYPH[ch];
    } else res += ch;
  }
  return res;
}

/* ---------------- numbered equations nobody refers to --------------- */
// numbered formula environments (not starred) with no used label; used: Set of referenced label names
function numberedEquations(lines, used) {
  const out = [];
  const re = new RegExp('\\\\begin\\{(' + NUMBERED.join('|') + ')\\}');
  for (let i = 0; i < lines.length; i++) {
    const vb = new RegExp('\\\\begin\\{(' + VERB_ENVS + ')\\}').exec(P.codePart(lines[i]));
    if (vb) {
      const e = P.envEnd(lines, vb[1], i, vb.index + vb[0].length);
      if (!e) break;
      i = e.line;
      continue;
    }
    const code = P.codePart(lines[i]);
    const m = re.exec(code);
    if (!m) continue;
    const end = P.envEnd(lines, m[1], i, m.index + m[0].length);
    if (!end) continue;
    const labels = [];
    let tag = false;
    let macroLabel = false;
    for (let l = i; l <= end.line; l++) {
      const c = P.codePart(lines[l]);
      const lr = /\\label\{([^}]*)\}/g;
      let x;
      while ((x = lr.exec(c))) { labels.push(x[1].trim()); if (x[1].includes('\\')) macroLabel = true; }
      if (/\\tag\b/.test(c)) tag = true;
    }
    const referenced = labels.filter((n) => used.has(n));
    out.push({ line: i, endLine: end.line, env: m[1], beginCol: m.index, labels, referenced, tag, macroLabel,
      candidate: !referenced.length && !tag && !macroLabel });
    i = end.line;
  }
  return out;
}

// the lines of the item with the starred environment and without \label
function starEquation(lines, item) {
  const res = [];
  for (let l = item.line; l <= item.endLine; l++) {
    let text = lines[l];
    if (l === item.line) {
      const tok = '\\begin{' + item.env + '}';
      const at = text.indexOf(tok, item.beginCol);
      if (at >= 0) text = text.slice(0, at) + '\\begin{' + item.env + '*}' + text.slice(at + tok.length);
    }
    if (l === item.endLine) {
      const tok = '\\end{' + item.env + '}';
      const at = text.lastIndexOf(tok);
      if (at >= 0) text = text.slice(0, at) + '\\end{' + item.env + '*}' + text.slice(at + tok.length);
    }
    const had = /\\label\{[^}]*\}/.test(text);
    const next = text.replace(/[ \t]*\\label\{[^}]*\}/g, '');
    if (had && next.trim() === '') continue; // the line held only the label
    res.push(next);
  }
  return res;
}

// Fixes for the typography hints, computed from the current text (never from stale diagnostics).
// opts.codes: which hints to fix, default ["typo-nbsp"]; the rest of opts goes to typographyChecks.
// -> [{ line, col, len, text }] sorted by position, without overlaps
const FIXABLE = ['typo-nbsp', 'typo-dash', 'typo-mixed-script'];
function typoFixPlan(lines, opts) {
  opts = opts || {};
  const codes = new Set((opts.codes || ['typo-nbsp']).filter((c) => FIXABLE.includes(c)));
  const edits = [];
  for (const r of typographyChecks(lines, opts)) {
    if (!codes.has(r.code)) continue;
    const old = lines[r.line].substr(r.col, r.len);
    let neu = null;
    if (r.code === 'typo-nbsp') neu = old.replace(/[ \u00a0]/, '~');
    else if (r.code === 'typo-dash') neu = ' --- ';
    else neu = fixHomoglyphs(old);
    if (neu === null || neu === old) continue;
    const last = edits[edits.length - 1];
    if (last && last.line === r.line && r.col < last.col + last.len) continue;
    edits.push({ line: r.line, col: r.col, len: r.len, text: neu });
  }
  return edits;
}

// the same edits applied to an array of lines -> { lines, count }
function applyTypoFixes(lines, opts) {
  const plan = typoFixPlan(lines, opts);
  const out = lines.slice();
  for (const ed of plan.slice().reverse()) out[ed.line] = out[ed.line].slice(0, ed.col) + ed.text + out[ed.line].slice(ed.col + ed.len);
  return { lines: out, count: plan.length };
}

module.exports = {
  parseAux, auxInputs, countWords, textStats, fileStats, addStats, emptyStats, scanTodos,
  typographyChecks, typoFixPlan, applyTypoFixes, fixHomoglyphs, numberedEquations, starEquation, stripComments
};
