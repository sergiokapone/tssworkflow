'use strict';
/* wrapCmdPure.js: logic of "Wrap selection in command" (no vscode dependency).
 *   STANDARD_CMDS             built-in catalogue { name, pre?, post?, desc }
 *   parseCmdInput(text)       'textcolor{red}' -> { name, pre, open, close, post }; null if it is not a command
 *   partsOfMacro(entry)       the wrap spec of a command from .cls/.sty (the selection goes in its first mandatory argument)
 *   wrapInline(text, spec)    '\name' + pre + open + text + close + post, with the caret offset
 * The wrapped text is the content of one argument: \name<pre>{text}<post>. `{}` / `[]` in pre and post are the places
 * where the caret stops (the first one; with none, right after the wrapped text). */

const MP = require('./macrosPure');

const STANDARD_CMDS = [
  // text
  { name: 'emph', desc: 'Виділення (курсив)' },
  { name: 'textbf', desc: 'Напівжирний' },
  { name: 'textit', desc: 'Курсив' },
  { name: 'textsc', desc: 'Капітель' },
  { name: 'texttt', desc: 'Моноширинний' },
  { name: 'textrm', desc: 'Прямий шрифт' },
  { name: 'underline', desc: 'Підкреслення' },
  { name: 'mbox', desc: 'Без розриву рядка' },
  { name: 'footnote', desc: 'Виноска' },
  { name: 'textsuperscript', desc: 'Верхній індекс у тексті' },
  { name: 'textsubscript', desc: 'Нижній індекс у тексті' },
  { name: 'textcolor', pre: '{}', desc: 'Колір тексту (xcolor)' },
  { name: 'colorbox', pre: '{}', desc: 'Фон тексту (xcolor)' },
  { name: 'href', pre: '{}', desc: 'Гіперпосилання (hyperref): у дужках адреса' },
  { name: 'ce', desc: 'Хімічна формула (mhchem)' },
  // formulas
  { name: 'mathrm', desc: 'Прямий шрифт у формулі' },
  { name: 'mathbf', desc: 'Напівжирний у формулі' },
  { name: 'mathit', desc: 'Курсив у формулі' },
  { name: 'mathcal', desc: 'Каліграфічний шрифт' },
  { name: 'mathbb', desc: 'Ажурний шрифт (amssymb)' },
  { name: 'boldsymbol', desc: 'Напівжирний символ (amsmath)' },
  { name: 'text', desc: 'Текст у формулі (amsmath)' },
  { name: 'operatorname', desc: 'Ім\'я оператора (amsmath)' },
  { name: 'boxed', desc: 'Формула в рамці (amsmath)' },
  { name: 'ensuremath', desc: 'Математичний режим усюди' },
  { name: 'overline', desc: 'Риска зверху' },
  { name: 'underbrace', post: '_{}', desc: 'Дужка знизу з підписом' },
  { name: 'vec', desc: 'Стрілка вектора' },
  { name: 'hat', desc: 'Циркумфлекс' },
  { name: 'bar', desc: 'Риска' },
  { name: 'tilde', desc: 'Тильда' },
  { name: 'dot', desc: 'Крапка (похідна за часом)' },
  { name: 'ddot', desc: 'Дві крапки' },
  { name: 'sqrt', desc: 'Квадратний корінь' },
  { name: 'frac', post: '{}', desc: 'Дріб: виділене стає чисельником' },
  // references
  { name: 'label', desc: 'Мітка (виділене стає ключем)' },
  { name: 'ref', desc: 'Посилання' },
  { name: 'eqref', desc: 'Посилання на формулу (amsmath)' },
  { name: 'cite', desc: 'Цитування' }
];

/* The menu "Format" (like the one of a word processor): the commands most often put round a selection.
 * quick: the position of the button shown above a selection (1, 2, 3). */
const FORMAT_MENU = [
  { name: 'textbf', label: 'Напівжирний', group: 'Текст', quick: 1 },
  { name: 'textit', label: 'Курсив', group: 'Текст', quick: 2 },
  { name: 'emph', label: 'Виділення (emph)', group: 'Текст' },
  { name: 'underline', label: 'Підкреслення', group: 'Текст', quick: 3 },
  { name: 'texttt', label: 'Моноширинний', group: 'Текст' },
  { name: 'textsc', label: 'Капітель', group: 'Текст' },
  { name: 'footnote', label: 'Виноска', group: 'Текст' },
  { name: 'mathrm', label: 'Прямий шрифт', group: 'Формула' },
  { name: 'mathbf', label: 'Напівжирний', group: 'Формула' },
  { name: 'boldsymbol', label: 'Напівжирний символ', group: 'Формула' },
  { name: 'mathcal', label: 'Каліграфічний', group: 'Формула' },
  { name: 'mathbb', label: 'Ажурний', group: 'Формула' },
  { name: 'text', label: 'Текст у формулі', group: 'Формула' },
  { name: 'vec', label: 'Вектор (стрілка)', group: 'Формула' },
  { name: 'overline', label: 'Риска зверху', group: 'Формула' }
];
const formatSpec = (name) => { const f = FORMAT_MENU.find((x) => x.name === name); return f ? { name: f.name, pre: '', open: '{', close: '}', post: '' } : null; };

const NAME_RE = /^[A-Za-z@]+\*?/;
const FIELD_RE = /\{\}|\[\]/;

/* 'emph', '\textcolor{red}', 'href[opt]{url}' -> { name, pre, open, close, post }.
 * What follows the name (it has to start with [ or {) stands before the wrapped argument. */
function parseCmdInput(text) {
  let s = String(text || '').trim();
  if (s[0] === '\\') s = s.slice(1);
  const m = NAME_RE.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length).trim();
  if (rest && rest[0] !== '[' && rest[0] !== '{') return null;
  return { name: m[0], pre: rest, open: '{', close: '}', post: '' };
}

/* A command from .cls/.sty (\newcommand, \NewDocumentCommand, \def): the selection goes in the first mandatory
 * argument, every later mandatory one stays as an empty {}. Commands without a mandatory argument give null. */
function partsOfMacro(e) {
  if (!e || e.kind === 'env' || !e.tokens || !e.tokens.length) return null;
  const m = MP.mandatoryTokens(e).map((x) => x.t);
  if (!m.length) return null;
  return {
    name: e.name, pre: '', open: m[0].open || '{', close: m[0].close || '}',
    post: m.slice(1).map((t) => (t.open || '{') + (t.close || '}')).join('')
  };
}

const fill = (spec) => Object.assign({ pre: '', post: '', open: '{', close: '}' }, spec);

/* The wrapped text and the caret: { text, cursor } with cursor an offset in `text`. */
function wrapInline(selected, spec) {
  const o = fill(spec);
  const head = '\\' + o.name + o.pre;
  const mid = o.open + selected + o.close;
  const text = head + mid + o.post;
  let k = head.search(FIELD_RE);
  if (k >= 0) return { text, cursor: k + 1 };
  k = o.post.search(FIELD_RE);
  if (k >= 0) return { text, cursor: head.length + mid.length + k + 1 };
  return { text, cursor: text.length };
}

module.exports = { STANDARD_CMDS, FORMAT_MENU, formatSpec, parseCmdInput, partsOfMacro, wrapInline, fill };
