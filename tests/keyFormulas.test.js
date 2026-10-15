'use strict';
// node tests/keyFormulas.test.js [path/to/extension]  - keyFormulasPure.js: the mark %! key, the draft of "Підсумки", toggleKey
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const K = require(path.join(ext, 'keyFormulasPure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const L = (s) => s.split('\n');

const TEXT = [
  '\\chapter{Заряди}', '',
  '%! key: Закон Кулона',
  '\\begin{equation}', '  F = k\\frac{q_1 q_2}{r^2} \\label{eq:c}', '\\end{equation}', '',
  '\\begin{align} %! key', '  a &= b \\\\', '  c &= d \\label{eq:d} \\nonumber', '\\end{align}',
  '\\begin{equation*}', '  x', '\\end{equation*}',
  '% %! key does not count in a longer comment? yes it is a comment but not the mark',
  '\\begin{gather*}', '  u', '\\end{gather*}'
].join('\n');

t('keyFormulas: above the begin, at the end of the begin line; unmarked ones are skipped', () => {
  const ks = K.keyFormulas(L(TEXT));
  assert.deepStrictEqual(ks.map((k) => [k.env, k.line, k.title]), [['equation', 4, 'Закон Кулона'], ['align', 8, '']]);
  assert.deepStrictEqual(ks[0].labels, ['eq:c']);
});
t('keyFormulas: a mark inside the formula; a mark separated by a blank line or code does not count', () => {
  assert.strictEqual(K.keyFormulas(L('\\begin{equation}\n  x %! key\n\\end{equation}')).length, 1);
  assert.strictEqual(K.keyFormulas(L('%! key\n\nx\n\\begin{equation}\n y\n\\end{equation}')).length, 0);
  assert.strictEqual(K.keyFormulas(L('text %! key\n\\begin{equation}\n y\n\\end{equation}')).length, 0);
  assert.strictEqual(K.keyFormulas(L('\\begin{equation}\n  x \\% key\n\\end{equation}')).length, 0);
});
t('keyFormulas: the body has no \\label, \\nonumber, is dedented', () => {
  const ks = K.keyFormulas(L(TEXT));
  assert.deepStrictEqual(ks[0].body, ['F = k\\frac{q_1 q_2}{r^2}']);
  assert.deepStrictEqual(ks[1].body, ['a &= b \\\\', 'c &= d']);
});
t('draftSummary: section, itemize, \\eqref, display forms, TODO for a formula without a title', () => {
  const r = K.draftSummary([{ path: 'Charges/Charges.tex', text: TEXT }, { path: 'B/B.tex', text: '\\chapter{Нічого}\n\\begin{equation}\n x\n\\end{equation}' }]);
  assert.strictEqual(r.count, 2); assert.strictEqual(r.files, 1);
  const s = r.text;
  assert.ok(s.includes('% ── Заряди (Charges/Charges.tex) ──'));
  assert.ok(s.includes('\\section*{Підсумки}\n\\addcontentsline{toc}{section}{Підсумки}'));
  assert.ok(s.includes('  \\item Закон Кулона (\\eqref{eq:c})\n  \\[\n    F = k\\frac{q_1 q_2}{r^2}\n  \\]'));
  assert.ok(s.includes('  \\item (\\eqref{eq:d}) % TODO: що ця формула означає\n  \\begin{align*}\n    a &= b \\\\\n    c &= d\n  \\end{align*}'));
  assert.ok(!/\\label|nonumber/.test(s));
  assert.ok(!s.includes('Нічого'));
});
t('draftSummary: nothing marked gives an empty draft', () => {
  assert.deepStrictEqual(K.draftSummary([{ path: 'a.tex', text: '\\begin{equation}\n x\n\\end{equation}' }]), { text: '', count: 0, files: 0 });
});
t('toggleKey: insert above with the indent, remove an own line, cut a trailing mark, outside a formula', () => {
  const a = L('  \\begin{equation}\n    x\n  \\end{equation}');
  assert.deepStrictEqual(K.toggleKey(a, 1), { type: 'insert', line: 0, text: '  %! key', marked: true });
  const b = L('%! key: A\n\\begin{equation}\n x\n\\end{equation}');
  assert.deepStrictEqual(K.toggleKey(b, 2), { type: 'delete', line: 0, marked: false });
  const c = L('\\begin{align} %! key\n a\n\\end{align}');
  assert.deepStrictEqual(K.toggleKey(c, 1), { type: 'replace', line: 0, text: '\\begin{align}', marked: false });
  assert.strictEqual(K.toggleKey(L('текст\n\\begin{equation}\n x\n\\end{equation}'), 0), null);
});
console.log(n + ' tests passed');
