'use strict';
/* formulaCopyPure.js: the formula under the caret or in the selection as TeX for KaTeX (no vscode dependency).
 *   formulaAt(text, offset)   { tex, display, start, end } | null : the smallest formula that contains the offset: $..$, \(..\), \[..\], $$..$$
 *                             or an environment (equation, align, gather ...); tex is what KaTeX takes (align -> aligned, \label removed)
 *   fromSelection(text)       the selected text as a formula: the delimiters or the environment around it are taken off
 *   mathmlOf(tex, display, katex, macros)  the <math> element of KaTeX as a string (a stand-alone MathML for Word and others) */
const P = require('./selectionPreviewPure');

const ENVS = [...P.MATH_ENVS].filter((n) => n !== 'split');

function candidates(text) {
  const out = [];
  const add = (start, end, tex, display) => out.push({ start, end, tex, display });
  const envRe = new RegExp('\\\\begin\\{(' + ENVS.map((n) => n.replace('*', '\\*')).join('|') + ')\\}', 'g');
  let m;
  while ((m = envRe.exec(text))) {
    const e = P.matchEnd(text, m.index + m[0].length, m[1]);
    if (!e) continue;
    add(m.index, e.after, P.cleanMath(P.mathEnv(m[1], text.slice(m.index + m[0].length, e.bodyEnd))), true);
    envRe.lastIndex = e.after;
  }
  const pair = (open, close, display) => {
    let i = 0;
    for (;;) {
      const a = text.indexOf(open, i);
      if (a < 0) break;
      const b = text.indexOf(close, a + open.length);
      if (b < 0) break;
      add(a, b + close.length, P.cleanMath(text.slice(a + open.length, b)), display);
      i = b + close.length;
    }
  };
  pair('\\[', '\\]', true);
  pair('\\(', '\\)', false);
  // $$ .. $$ before $ .. $ (an escaped \$ is not a delimiter)
  const dollars = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '%') { const nl = text.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (text[i] === '$') { if (text[i + 1] === '$') { dollars.push([i, 2]); i++; } else dollars.push([i, 1]); }
  }
  let k = 0;
  while (k + 1 < dollars.length) {
    const [a, la] = dollars[k];
    let j = k + 1;
    while (j < dollars.length && dollars[j][1] !== la) j++;
    if (j >= dollars.length) { k++; continue; }
    const [b, lb] = dollars[j];
    const inner = text.slice(a + la, b);
    if (la === 1 && /\n\s*\n/.test(inner)) { k++; continue; } // a paragraph break inside: not a formula
    add(a, b + lb, P.cleanMath(inner), la === 2);
    k = j + 1;
  }
  return out;
}

function formulaAt(text, offset) {
  let best = null;
  for (const c of candidates(String(text))) {
    if (offset < c.start || offset > c.end) continue;
    if (!best || c.end - c.start < best.end - best.start) best = c;
  }
  return best;
}

function fromSelection(sel) {
  const t = String(sel);
  const s = t.trim();
  if (!s) return null;
  const lead = t.indexOf(s);
  for (const c of candidates(t)) {
    if (c.start <= lead && c.end >= lead + s.length) return { tex: c.tex, display: c.display };
  }
  return { tex: P.cleanMath(s), display: /\n/.test(s) };
}

function mathmlOf(tex, display, katex, macros) {
  const html = katex.renderToString(String(tex), { displayMode: !!display, throwOnError: true, strict: 'ignore', output: 'mathml', trust: false, macros: macros || {} });
  const m = /<math[\s\S]*<\/math>/.exec(html);
  if (!m) throw new Error('KaTeX не повернув MathML');
  return m[0];
}

module.exports = { formulaAt, fromSelection, mathmlOf, candidates };
