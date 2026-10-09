'use strict';
/* wrapEnvPure.js: logic of "Wrap selection in environment" (no vscode dependency).
 *   STANDARD_ENVS            built-in catalogue { name, rest, desc }
 *   parseEnvInput(text)      'minipage{0.5\\linewidth}' -> { name, rest }; null if it is not an environment
 *   argsOfMacro(entry)       '{}{}' for the mandatory arguments of an environment from .cls/.sty
 *   envNamesInText(text)     names used in \begin{...} (comments skipped, 'document' ignored)
 *   countEnvs(text)          the same with the number of uses: Map name -> count
 *   labelFor(name, prefixes, body)  { prefix, where } of the \label to add, from tssworkflow.labelPrefixes
 *   wrapLines(lines, start, end, opts)  the text edit that wraps the range in \begin ... \end */

const MP = require('./macrosPure');

// rest = what stands after \begin{name}; `{}` / `[]` inside it is where the caret stops
const STANDARD_ENVS = [
  // formulas
  { name: 'equation', rest: '', desc: 'Формула з номером' },
  { name: 'equation*', rest: '', desc: 'Формула без номера' },
  { name: 'align', rest: '', desc: 'Кілька формул, вирівнювання по &' },
  { name: 'align*', rest: '', desc: 'Те саме без номерів' },
  { name: 'gather', rest: '', desc: 'Кілька формул по центру' },
  { name: 'gather*', rest: '', desc: 'Те саме без номерів' },
  { name: 'multline', rest: '', desc: 'Довга формула в кілька рядків' },
  { name: 'multline*', rest: '', desc: 'Те саме без номера' },
  { name: 'split', rest: '', desc: 'Розбиття однієї формули (усередині equation)' },
  { name: 'aligned', rest: '', desc: 'Вирівняний блок усередині формули' },
  { name: 'cases', rest: '', desc: 'Система з фігурною дужкою (amsmath)' },
  { name: 'subequations', rest: '', desc: 'Група формул (1a), (1b)' },
  { name: 'pmatrix', rest: '', desc: 'Матриця в круглих дужках' },
  { name: 'bmatrix', rest: '', desc: 'Матриця в квадратних дужках' },
  // lists
  { name: 'itemize', rest: '', desc: 'Маркований список' },
  { name: 'enumerate', rest: '', desc: 'Нумерований список' },
  { name: 'description', rest: '', desc: 'Список з термінами' },
  // floats
  { name: 'figure', rest: '[h!]', desc: 'Рисунок (плаваючий)' },
  { name: 'figure*', rest: '[h!]', desc: 'Рисунок на всю ширину' },
  { name: 'table', rest: '[h!]', desc: 'Таблиця (плаваюча)' },
  // text blocks
  { name: 'center', rest: '', desc: 'Вирівняти по центру' },
  { name: 'flushleft', rest: '', desc: 'Вирівняти ліворуч' },
  { name: 'flushright', rest: '', desc: 'Вирівняти праворуч' },
  { name: 'quote', rest: '', desc: 'Цитата' },
  { name: 'quotation', rest: '', desc: 'Цитата з абзацами' },
  { name: 'abstract', rest: '', desc: 'Анотація' },
  { name: 'minipage', rest: '{0.48\\linewidth}', desc: 'Вузька колонка в тексті' },
  { name: 'multicols', rest: '{2}', desc: 'Колонки (multicol)' },
  { name: 'verbatim', rest: '', desc: 'Текст «як є»' },
  { name: 'lstlisting', rest: '', desc: 'Лістинг коду (listings)' },
  { name: 'sloppypar', rest: '', desc: 'Дозволити розтягнуті пробіли' },
  { name: 'small', rest: '', desc: 'Дрібніший шрифт' },
  { name: 'footnotesize', rest: '', desc: 'Ще дрібніший шрифт' },
  // theorem-like (amsthm; the project's own ones come from .cls/.sty)
  { name: 'proof', rest: '', desc: 'Доведення (amsthm)' },
  { name: 'theorem', rest: '', desc: 'Теорема (якщо визначена)' },
  { name: 'lemma', rest: '', desc: 'Лема (якщо визначена)' },
  { name: 'definition', rest: '', desc: 'Означення (якщо визначене)' },
  { name: 'remark', rest: '', desc: 'Зауваження (якщо визначене)' },
  // tables and graphics
  { name: 'tabular', rest: '{}', desc: 'Таблиця; у дужках специфікація стовпців' },
  { name: 'tabularx', rest: '{\\linewidth}{}', desc: 'Таблиця заданої ширини (tabularx)' },
  { name: 'tblr', rest: '{}', desc: 'Таблиця tabularray' },
  { name: 'tikzpicture', rest: '', desc: 'Малюнок TikZ' },
  { name: 'circuitikz', rest: '', desc: 'Електрична схема (circuitikz)' },
  { name: 'axis', rest: '', desc: 'Графік pgfplots' },
  // beamer
  { name: 'frame', rest: '{}', desc: 'Слайд beamer; у дужках заголовок' },
  { name: 'columns', rest: '', desc: 'Колонки на слайді (beamer)' },
  { name: 'column', rest: '{0.5\\textwidth}', desc: 'Колонка на слайді (beamer)' },
  { name: 'block', rest: '{}', desc: 'Блок із заголовком (beamer)' },
  { name: 'alertblock', rest: '{}', desc: 'Червоний блок (beamer)' },
  { name: 'exampleblock', rest: '{}', desc: 'Зелений блок (beamer)' }
];

// the text inside these is taken literally: no extra indentation
const NO_INDENT = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'comment', 'alltt']);

const NAME_RE = /^[A-Za-z@][A-Za-z0-9@-]*\*?/;

/* 'center', 'figure[h!]', 'minipage{0.5\linewidth}', '\begin{tabular}{ll}' -> { name, rest } or null.
 * `rest` has to start with [ or {: that is how arguments of an environment are written. */
function parseEnvInput(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  const b = /^\\begin\s*\{([^}\s]+)\}/.exec(s);
  let name;
  if (b) {
    name = b[1];
    s = s.slice(b[0].length).trim();
  } else {
    const m = NAME_RE.exec(s);
    if (!m) return null;
    name = m[0];
    s = s.slice(name.length).trim();
  }
  if (!NAME_RE.test(name) || NAME_RE.exec(name)[0] !== name) return null;
  if (s && s[0] !== '[' && s[0] !== '{') return null;
  return { name, rest: s };
}

// `{}` for every mandatory argument of an environment defined in a .cls/.sty (\newenvironment[2]{...}, xparse spec, tcolorbox)
function argsOfMacro(e) {
  if (!e || !e.tokens || !e.tokens.length) return '';
  return MP.mandatoryTokens(e).map(({ t }) => (t.open || '{') + (t.close || '}')).join('');
}

function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

// Map name -> number of \begin{name} in the text, in order of first use (comments skipped, 'document' ignored)
function countEnvs(text) {
  const out = new Map();
  const re = /\\begin\{([A-Za-z@][A-Za-z0-9@-]*\*?)\}/g;
  for (const line of String(text).split(/\r?\n/)) {
    const code = stripComment(line);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(code))) {
      if (m[1] !== 'document') out.set(m[1], (out.get(m[1]) || 0) + 1);
    }
  }
  return out;
}

// names from \begin{...} in the text, in order of first use
const envNamesInText = (text) => [...countEnvs(text).keys()];

// floats take the label after the caption (end of the body), other environments right after \begin
const FLOAT_ENVS = new Set(['figure', 'table', 'wrapfigure', 'wraptable', 'SCfigure', 'sidewaysfigure', 'sidewaystable']);

/* The \label to add when wrapping: `prefixes` is tssworkflow.labelPrefixes (environment -> 'pic:');
 * nothing when the environment has no prefix or the wrapped text already has a \label. */
function labelFor(name, prefixes, bodyText) {
  const base = name.replace(/\*$/, '');
  const prefix = prefixes && typeof prefixes === 'object' ? prefixes[base] : '';
  if (!prefix || typeof prefix !== 'string') return null;
  if (/\\label\s*\{/.test(String(bodyText || ''))) return null;
  return { prefix, where: FLOAT_ENVS.has(base) ? 'end' : 'start' };
}

const leadingWs = (s) => /^[ \t]*/.exec(s)[0];

/* The edit that wraps the range [start, end] (0-based line / character) in \begin{name}rest ... \end{name}.
 *   lines  the document lines (without line breaks)
 *   opts   { name, rest, unit, indent, label }  unit = one indentation step, indent = indent the body,
 *          label = { prefix, where: 'start' | 'end' } adds a \label{prefix} line (see labelFor)
 * Whole lines are replaced: a selection that starts or ends in the middle of a line text splits that line, so
 * \begin and \end always stand on lines of their own, with the indentation of the first selected line.
 * A range that ends at column 0 of a line does not include that line (what a line selection in VS Code does).
 * Returns { startLine, endLine, lines, cursor: { line, character } }: replace lines startLine..endLine with `lines`;
 * `cursor` is inside the added \label{...}, else inside the first empty {} / [] of the \begin line, else at its end. */
function wrapLines(lines, start, end, opts) {
  const s = { line: start.line, character: start.character };
  const e = { line: end.line, character: end.character };
  if (e.line > s.line && e.character === 0) { e.line--; e.character = lines[e.line].length; }
  const sText = lines[s.line];
  const eText = lines[e.line];
  const before = sText.slice(0, s.character);
  const after = eText.slice(e.character);
  const splitBefore = before.trim() !== '';
  const splitAfter = after.trim() !== '';
  const baseIndent = leadingWs(sText);
  const name = opts.name;
  const rest = opts.rest || '';
  const unit = opts.unit === undefined ? '\t' : opts.unit;
  const indentBody = opts.indent !== false && !NO_INDENT.has(name.replace(/\*$/, ''));

  const body = [];
  for (let l = s.line; l <= e.line; l++) {
    const t = lines[l];
    const from = l === s.line && splitBefore ? s.character : 0;
    const to = l === e.line && splitAfter ? e.character : t.length;
    let piece = t.slice(from, to);
    if (l === s.line && splitBefore) piece = (indentBody ? baseIndent : '') + piece.trimStart();
    if (l === e.line && splitAfter) piece = piece.replace(/[ \t]+$/, '');
    body.push(piece.trim() === '' || !indentBody ? piece : unit + piece);
  }

  const beginLine = baseIndent + '\\begin{' + name + '}' + rest;
  const out = [];
  if (splitBefore) out.push(before.replace(/[ \t]+$/, ''));
  const beginIdx = out.length;
  const lab = opts.label ? baseIndent + (indentBody ? unit : '') + '\\label{' + opts.label.prefix + '}' : null;
  out.push(beginLine);
  let labelIdx = -1;
  if (lab && opts.label.where !== 'end') { labelIdx = out.length; out.push(lab); }
  out.push(...body);
  if (lab && opts.label.where === 'end') { labelIdx = out.length; out.push(lab); }
  out.push(baseIndent + '\\end{' + name + '}');
  if (splitAfter) out.push(baseIndent + after.trimStart());

  if (labelIdx >= 0) return { startLine: s.line, endLine: e.line, lines: out, cursor: { line: s.line + labelIdx, character: lab.length - 1 } };
  const k = rest.search(/\{\}|\[\]/);
  const character = k >= 0 ? baseIndent.length + '\\begin{'.length + name.length + 1 + k + 1 : beginLine.length;
  return { startLine: s.line, endLine: e.line, lines: out, cursor: { line: s.line + beginIdx, character } };
}

// does any wrapLines result overlap the next one? (several selections on the same line)
function overlaps(edits) {
  const a = edits.slice().sort((x, y) => x.startLine - y.startLine);
  for (let i = 1; i < a.length; i++) if (a[i].startLine <= a[i - 1].endLine) return true;
  return false;
}

module.exports = { STANDARD_ENVS, NO_INDENT, FLOAT_ENVS, parseEnvInput, argsOfMacro, envNamesInText, countEnvs, labelFor, wrapLines, overlaps };
