'use strict';
/* Pure helpers of TSS Workflow 0.5.0 (no VS Code API):
 *   chapters: rename, move up/down, build only some \part's
 *   project-wide LaTeX-aware search and replace; notation consistency across the project
 *   .bib entries for \cite completion and hover
 *   the tree of the "Проблеми" panel; names and pruning of project snapshots */
const C = require('./chaptersPure');
const { escRe } = require('./corePure');


/* ================================ chapters ================================= */
// 'Charges', 'Steady-Efield', 'A_1': letters, digits, _ and -, starting with a letter (it is a folder AND a file name)
const validChapterName = (n) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(String(n || ''));

// All chapter names of the main file in the order of the file: [{ name, start, end, kind }]; start/end are the offsets of the
// name itself. kind: 'single' (`\includechapter{X}`) or 'list' (`\multiinclude{A, B}`). Comments are skipped.
function chapterItems(mainText, macro, listMacros) {
  const text = String(mainText);
  const masked = C.maskComments(text);
  const items = [];
  let m;
  const one = new RegExp(escRe(macro || '\\includechapter') + '(?![A-Za-z])\\s*\\{(\\s*)([^{}\\s]+)\\s*\\}', 'g');
  while ((m = one.exec(masked))) {
    const start = m.index + m[0].indexOf('{') + 1 + m[1].length;
    items.push({ name: m[2], start, end: start + m[2].length, kind: 'single' });
  }
  for (const lm of listMacros || []) {
    if (!lm) continue;
    const re = new RegExp(escRe(lm) + '(?![A-Za-z])\\s*\\{([^{}]*)\\}', 'g');
    while ((m = re.exec(masked))) {
      const open = m.index + m[0].indexOf('{') + 1;
      const inner = m[1];
      const tok = /[^,\s]+/g;
      let t;
      while ((t = tok.exec(inner))) {
        if (/[\\{}]/.test(t[0])) continue;
        items.push({ name: t[0], start: open + t.index, end: open + t.index + t[0].length, kind: 'list' });
      }
    }
  }
  return items.sort((a, b) => a.start - b.start);
}

// the names at two ranges exchanged (the later range is replaced first, so the offsets stay valid)
function swapRanges(text, a, b) {
  const [x, y] = a.start < b.start ? [a, b] : [b, a];
  const tx = text.slice(x.start, x.end);
  const ty = text.slice(y.start, y.end);
  return text.slice(0, x.start) + ty + text.slice(x.end, y.start) + tx + text.slice(y.end);
}

// Moves chapter `name` one place up (dir = -1) or down (+1) in the order of the main file by exchanging its name with the
// neighbour's one. Works across \multiinclude lists and \part's, because only the two names change places.
// -> { text, with } | { error }
function moveChapter(mainText, name, dir, macro, listMacros) {
  const items = chapterItems(mainText, macro, listMacros);
  const i = items.findIndex((x) => x.name === name);
  if (i < 0) return { error: 'notfound' };
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0) return { error: 'first' };
  if (j >= items.length) return { error: 'last' };
  if (items[j].name === name) return { error: 'same' };
  return { text: swapRanges(String(mainText), items[i], items[j]), with: items[j].name };
}

// The chapter names inside the lists and \includechapter{..} replaced (only in code, not in comments)
function renameInMain(mainText, oldName, newName, macro, listMacros) {
  const items = chapterItems(mainText, macro, listMacros).filter((x) => x.name === oldName);
  let text = String(mainText);
  for (const it of items.slice().sort((a, b) => b.start - a.start)) text = text.slice(0, it.start) + newName + text.slice(it.end);
  return { text, count: items.length };
}

const REF_ARG = '(?:ref|eqref|pageref|autoref|nameref|vref|Vref|cref|Cref|cpageref|Cpageref|hyperref|labelcref)';

// Everything that follows from renaming the chapter folder X (X/X.tex) to Y.
// files: [{ path: 'rel/with/slashes', text }] (text files of the project, the main file among them);
// o: { mainFile, macro, listMacros }. Returns { changes: Map(path -> new text), stat }.
// What is changed: the name in the chapter lists of the main file; `X/X`, `X/Pictures/`, `X/tikz/` in paths of other files;
// when the chapter's files use \currfilebase, also the references \ref{X} and \ref{X:...} (their labels follow the file name).
function renameChapterTexts(files, oldName, newName, o) {
  o = o || {};
  const stat = { main: 0, paths: 0, refs: 0 };
  const changes = new Map();
  const inside = (p) => p.startsWith(oldName + '/');
  const usesBase = files.some((f) => inside(f.path) && /\\currfilebase/.test(f.text));
  const pathRe = new RegExp('(^|[^A-Za-z0-9_\\-/.])' + escRe(oldName) + '/(' + escRe(oldName) + '(?![A-Za-z0-9_-])|(?=Pictures/|tikz/))', 'g');
  const refRe = new RegExp('(\\\\' + REF_ARG + '\\*?(?:\\[[^\\]]*\\])?\\{)([^{}%]*)\\}', 'g');
  const mapRefs = (arg) => arg.split(',').map((part) => {
    const lead = /^\s*/.exec(part)[0];
    const name = part.trim();
    if (name === oldName) return lead + newName + part.slice(lead.length + name.length);
    if (name.startsWith(oldName + ':')) return lead + newName + name.slice(oldName.length) + part.slice(lead.length + name.length);
    return part;
  }).join(',');
  for (const f of files) {
    let text = f.text;
    if (o.mainFile && f.path === o.mainFile) {
      const r = renameInMain(text, oldName, newName, o.macro, o.listMacros);
      text = r.text;
      stat.main += r.count;
    }
    // only code lines (a % comment keeps its text)
    text = text.split('\n').map((line) => {
      const cut = C.stripComment(line);
      let head = cut;
      const tail = line.slice(cut.length);
      if (!inside(f.path)) {
        head = head.replace(pathRe, (all, pre, second) => { stat.paths++; return pre + newName + '/' + (second ? newName : ''); });
      }
      if (usesBase) {
        head = head.replace(refRe, (all, pre, arg) => {
          const neu = mapRefs(arg);
          if (neu !== arg) stat.refs++;
          return pre + neu + '}';
        });
      }
      return head + tail;
    }).join('\n');
    if (text !== f.text) changes.set(f.path, text);
  }
  return { changes, stat };
}

/* ------------------------------ build \part's ----------------------------- */
// The main file with the chapters of the parts that are not in `keep` (indexes of chapterStructure) blanked out: their
// \includechapter{..}, \multiinclude{..}[..] and \part{..} are replaced by spaces (newlines stay, so line numbers do not move).
function filterMainForParts(mainText, macro, listMacros, keep) {
  const text = String(mainText);
  const masked = C.maskComments(text);
  const keepSet = new Set(keep);
  const spans = []; // { i, end, part?: true }
  let m;
  const partRe = /\\part\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  while ((m = partRe.exec(masked))) spans.push({ i: m.index, end: m.index + m[0].length, kind: 'part' });
  const one = new RegExp(escRe(macro || '\\includechapter') + '(?![A-Za-z])\\s*\\{[^{}]*\\}', 'g');
  while ((m = one.exec(masked))) spans.push({ i: m.index, end: m.index + m[0].length, kind: 'chap' });
  for (const lm of listMacros || []) {
    if (!lm) continue;
    const re = new RegExp(escRe(lm) + '(?![A-Za-z])\\s*\\{[^{}]*\\}(?:\\s*\\[[^\\]]*\\])?', 'g');
    while ((m = re.exec(masked))) spans.push({ i: m.index, end: m.index + m[0].length, kind: 'chap' });
  }
  spans.sort((a, b) => a.i - b.i);
  // groups as in chapterStructure: the chapters before the first \part, then one group per \part; a group without
  // chapters is not counted (it has no number), so its \part is always blanked
  const groups = [{ spans: [], chap: false }];
  for (const s of spans) {
    if (s.kind === 'part') groups.push({ spans: [s], chap: false });
    else { const g = groups[groups.length - 1]; g.spans.push(s); g.chap = true; }
  }
  let n = 0;
  for (const g of groups) g.num = g.chap ? n++ : -1;
  let out = text;
  const todo = [];
  for (const g of groups) for (const s of g.spans) if (!keepSet.has(g.num)) todo.push(s);
  for (const s of todo.sort((x, y) => y.i - x.i)) {
    const blank = out.slice(s.i, s.end).replace(/[^\n]/g, ' ');
    out = out.slice(0, s.i) + blank + out.slice(s.end);
  }
  return out;
}

/* --------------------- project-wide search and replace --------------------- */
const VERB_ENV = /^(verbatim\*?|lstlisting|minted|Verbatim\*?|comment|alltt)$/;

// Replaces `find` by `repl` in the code of `text` (not in % comments, not in verbatim-like environments, not in \verb).
// o: { regex, wholeMacro (a plain `\name` does not match `\nameX`), caseSensitive }.
// -> { text, count, hits: [{ line, col, len, before }] }
function replaceInText(text, find, repl, o) {
  o = o || {};
  const out = { text, count: 0, hits: [] };
  if (!find) return out;
  let src = o.regex ? find : escRe(find);
  if (!o.regex && o.wholeMacro !== false && /^\\[A-Za-z@]+$/.test(find)) src += '(?![A-Za-z@])';
  let re;
  try { re = new RegExp(src, 'g' + (o.caseSensitive === false ? 'i' : '')); } catch (e) { out.error = e.message; return out; }
  const lines = String(text).split('\n');
  let verb = null;
  const res = lines.map((line, i) => {
    const eolCR = line.endsWith('\r');
    const body = eolCR ? line.slice(0, -1) : line;
    const code = C.stripComment(body);
    const tail = body.slice(code.length);
    const begin = /\\begin\{([^{}]*)\}/.exec(code);
    const end = /\\end\{([^{}]*)\}/.exec(code);
    let skip = verb !== null;
    if (verb === null && begin && VERB_ENV.test(begin[1]) && !(end && end[1] === begin[1])) { verb = begin[1]; skip = true; }
    else if (verb !== null && end && end[1] === verb) verb = null;
    if (skip) return line;
    // \verb|...| and \lstinline|...| are kept
    const keep = [];
    const masked = code.replace(/\\(?:verb|lstinline)\*?(.)(.*?)\1/g, (all) => { keep.push(all); return '\u0000' + (keep.length - 1) + '\u0000'; });
    const neu = masked.replace(re, (...a) => {
      const m0 = a[0];
      if (m0 === '') return m0;
      const named = typeof a[a.length - 1] === 'object';
      const offAt = a.length - (named ? 3 : 2);
      const off = a[offAt];
      const groups = a.slice(1, offAt);
      out.count++;
      out.hits.push({ line: i, col: off, len: m0.length, before: m0 });
      if (!o.regex) return String(repl);
      return String(repl).replace(/\$(\$|&|\d)/g, (t, c) => (c === '$' ? '$' : c === '&' ? m0 : groups[+c - 1] === undefined ? '' : groups[+c - 1]));
    }).replace(/\u0000(\d+)\u0000/g, (s, k) => keep[+k]);
    return neu + tail + (eolCR ? '\r' : '');
  });
  out.text = res.join('\n');
  return out;
}

/* ------------------------- notation consistency --------------------------- */
// groups of notations that should not be mixed; to turn a match of one variant into another, `make` (with $1 = the payload)
const NOTATION_DEFAULT = [
  { name: 'ε: \\varepsilon / \\epsilon', variants: [
    { label: '\\varepsilon', pattern: '\\\\varepsilon(?![A-Za-z@])', make: '\\varepsilon' },
    { label: '\\epsilon', pattern: '\\\\epsilon(?![A-Za-z@])', make: '\\epsilon' }] },
  { name: 'φ: \\varphi / \\phi', variants: [
    { label: '\\varphi', pattern: '\\\\varphi(?![A-Za-z@])', make: '\\varphi' },
    { label: '\\phi', pattern: '\\\\phi(?![A-Za-z@])', make: '\\phi' }] },
  { name: '≤: \\leqslant / \\leq / \\le', variants: [
    { label: '\\leqslant', pattern: '\\\\leqslant(?![A-Za-z@])', make: '\\leqslant' },
    { label: '\\leq', pattern: '\\\\leq(?![A-Za-z@])', make: '\\leq' },
    { label: '\\le', pattern: '\\\\le(?![A-Za-z@])', make: '\\le' }] },
  { name: '≥: \\geqslant / \\geq / \\ge', variants: [
    { label: '\\geqslant', pattern: '\\\\geqslant(?![A-Za-z@])', make: '\\geqslant' },
    { label: '\\geq', pattern: '\\\\geq(?![A-Za-z@])', make: '\\geq' },
    { label: '\\ge', pattern: '\\\\ge(?![A-Za-z@])', make: '\\ge' }] },
  { name: 'диференціал: \\mathrm{d} / \\mathrm d', variants: [
    { label: '\\mathrm{d}', pattern: '\\\\mathrm\\{d\\}', make: '\\mathrm{d}' },
    { label: '\\mathrm d', pattern: '\\\\mathrm d(?![A-Za-z@])', make: '\\mathrm d' }] },
  { name: 'одиниці в формулах: \\mathrm{..} / \\text{..}', variants: [
    { label: '\\mathrm{одиниця}', pattern: '\\\\mathrm\\{([А-Яа-яЁёІіЇїЄєҐґ]+)\\}', make: '\\mathrm{$1}' },
    { label: '\\text{одиниця}', pattern: '\\\\text\\{([А-Яа-яЁёІіЇїЄєҐґ]+)\\}', make: '\\text{$1}' }] }
];

// files: [{ path, text }]; groups as NOTATION_DEFAULT. -> [{ name, variants: [{ label, count, perFile: Map }], mixed, group }]
function notationReport(files, groups) {
  const out = [];
  for (const g of groups || NOTATION_DEFAULT) {
    if (!g || !Array.isArray(g.variants) || g.variants.length < 2) continue;
    const vs = [];
    for (const v of g.variants) {
      try { new RegExp(v.pattern); } catch (e) { continue; }
      const perFile = new Map();
      let count = 0;
      for (const f of files) {
        const r = replaceInText(f.text, v.pattern, '', { regex: true });
        if (r.count) { perFile.set(f.path, r.count); count += r.count; }
      }
      vs.push({ label: v.label, count, perFile, variant: v });
    }
    out.push({ name: g.name, variants: vs, mixed: vs.filter((v) => v.count > 0).length > 1, group: g });
  }
  return out;
}

function formatNotationReport(rep, o) {
  const lines = ['# Узгодженість позначень' + (o && o.folder ? ' · ' + o.folder : ''), ''];
  const mixed = rep.filter((r) => r.mixed);
  lines.push(mixed.length ? 'Змішано у ' + mixed.length + ' з ' + rep.length + ' груп.' : '✅ Змішаних позначень немає.');
  lines.push('');
  for (const r of rep) {
    lines.push('## ' + (r.mixed ? '⚠️ ' : '✅ ') + r.name);
    for (const v of r.variants) {
      const files = [...v.perFile].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => f + ' (' + n + ')').join(', ');
      lines.push('- `' + v.label + '`: ' + v.count + (files ? ' — ' + files + (v.perFile.size > 5 ? ', …' : '') : ''));
    }
    lines.push('');
  }
  return lines.join('\n');
}

// all variants of the group except `target` turned into `target`, in every file -> { changes: Map, count }
function notationUnify(files, group, targetLabel) {
  const target = group.variants.find((v) => v.label === targetLabel);
  const changes = new Map();
  let count = 0;
  if (!target) return { changes, count };
  for (const f of files) {
    let text = f.text;
    for (const v of group.variants) {
      if (v === target) continue;
      const r = replaceInText(text, v.pattern, target.make, { regex: true });
      text = r.text;
      count += r.count;
    }
    if (text !== f.text) changes.set(f.path, text);
  }
  return { changes, count };
}

/* ------------------------------ .bib entries ------------------------------- */
// Reads the field value starting at text[i] (after `=`): {..} with nested braces, "..", or a bare word/number. -> { value, end }
function readBibValue(text, i) {
  while (/\s/.test(text[i] || '')) i++;
  const c = text[i];
  if (c === '{') {
    let depth = 0;
    for (let k = i; k < text.length; k++) {
      if (text[k] === '\\') { k++; continue; }
      if (text[k] === '{') depth++;
      else if (text[k] === '}' && --depth === 0) return { value: text.slice(i + 1, k), end: k + 1 };
    }
    return { value: text.slice(i + 1), end: text.length };
  }
  if (c === '"') {
    for (let k = i + 1; k < text.length; k++) {
      if (text[k] === '\\') { k++; continue; }
      if (text[k] === '"') return { value: text.slice(i + 1, k), end: k + 1 };
    }
    return { value: text.slice(i + 1), end: text.length };
  }
  const m = /^[^,\s}]*/.exec(text.slice(i));
  return { value: m[0], end: i + m[0].length };
}

const cleanBib = (s) => String(s || '').replace(/\\[`'^"~=.]\{?(\w)\}?/g, '$1').replace(/[{}]/g, '').replace(/\\&/g, '&').replace(/\s+/g, ' ').trim();

// [{ key, type, author, year, title, journal, line }] (@comment, @string, @preamble skipped)
function parseBibEntries(text) {
  const out = [];
  const re = /^[ \t]*@([A-Za-z]+)[ \t]*[{(][ \t]*([^,\s{}()]+)[ \t]*,/gm;
  let m;
  while ((m = re.exec(text))) {
    if (/^(?:comment|string|preamble)$/i.test(m[1])) continue;
    const e = { key: m[2], type: m[1].toLowerCase(), author: '', year: '', title: '', journal: '', line: text.slice(0, m.index).split('\n').length - 1 };
    let i = m.index + m[0].length;
    for (;;) {
      const f = /\s*([A-Za-z][A-Za-z0-9_-]*)\s*=/y;
      f.lastIndex = i;
      const fm = f.exec(text);
      if (!fm) break;
      const v = readBibValue(text, f.lastIndex);
      const name = fm[1].toLowerCase();
      const val = cleanBib(v.value);
      if (name === 'author' || name === 'editor') { if (!e.author || name === 'author') e.author = val; }
      else if (name === 'year') e.year = val;
      else if (name === 'date' && !e.year) e.year = (/\d{4}/.exec(val) || [''])[0];
      else if (name === 'title') e.title = val;
      else if (name === 'journal' || name === 'journaltitle' || name === 'booktitle') e.journal = e.journal || val;
      i = v.end;
      const sep = /\s*,/y;
      sep.lastIndex = i;
      if (sep.exec(text)) i = sep.lastIndex; else break;
    }
    out.push(e);
  }
  return out;
}

// "Landau, L. D. and Lifshitz, E. M." -> "Landau, Lifshitz"; more than two authors -> "Landau et al."
function shortAuthors(author) {
  const names = String(author || '').split(/\s+and\s+/i).map((a) => (a.includes(',') ? a.split(',')[0] : a.trim().split(/\s+/).slice(-1)[0]).trim()).filter(Boolean);
  if (!names.length) return '';
  if (names.length > 2) return names[0] + ' et al.';
  return names.join(', ');
}

const CITE_CTX = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/;

/* ------------------------------- problems tree ----------------------------- */
// diags: [{ file, line, severity: 'error'|'warning'|'information'|'hint', message, source }]
// -> [{ id, label, items: [{ file, line, message, source }] }] groups in a fixed order, files sorted
function groupProblems(diags) {
  const isBox = (d) => /^(Over|Under)full /i.test(d.message);
  const groups = [
    { id: 'error', label: 'Помилки', items: [] },
    { id: 'warning', label: 'Попередження', items: [] },
    { id: 'box', label: 'Overfull / underfull', items: [] },
    { id: 'other', label: 'Підказки й нотатки', items: [] }
  ];
  for (const d of diags) {
    const g = isBox(d) ? 'box' : d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'other';
    groups.find((x) => x.id === g).items.push(d);
  }
  for (const g of groups) g.items.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return groups.filter((g) => g.items.length);
}

/* --------------------------------- snapshots ------------------------------- */
const pad = (n) => String(n).padStart(2, '0');
function snapshotId(date, label) {
  const d = date;
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const slug = String(label || '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return stamp + (slug ? '-' + slug : '');
}
// the ids to delete so that only the `keep` newest remain (ids sort by time)
function snapshotsToPrune(ids, keep) {
  const s = ids.slice().sort();
  return s.length > keep ? s.slice(0, s.length - keep) : [];
}

module.exports = {
  validChapterName, chapterItems, moveChapter, renameInMain, renameChapterTexts, filterMainForParts,
  replaceInText, NOTATION_DEFAULT, notationReport, formatNotationReport, notationUnify,
  parseBibEntries, shortAuthors, CITE_CTX, groupProblems, snapshotId, snapshotsToPrune
};
