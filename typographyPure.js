'use strict';
/* typographyPure.js: typography rules and sentence splitting. No vscode. */
const { codeRanges, hasComment, lineKind, unwrapLines } = require('./texBasePure');

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

module.exports = {
  sentenceLines,
  splitSentences,
  typography,
};
