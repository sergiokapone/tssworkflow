'use strict';
/* formulaOverviewPure.js: the data of the panel "Formulas of the project" (no vscode dependency).
 *   refsOf(text)           the labels a text refers to (\ref, \eqref, \cref, \autoref ... with a list of labels)
 *   buildEntries(files, o) every formula of the files (in the given order) as { f, line, env, labels, num, approx, numbered,
 *                          noLabel, unused, text, html }: the number from the last compilation (main.aux; ~ is an estimate from
 *                          the nearest labelled formula), the labels, whether anybody refers to them */
const X = require('./filesAndLabelsPure');

const REF_RE = /\\(?:[A-Za-z]*ref|labelcref|labelcpageref)\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;

function refsOf(text) {
  const out = new Set();
  const t = String(text).split(/\r?\n/).map((l) => { for (let k = 0; k < l.length; k++) { if (l[k] === '\\') { k++; continue; } if (l[k] === '%') return l.slice(0, k); } return l; }).join('\n');
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(t))) for (const n of m[1].split(',')) if (n.trim()) out.add(n.trim());
  return out;
}

// files: [{ path, abs, text }]; o: { aux(file, name) -> number text | null, used: Set of labels, render(source) -> HTML, limit }
function buildEntries(files, o) {
  const out = [];
  const limit = o.limit || 5000;
  files.forEach((f, fi) => {
    const lines = f.text.split(/\r?\n/);
    const all = X.scanEquations(lines).filter((q) => q.env !== 'displaymath');
    const numbered = all.filter((q) => !q.starred);
    const nums = X.eqNumbers(numbered, (name) => { const a = o.aux ? o.aux(f.abs, name) : null; return a ? String(a) : null; });
    const numOf = new Map(numbered.map((q, i) => [q, nums[i]]));
    for (const q of all) {
      if (out.length >= limit) return;
      const n = numOf.get(q);
      const isNum = !q.starred && n && !n.none;
      const numTxt = isNum && n.start ? (n.approx ? '~' : '') + (n.start === n.end ? n.start : n.start + '–' + n.end) : '';
      const text = lines.slice(q.line, q.endLine + 1).join('\n');
      out.push({
        f: fi, line: q.line + 1, endLine: q.endLine + 1, env: q.env + (q.starred ? '*' : ''), labels: q.labels, num: numTxt, numbered: !!isNum,
        noLabel: !q.labels.length, unused: !!isNum && !q.labels.some((l) => o.used.has(l)), snippet: q.snippet, html: o.render(text)
      });
    }
  });
  return out;
}

module.exports = { refsOf, buildEntries };
