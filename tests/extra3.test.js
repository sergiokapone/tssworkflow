'use strict';
// node tests/extra3.test.js [path/to/extension]  - the pure part of 0.5.0 (chapters, replace, notation, .bib, problems, snapshots)
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const X = require(path.join(ext, 'extra3Pure.js'));
const C = require(path.join(ext, 'chaptersPure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const LM = ['\\multiinclude'];
const MAIN = [
  '\\documentclass{book}', '\\begin{document}',
  '\\part{Електростатика}',
  '\\multiinclude{Charges, % перший',
  '  SteadyEfield,',
  '  Dielectrics}[]',
  '\\part{Магнетизм}',
  '\\includechapter{Magnet}',
  '% \\includechapter{Hidden}',
  '\\part{Порожня}',
  '\\part{Плазма}',
  '\\multiinclude{Plasma}[]',
  '\\end{document}'
].join('\n');

t('validChapterName', () => {
  assert.ok(X.validChapterName('Charges') && X.validChapterName('A_1-b'));
  assert.ok(!X.validChapterName('1a') && !X.validChapterName('Заряди') && !X.validChapterName('a b') && !X.validChapterName(''));
});
t('chapterItems: order, lists and single macros, comments skipped', () => {
  const it = X.chapterItems(MAIN, '\\includechapter', LM);
  assert.deepStrictEqual(it.map((x) => x.name), ['Charges', 'SteadyEfield', 'Dielectrics', 'Magnet', 'Plasma']);
  for (const x of it) assert.strictEqual(MAIN.slice(x.start, x.end), x.name);
});
t('moveChapter: down inside a list keeps comments and layout', () => {
  const r = X.moveChapter(MAIN, 'Charges', +1, '\\includechapter', LM);
  assert.strictEqual(r.with, 'SteadyEfield');
  assert.ok(r.text.includes('\\multiinclude{SteadyEfield, % перший\n  Charges,\n  Dielectrics}[]'));
});
t('moveChapter: across a \\part and a list boundary; first/last/not found', () => {
  const r = X.moveChapter(MAIN, 'Magnet', -1, '\\includechapter', LM);
  assert.strictEqual(r.with, 'Dielectrics');
  assert.ok(r.text.includes('Magnet}[]') && r.text.includes('\\includechapter{Dielectrics}'));
  assert.deepStrictEqual(X.moveChapter(MAIN, 'Charges', -1, '\\includechapter', LM), { error: 'first' });
  assert.deepStrictEqual(X.moveChapter(MAIN, 'Plasma', +1, '\\includechapter', LM), { error: 'last' });
  assert.deepStrictEqual(X.moveChapter(MAIN, 'Nope', +1, '\\includechapter', LM), { error: 'notfound' });
  // the structure read back by the panel follows the new order
  const names = C.chapterNames(r.text, '\\includechapter', LM);
  assert.deepStrictEqual(names, ['Charges', 'SteadyEfield', 'Magnet', 'Dielectrics', 'Plasma']);
});
t('renameInMain: lists and single macros, not comments', () => {
  const a = X.renameInMain(MAIN, 'SteadyEfield', 'Current', '\\includechapter', LM);
  assert.strictEqual(a.count, 1);
  assert.ok(a.text.includes('  Current,'));
  const b = X.renameInMain(MAIN, 'Hidden', 'Z', '\\includechapter', LM);
  assert.strictEqual(b.count, 0);
});
t('renameChapterTexts: main, paths, refs (only when \\currfilebase is used), comments untouched', () => {
  const files = [
    { path: 'main.tex', text: MAIN + '\n\\input{Charges/Charges} % Charges/Charges stays\n\\includegraphics{Charges/Pictures/a.png}' },
    { path: 'Charges/Charges.tex', text: '\\chapter{Z}\\label{\\currfilebase}\nsee \\ref{other}' },
    { path: 'Magnet/Magnet.tex', text: 'див. \\ref{Charges}, \\cref{Charges:coulomb, eq:x} і \\ref{Charges2} і \\label{Charges}' },
    { path: 'Other/o.tex', text: '\\ref{Charges}' }
  ];
  const r = X.renameChapterTexts(files, 'Charges', 'Electro', { mainFile: 'main.tex', macro: '\\includechapter', listMacros: LM });
  const m = r.changes.get('main.tex');
  assert.ok(m.includes('\\multiinclude{Electro, % перший'));
  assert.ok(m.includes('\\input{Electro/Electro} % Charges/Charges stays'));
  assert.ok(m.includes('\\includegraphics{Electro/Pictures/a.png}'));
  const g = r.changes.get('Magnet/Magnet.tex');
  assert.ok(g.includes('\\ref{Electro}') && g.includes('\\cref{Electro:coulomb, eq:x}') && g.includes('\\ref{Charges2}'));
  assert.ok(g.includes('\\label{Charges}'), 'labels are not touched (explicit label)');
  assert.ok(!r.changes.has('Charges/Charges.tex'));
  assert.strictEqual(r.changes.get('Other/o.tex'), '\\ref{Electro}');
  // without \currfilebase the refs stay
  const r2 = X.renameChapterTexts([{ path: 'Charges/Charges.tex', text: '\\label{Charges}' }, { path: 'a.tex', text: '\\ref{Charges}' }], 'Charges', 'E', {});
  assert.strictEqual(r2.changes.size, 0);
});
t('filterMainForParts: only the chosen parts stay, line numbers do not move', () => {
  const st = C.chapterStructure(MAIN, '\\includechapter', LM);
  assert.deepStrictEqual(st.map((p) => p.title), ['Електростатика', 'Магнетизм', 'Плазма']);
  const r = X.filterMainForParts(MAIN, '\\includechapter', LM, [1]);
  assert.strictEqual(r.split('\n').length, MAIN.split('\n').length);
  assert.ok(r.includes('\\part{Магнетизм}') && r.includes('\\includechapter{Magnet}'));
  assert.ok(!r.includes('Charges') && !r.includes('Plasma') && !r.includes('Електростатика') && !r.includes('Порожня'));
  assert.deepStrictEqual(C.chapterNames(r, '\\includechapter', LM), ['Magnet']);
  const r2 = X.filterMainForParts(MAIN, '\\includechapter', LM, [0, 2]);
  assert.deepStrictEqual(C.chapterNames(r2, '\\includechapter', LM), ['Charges', 'SteadyEfield', 'Dielectrics', 'Plasma']);
  // chapters before the first \part are group 0
  const lead = '\\includechapter{Intro}\n\\part{A}\n\\includechapter{X}';
  assert.deepStrictEqual(C.chapterNames(X.filterMainForParts(lead, '\\includechapter', LM, [1]), '\\includechapter', LM), ['X']);
});
t('replaceInText: whole macro, comments, verbatim, \\verb, regex groups', () => {
  const src = '\\vect a \\vectX \\vect{b} % \\vect c\n\\begin{verbatim}\n\\vect z\n\\end{verbatim}\n\\verb|\\vect| \\vect';
  const r = X.replaceInText(src, '\\vect', '\\vec');
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.text, '\\vec a \\vectX \\vec{b} % \\vect c\n\\begin{verbatim}\n\\vect z\n\\end{verbatim}\n\\verb|\\vect| \\vec');
  assert.deepStrictEqual(r.hits.map((h) => h.line), [0, 0, 4]);
  const g = X.replaceInText('\\text{см} \\text{abc}', '\\\\text\\{([а-я]+)\\}', '\\mathrm{$1}', { regex: true });
  assert.strictEqual(g.text, '\\mathrm{см} \\text{abc}');
  assert.strictEqual(X.replaceInText('a$b', '$', '$$').text, 'a$$b', 'plain replacement is literal');
  assert.ok(X.replaceInText('x', '(', 'y', { regex: true }).error);
  assert.strictEqual(X.replaceInText('a\r\nb a\r\n', 'a', 'c').text, 'c\r\nb c\r\n');
});
t('notationReport / unify', () => {
  const files = [
    { path: 'a.tex', text: '$\\varepsilon$ $\\epsilon$ $\\epsilon_0$ \\text{см} \\mathrm{Кл}' },
    { path: 'b.tex', text: '$\\varepsilon$ \\le \\le \\leq' }
  ];
  const rep = X.notationReport(files, null);
  const eps = rep.find((r) => r.name.startsWith('ε'));
  assert.ok(eps.mixed);
  assert.deepStrictEqual(eps.variants.map((v) => v.count), [2, 2]);
  assert.ok(rep.find((r) => r.name.startsWith('≤')).mixed);
  assert.ok(!rep.find((r) => r.name.startsWith('φ')).mixed);
  assert.ok(rep.find((r) => r.name.startsWith('одиниці')).mixed);
  const u = X.notationUnify(files, eps.group, '\\varepsilon');
  assert.strictEqual(u.count, 2);
  assert.ok(u.changes.get('a.tex').includes('\\varepsilon_0') && !u.changes.get('a.tex').includes('\\epsilon'));
  assert.ok(!u.changes.has('b.tex'));
  const units = rep.find((r) => r.name.startsWith('одиниці'));
  assert.ok(X.notationUnify(files, units.group, '\\mathrm{одиниця}').changes.get('a.tex').includes('\\mathrm{см}'));
  const txt = X.formatNotationReport(rep, { folder: 'p' });
  assert.ok(txt.includes('⚠️ ε') && txt.includes('✅ φ'));
});
t('parseBibEntries: fields, braces, accents, editor fallback, date, skipped types', () => {
  const bib = [
    '@comment{x}', '@string{a = "b"}',
    '@book{landau,', '  author = {Landau, L. D. and Lifshitz, E. M.},', '  title = {Electrodynamics of {Continuous} Media},', '  year = 1960,', '  publisher = "Pergamon"', '}',
    '@article{ab2020,', '  author = "{\\"O}tt, A. and B, C. and D, E.",', '  journaltitle = {Phys. Rev.},', '  date = {2020-05-01},', '  title = {A, B and C = D}', '}',
    '@collection{ed,', '  editor = {Ed, Ward},', '  title = {T}', '}'
  ].join('\n');
  const e = X.parseBibEntries(bib);
  assert.deepStrictEqual(e.map((x) => x.key), ['landau', 'ab2020', 'ed']);
  assert.strictEqual(e[0].title, 'Electrodynamics of Continuous Media');
  assert.strictEqual(e[0].year, '1960');
  assert.strictEqual(e[1].year, '2020');
  assert.strictEqual(e[1].journal, 'Phys. Rev.');
  assert.strictEqual(e[1].title, 'A, B and C = D');
  assert.strictEqual(e[2].author, 'Ed, Ward');
  assert.strictEqual(X.shortAuthors(e[0].author), 'Landau, Lifshitz');
  assert.strictEqual(X.shortAuthors(e[1].author), 'Ott et al.');
});
t('CITE_CTX', () => {
  assert.strictEqual(X.CITE_CTX.exec('текст \\cite{a, b')[1], 'a, b');
  assert.strictEqual(X.CITE_CTX.exec('\\parencite[см.][12]{ab')[1], 'ab');
  assert.strictEqual(X.CITE_CTX.exec('\\textcite*{x')[1], 'x');
  assert.strictEqual(X.CITE_CTX.exec('\\cite{a} і ще'), null);
});
t('groupProblems: order, sorting, boxes', () => {
  const g = X.groupProblems([
    { file: 'b.tex', line: 3, severity: 'warning', message: 'W' },
    { file: 'a.tex', line: 9, severity: 'error', message: 'E2' },
    { file: 'a.tex', line: 2, severity: 'error', message: 'E1' },
    { file: 'a.tex', line: 1, severity: 'warning', message: 'Overfull \\hbox (3pt too wide)' },
    { file: 'a.tex', line: 5, severity: 'hint', message: 'h' }
  ]);
  assert.deepStrictEqual(g.map((x) => x.id), ['error', 'warning', 'box', 'other']);
  assert.deepStrictEqual(g[0].items.map((x) => x.message), ['E1', 'E2']);
  assert.deepStrictEqual(X.groupProblems([]), []);
});
t('snapshots: id and pruning', () => {
  assert.strictEqual(X.snapshotId(new Date(2026, 9, 6, 8, 5, 9), 'перед заміною \\vect'), '20261006-080509-перед-заміною-vect');
  assert.strictEqual(X.snapshotId(new Date(2026, 0, 2, 3, 4, 5), ''), '20260102-030405');
  assert.deepStrictEqual(X.snapshotsToPrune(['c', 'a', 'b', 'd'], 2), ['a', 'b']);
  assert.deepStrictEqual(X.snapshotsToPrune(['a'], 2), []);
});
console.log('\n' + n + ' tests passed');
