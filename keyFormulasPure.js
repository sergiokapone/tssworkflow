'use strict';
/* keyFormulasPure.js: key formulas for the chapter summary (no vscode dependency).
 * A formula is marked with a comment  %! key  or  %! key: a short name  on the line right above \begin{equation} (a comment-only
 * line), or at the end of the \begin line, or on any line inside the formula. Then
 *   keyFormulas(lines)            the marked formulas of one file: { line, endLine, env, starred, labels, title, body }
 *   draftSummary(files, o)        a draft of the "Підсумки" section(s) (files: [{ path, text }] in the order of the book)
 *   toggleKey(lines, cursorLine)  the edit that sets or removes the mark of the formula under the cursor */
const X = require('./filesAndLabelsPure');
const C = require('./chaptersPure');
const { codePart } = require('./corePure');

// the text of an unescaped % comment of a line ('' when there is none)
function commentOf(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '%') return line.slice(i + 1);
  }
  return '';
}
const KEY_RE = /^!\s*key\b\s*:?\s*(.*?)\s*$/;
const keyOf = (line) => { const m = KEY_RE.exec(commentOf(line)); return m ? { title: m[1] } : null; };

// the formula that holds the line (begin..end), or the nearest one that starts below a comment-only line
function eqLines(eq) { const a = []; for (let i = eq.line; i <= eq.endLine; i++) a.push(i); return a; }

function markOf(lines, eq) {
  const above = eq.line - 1;
  if (above >= 0 && !codePart(lines[above]).trim()) { const k = keyOf(lines[above]); if (k) return { at: above, own: true, title: k.title }; }
  for (const i of eqLines(eq)) { const k = keyOf(lines[i]); if (k) return { at: i, own: false, title: k.title }; }
  return null;
}

// the content of the environment without \label, \nonumber and \notag, dedented
function bodyOf(lines, eq) {
  const code = lines.slice(eq.line, eq.endLine + 1).map(codePart).join('\n');
  const b = new RegExp('\\\\begin\\{' + eq.env + '\\*?\\}').exec(code);
  const e = new RegExp('\\\\end\\{' + eq.env + '\\*?\\}').exec(code);
  let s = code.slice(b ? b.index + b[0].length : 0, e ? e.index : code.length);
  s = s.replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(?:nonumber|notag)\b/g, '');
  const rows = s.split('\n').map((r) => r.replace(/\s+$/, ''));
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  const ind = Math.min.apply(null, rows.filter((r) => r.trim()).map((r) => /^[ \t]*/.exec(r)[0].length).concat([1e9]));
  return rows.map((r) => r.slice(Math.min(ind, r.length) || 0));
}

function keyFormulas(lines) {
  const out = [];
  for (const q of X.scanEquations(lines)) {
    if (q.env === 'displaymath') continue;
    const m = markOf(lines, q);
    if (!m) continue;
    out.push({ line: q.line + 1, endLine: q.endLine + 1, env: q.env, starred: q.starred, labels: q.labels, title: m.title, body: bodyOf(lines, q) });
  }
  return out;
}

// the lines of one formula as a display for the summary: equation -> \[ ... \], others -> the starred environment
function displayOf(k, pad) {
  const body = k.body.map((r) => (r.trim() ? pad + '  ' + r : ''));
  if (k.env === 'equation') return [pad + '\\['].concat(body, [pad + '\\]']);
  return [pad + '\\begin{' + k.env + '*}'].concat(body, [pad + '\\end{' + k.env + '*}']);
}

// one block per file with key formulas: the section and an itemize with the formulas. o: { heading }
function draftSummary(files, o) {
  const heading = (o && o.heading) || 'Підсумки';
  const blocks = [];
  let count = 0;
  for (const f of files) {
    const ks = keyFormulas(String(f.text).split(/\r?\n/));
    if (!ks.length) continue;
    count += ks.length;
    const title = C.chapterTitle(f.text);
    const out = ['% ── ' + (title ? title + ' (' + f.path + ')' : f.path) + ' ──',
      '\\section*{' + heading + '}', '\\addcontentsline{toc}{section}{' + heading + '}', '', '\\begin{itemize}'];
    for (const k of ks) {
      const ref = k.labels.length ? '(\\eqref{' + k.labels[0] + '})' : '';
      const head = k.title ? k.title + (ref ? ' ' + ref : '') : (ref ? ref + ' ' : '') + '% TODO: що ця формула означає';
      out.push('  \\item ' + head.trim(), ...displayOf(k, '  '));
    }
    out.push('\\end{itemize}');
    blocks.push(out.join('\n'));
  }
  return { text: blocks.length ? blocks.join('\n\n') + '\n' : '', count, files: blocks.length };
}

// the edit that switches the mark of the formula under the line (0-based). null when the line is in no formula.
// { type: 'insert', line, text } | { type: 'delete', line } | { type: 'replace', line, text }; marked: the state after the edit
function toggleKey(lines, cursorLine) {
  const eqs = X.scanEquations(lines).filter((q) => q.env !== 'displaymath');
  const q = eqs.find((e) => cursorLine >= e.line && cursorLine <= e.endLine);
  if (!q) return null;
  const m = markOf(lines, q);
  if (m && m.own) return { type: 'delete', line: m.at, marked: false };
  if (m) {
    // a trailing comment: cut only the mark (the rest of the line stays)
    const l = lines[m.at];
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '\\') { i++; continue; }
      if (l[i] === '%') return { type: 'replace', line: m.at, text: l.slice(0, i).replace(/\s+$/, ''), marked: false };
    }
  }
  const indent = /^[ \t]*/.exec(lines[q.line])[0];
  return { type: 'insert', line: q.line, text: indent + '%! key', marked: true };
}

module.exports = { keyFormulas, draftSummary, toggleKey, keyOf };
