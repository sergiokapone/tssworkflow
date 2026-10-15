'use strict';
/* termsPure.js: terms of the book (no vscode dependency).
 * A term is what stands in a definition macro (default \emph{...}, tssworkflow.termMacros). The first definition in the order of the book
 * is "the" definition; the same words in the running text before it are "used before defined". Words are compared by their beginning
 * (Ukrainian endings: напруженість / напруженості, заряд / зарядами), see wordMatch.
 *   proseOf(text)                  the text with comments, formulas, pictures, headings and the arguments of \label, \ref, \cite, \index ...
 *                                  blanked (same length: offsets and lines of the original stay valid)
 *   termDefinitions(text, macros)  [{ term, key, words, start, end, line }] in the order of the text
 *   termsReport(files, o)          { terms, early, noIndex, indexKeys }: files [{ path, text }] in the order of the book;
 *                                  o: { macros, ignore, index (the report of the index is wanted), forms (groups of forms of one word: [["потік", "потоку"]]) }
 *   indexInsertions(files, rep, entries)  Map path -> new text: \index{term} after the first definition of each term without an index entry
 *                                  (entries: Map term -> the entry to write, a term that is not in it is skipped; without it the written form)
 *   formsCanon(forms)              word -> the first word of its group of forms (the word itself when it is in no group)
 *   indexEntryFor(text)            the argument of \index for a selected text (specials of makeindex escaped)
 *   formatTermsReport(rep, o)      Markdown
 *   byBookOrder(order)             a comparator of files [{ path }] by the chapter folders of main.tex
 *   fileLineRefs(line)             \"A/A.tex:12\" places in one line of a report: [{ start, len, rel, line, col }] (for clickable links; col is undefined without \":column\") */
const { codePart } = require('./corePure');

const blank = (s) => s.replace(/[^\r\n]/g, ' ');

const EQ_ENVS = 'equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math|tikzpicture|axis|circuitikz|verbatim|lstlisting|minted';
const ARG1 = '\\{(?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*\\}'; // a group with braces nested two levels
const NOT_PROSE = new RegExp('\\\\(?:label|ref|eqref|cref|Cref|autoref|pageref|nameref|cite[A-Za-z]*|includegraphics|index|input|include|includechapter|multiinclude|localinput|usepackage|usetikzlibrary|documentclass|bibliography|bibliographystyle|addbibresource|url|href|newcommand|renewcommand|providecommand|DeclareMathOperator|def|setlength|hspace|vspace|tikzset|pgfplotsset|graphicspath)\\*?(?:\\s*\\[[^\\]]*\\])*\\s*' + ARG1, 'g');
const HEADING = new RegExp('\\\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|caption|captionof|title|author|subcaption)\\*?(?:\\s*\\[[^\\]]*\\])?\\s*' + ARG1, 'g');

// comments blanked (an escaped \% is not a comment); line breaks as in the original
function noComments(text) {
  return String(text).split(/(\r?\n)/).map((p, i) => {
    if (i % 2) return p;
    const c = codePart(p);
    return c + ' '.repeat(p.length - c.length);
  }).join('');
}

function proseOf(text) {
  let t = noComments(text);
  t = t.replace(new RegExp('\\\\begin\\{(' + EQ_ENVS + ')(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}', 'g'), blank);
  t = t.replace(/\$\$[\s\S]*?\$\$/g, blank).replace(/\$(?:[^$\\]|\\[\s\S])*\$/g, blank).replace(/\\\[[\s\S]*?\\\]/g, blank).replace(/\\\([\s\S]*?\\\)/g, blank);
  t = t.replace(HEADING, blank).replace(NOT_PROSE, blank);
  return t;
}

// the text of a term: the argument without commands and braces, spaces collapsed
const cleanTerm = (s) => s.replace(/\\[A-Za-z@]+\*?/g, ' ').replace(/[{}]/g, '').replace(/~/g, ' ').replace(/\s+/g, ' ').trim();

const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’ʼ]*/gu;
const norm = (w) => w.toLowerCase().replace(/[’ʼ]/g, "'");
function wordsOf(s) { const out = []; let m; WORD_RE.lastIndex = 0; while ((m = WORD_RE.exec(s))) out.push({ w: norm(m[0]), start: m.index, end: m.index + m[0].length }); return out; }

// the same word in another form: equal, or a common beginning of at least 4 letters and endings of at most 4 letters on both sides.
// loose (the words of a phrase of several words, the neighbours keep it from false hits): the beginning of 3 letters and endings of at
// most 2 (поле / поля / полем). Not handled: a changing vowel inside the stem (потік / потоку); words of 3 letters match only exactly
function wordMatch(a, b, loose) {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  let k = 0;
  while (k < m && a[k] === b[k]) k++;
  if (k >= 4 && a.length - k <= 4 && b.length - k <= 4) return true;
  return !!loose && k >= 3 && a.length - k <= 2 && b.length - k <= 2;
}
const samePhrase = (a, b) => a.length === b.length && a.every((w, i) => wordMatch(w, b[i], a.length > 1));

// groups of forms of one word (the vowel of the stem changes: потік / потоку / потоком) -> a function word -> the first word of its group.
// Only single words count; a group is an array of strings, a string with several words is cut to its first word; case does not matter
function formsCanon(forms) {
  const map = new Map();
  for (const g of Array.isArray(forms) ? forms : []) {
    if (!Array.isArray(g)) continue;
    const ws = g.map((x) => (wordsOf(String(x))[0] || {}).w).filter(Boolean);
    for (const w of ws) if (!map.has(w)) map.set(w, ws[0]);
  }
  return (w) => map.get(w) || w;
}

const lineStarts = (text) => { const a = [0]; const re = /\n/g; let m; while ((m = re.exec(text))) a.push(m.index + 1); return a; };
function lineOf(starts, off) { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; }

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function macroRe(macros) {
  const names = (macros && macros.length ? macros : ['\\emph']).map((m) => String(m).replace(/^\\/, '')).filter((m) => /^[A-Za-z@]+$/.test(m));
  if (!names.length) return null;
  return new RegExp('\\\\(?:' + names.map(escRe).join('|') + ')\\*?\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}', 'g');
}

const MIN_LEN = 4;      // shorter terms are skipped (a stray \emph{і})
const MAX_WORDS = 6;

function termDefinitions(text, macros, prosed) {
  const pr = prosed || proseOf(text);
  const re = macroRe(macros);
  if (!re) return [];
  const starts = lineStarts(text);
  const out = [];
  let m;
  while ((m = re.exec(pr))) {
    const term = cleanTerm(m[1]);
    const words = wordsOf(term).map((x) => x.w);
    if (term.length < MIN_LEN || !words.length || words.length > MAX_WORDS) continue;
    out.push({ term, key: words.join(' '), words, start: m.index, end: m.index + m[0].length, line: lineOf(starts, m.index) });
  }
  return out;
}

// the keys of \index in the text: [{ words, raw }]; a|b!c: levels, key@display, |format ignored
function indexKeys(text) {
  const t = noComments(text);
  const re = /\\index\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const raw = m[1];
    const body = raw.replace(/\|[^!]*$/, '');
    const words = [];
    for (const lvl of body.split('!')) for (const part of lvl.split('@')) for (const x of wordsOf(cleanTerm(part.replace(/"(.)/g, '$1')))) words.push(x.w);
    out.push({ words, raw });
  }
  return out;
}
const phraseIn = (phrase, tokens) => {
  const loose = phrase.length > 1;
  for (let i = 0; i + phrase.length <= tokens.length; i++) { let ok = true; for (let j = 0; j < phrase.length; j++) if (!wordMatch(phrase[j], tokens[i + j], loose)) { ok = false; break; } if (ok) return true; }
  return false;
};

function termsReport(files, o) {
  const opt = o || {};
  const canon = formsCanon(opt.forms);
  const ignore = new Set((opt.ignore || []).map((s) => wordsOf(String(s)).map((x) => canon(x.w)).join(' ')));
  const docs = files.map((f) => {
    const pr = proseOf(f.text);
    const defs = termDefinitions(f.text, opt.macros, pr).map((df) => { const words = df.words.map(canon); return Object.assign({}, df, { words, key: words.join(' ') }); });
    return { path: f.path, text: f.text, pr, defs, starts: lineStarts(f.text) };
  });
  // the terms: the same term defined twice is one term; its first definition counts
  const terms = [];
  docs.forEach((d, fi) => {
    for (const df of d.defs) {
      if (ignore.has(df.key)) continue;
      let t = terms.find((x) => samePhrase(x.words, df.words));
      if (!t) { t = { term: df.term, words: df.words, def: { fi, path: d.path, line: df.line, start: df.start, end: df.end }, defs: 0 }; terms.push(t); }
      t.defs++;
    }
  });
  // the words of the running text (commands blanked), by the first three letters, in the order of the book
  const tokens = [];
  const byHead = new Map();
  docs.forEach((d, fi) => {
    const plain = d.pr.replace(/\\[A-Za-z@]+\*?/g, blank);
    for (const x of wordsOf(plain)) {
      const tok = { fi, w: canon(x.w), start: x.start, end: x.end, i: tokens.length };
      tokens.push(tok);
      const h = x.w.slice(0, 3);
      if (!byHead.has(h)) byHead.set(h, []);
      byHead.get(h).push(tok);
    }
  });
  const early = [];
  for (const t of terms) {
    if (t.words.length === 1 && t.words[0].length < MIN_LEN) continue;
    const hits = [];
    const loose = t.words.length > 1;
    for (const tok of byHead.get(t.words[0].slice(0, 3)) || []) {
      if (tok.fi > t.def.fi || (tok.fi === t.def.fi && tok.start >= t.def.start)) continue; // from the first definition on it is fine
      let ok = wordMatch(t.words[0], tok.w, loose);
      for (let j = 1; ok && j < t.words.length; j++) { const nx = tokens[tok.i + j]; ok = !!nx && nx.fi === tok.fi && wordMatch(t.words[j], nx.w, loose); }
      if (ok) hits.push(tok);
    }
    if (!hits.length) continue;
    const first = hits[0];
    const d = docs[first.fi];
    const ln = lineOf(d.starts, first.start);
    early.push({ term: t.term, def: t.def, defs: t.defs, count: hits.length, first: { path: d.path, line: ln, text: d.text.split(/\r?\n/)[ln - 1].trim().slice(0, 100) } });
  }
  // the index: which terms have no \index entry
  let keys = [];
  for (const f of files) keys = keys.concat(indexKeys(f.text).map((k) => ({ words: k.words.map(canon), raw: k.raw })));
  const noIndex = opt.index ? terms.filter((t) => !keys.some((k) => phraseIn(t.words, k.words))) : [];
  return { terms, early, noIndex, indexEntries: keys.length };
}

// the argument of \index for a selected text: commands and braces dropped; makeindex specials  ! @ | "  are escaped with "
function indexEntryFor(text) {
  return cleanTerm(String(text)).replace(/(["!@|])/g, '"$1');
}

// \index{term} right after the first definition of each term without an index entry (rep from termsReport with index: true)
function indexInsertions(files, rep, entries) {
  const byPath = new Map();
  for (const t of rep.noIndex) {
    const f = files[t.def.fi];
    if (!f) continue;
    const entry = entries ? entries.get(t.term) : t.term;
    const arg = entry === undefined ? '' : indexEntryFor(entry);
    if (!arg) continue; // not asked for (or nothing left of it after the commands are dropped)
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push({ at: t.def.end, text: '\\index{' + arg + '}' });
  }
  const out = new Map();
  for (const [p, ins] of byPath) {
    let text = files.find((f) => f.path === p).text;
    for (const x of ins.sort((a, b) => b.at - a.at)) text = text.slice(0, x.at) + x.text + text.slice(x.at);
    out.set(p, text);
  }
  return out;
}

function formatTermsReport(rep, o) {
  const opt = o || {};
  const L = ['# Терміни' + (opt.folder ? ' — ' + opt.folder : ''), ''];
  L.push('Означення: ' + (opt.macros && opt.macros.length ? opt.macros.join(', ') : '\\emph') + ' (налаштування `tssworkflow.termMacros`). Означених термінів: ' + rep.terms.length + '. Слова порівнюються за початком (напруженість / напруженості); чергування голосних у корені (потік / потоку) не враховано.', '');
  L.push('## Вжито раніше, ніж означено', '');
  if (!rep.early.length) L.push('Немає: жоден термін не трапляється в тексті до свого першого означення.', '');
  else {
    L.push('| Термін | Означено | Перше раніше вживання | Разів |', '|---|---|---|---|');
    for (const e of rep.early.slice(0, 300)) L.push('| ' + e.term + ' | ' + e.def.path + ':' + e.def.line + ' | ' + e.first.path + ':' + e.first.line + ' — ' + e.first.text.replace(/\|/g, '\\|') + ' | ' + e.count + ' |');
    if (rep.early.length > 300) L.push('', '…і ще ' + (rep.early.length - 300) + '.');
    L.push('', 'Хибні спрацювання (слово вжито в іншому значенні, `\\emph` для виділення, а не означення) прибираються налаштуванням `tssworkflow.termsIgnore`.', '');
  }
  if (opt.index) {
    L.push('## Означені терміни без запису в покажчику', '');
    if (!rep.noIndex.length) L.push('Немає: кожен означений термін є серед ' + rep.indexEntries + ' записів `\\index`.', '');
    else for (const t of rep.noIndex.slice(0, 300)) L.push('- ' + t.term + ' (' + t.def.path + ':' + t.def.line + ')');
    L.push('');
  } else {
    L.push('## Покажчик', '', 'Вимкнено: у перших рядках головного файла немає `% !TEX indexprogram = upmendex` (`makeindex`, `mendex`). Записів `\\index` у проєкті: ' + rep.indexEntries + '.', '');
  }
  return L.join('\n');
}

// files sorted like the book: by the chapter folder in the order of the list of main.tex (a folder that is not there goes after them)
function byBookOrder(order) {
  const rank = (p) => { if (!p.includes('/')) return 1e7; const i = order.indexOf(p.split('/')[0]); return i < 0 ? 1e6 : i; };
  return (a, b) => (rank(a.path) - rank(b.path)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// places like  Розділ/Розділ.tex:12  or  Розділ/Розділ.tex:12:5  in a line of a report (the relative path of a .tex/.tikz/.sty/.cls/.bib file,
// a colon, the line, optionally a colon and the column); line 0 is not a place
const REF_RE = /(?<![\p{L}\p{N}_@+./\\-])((?:[\p{L}\p{N}_@+.-]+\/)*[\p{L}\p{N}_@+.-]+\.(?:tex|tikz|sty|cls|bib)):(\d+)(?::(\d+))?(?!\d)/gu;
function fileLineRefs(line) {
  const out = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(String(line)))) {
    const ln = parseInt(m[2], 10);
    if (ln < 1) continue;
    const col = m[3] === undefined ? undefined : parseInt(m[3], 10);
    out.push({ start: m.index, len: m[0].length, rel: m[1], line: ln, col: col >= 1 ? col : undefined });
  }
  return out;
}

module.exports = { fileLineRefs, formsCanon, proseOf, termDefinitions, indexKeys, termsReport, indexEntryFor, indexInsertions, formatTermsReport, byBookOrder, wordMatch, wordsOf };
