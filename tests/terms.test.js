'use strict';
// node tests/terms.test.js [path/to/extension]  - termsPure.js (terms: used before defined, index) and the index step of the build (workspacePure.js)
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const T = require(path.join(ext, 'termsPure.js'));
const W = require(path.join(ext, 'workspacePure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const F = (p, text) => ({ path: p, text });

t('wordMatch: endings, the 4-letter beginning, loose for phrases', () => {
  assert.ok(T.wordMatch('напруженість', 'напруженості') && T.wordMatch('заряд', 'зарядами') && T.wordMatch('електрон', 'електрони'));
  assert.ok(!T.wordMatch('електрон', 'електричний'), 'different stems');
  assert.ok(!T.wordMatch('поле', 'поля'), 'strict: 3 letters in common');
  assert.ok(T.wordMatch('поле', 'поля', true) && !T.wordMatch('поле', 'полярність', true), 'loose: endings of at most 2 letters (полюс would match too: the neighbouring words of a phrase keep it from false hits)');
  assert.ok(!T.wordMatch('сила', 'сам') && T.wordMatch('сам', 'сам'), 'short words match only exactly');
});

t('proseOf: comments, formulas, pictures, headings and arguments of \\label \\ref \\index are blanked; offsets stay', () => {
  const src = 'Текст % коментар поле\n$E=поле$ і \\[ поле \\]\n\\begin{equation}поле\\end{equation}\n\\section{Поле}\\label{поле} \\ref{поле} \\index{поле} заряд \\%поле';
  const p = T.proseOf(src);
  assert.strictEqual(p.length, src.length);
  assert.strictEqual(p.split('\n').length, src.split('\n').length);
  assert.deepStrictEqual(T.wordsOf(p).map((x) => x.w), ['текст', 'і', 'заряд', 'поле'], 'only the text and the escaped percent remain');
});

t('termDefinitions: \\emph and the macros of the setting, nested commands, skipped: too short, too many words', () => {
  const src = 'Назвемо \\emph{\\textbf{електричним} полем} і \\term{заряд}. \\emph{і} \\emph{один два три чотири п\'ять шість сім}\n\\emph*{Закон Кулона}';
  const d = T.termDefinitions(src, ['\\emph', 'term']);
  assert.deepStrictEqual(d.map((x) => [x.term, x.line]), [['електричним полем', 1], ['заряд', 1], ['Закон Кулона', 2]]);
  assert.strictEqual(src.slice(d[1].start, d[1].end), '\\term{заряд}');
  assert.deepStrictEqual(T.termDefinitions('\\emph{а}', ['\\bad name']), []);
});

t('termsReport: used before the first definition, in the order of the files; after it is fine; formulas and headings do not count', () => {
  const a = F('A/A.tex', '\\chapter{Напруженість}\nНапруженість електричного поля тут вже є.\n$напруженість$ \\begin{equation}заряд\\end{equation}\nЗаряди взаємодіють.');
  const b = F('B/B.tex', 'Назвемо \\emph{напруженістю} величину. Напруженість далі. \\emph{Заряд} означено тут.\nЕлектричне поле.');
  const r = T.termsReport([a, b], {});
  assert.deepStrictEqual(r.terms.map((x) => x.term), ['напруженістю', 'Заряд']);
  assert.deepStrictEqual(r.early.map((e) => [e.term, e.first.path, e.first.line, e.count]), [['напруженістю', 'A/A.tex', 2, 1], ['Заряд', 'A/A.tex', 4, 1]]);
  assert.strictEqual(r.early[0].def.path, 'B/B.tex');
  assert.deepStrictEqual(T.termsReport([b, a], {}).early, [], 'the same files in the other order: nothing is early');
});

t('termsReport: a phrase needs all its words in a row; the term defined twice is one term; ignore', () => {
  const a = F('A.tex', 'Електричний заряд. Заряд електричний. Електричне поле.');
  const b = F('B.tex', '\\emph{електричне поле}, ще раз \\emph{Електричного поля}. \\emph{тільки}');
  const r = T.termsReport([a, b], { ignore: ['Тільки'] });
  assert.strictEqual(r.terms.length, 1);
  assert.strictEqual(r.terms[0].defs, 2);
  assert.deepStrictEqual(r.early.map((e) => [e.term, e.count]), [['електричне поле', 1]]);
});

t('termsReport: noIndex only when the index is asked for; \\index forms: key@display, levels, |format, escaped quotes', () => {
  const a = F('A.tex', 'Є \\emph{заряд}\\index{заряд@\\emph{заряд}|textbf}, \\emph{струм}, \\emph{електричне поле}, \\emph{потенціал}, \\emph{опір}.\n\\index{Електричне поле!напруженість} \\index{потенціал"!} % \\index{струм}');
  assert.deepStrictEqual(T.termsReport([a], {}).noIndex, []);
  const r = T.termsReport([a], { index: true });
  assert.deepStrictEqual(r.noIndex.map((x) => x.term), ['струм', 'опір'], 'a commented \\index does not count; levels and display text do');
  assert.strictEqual(r.indexEntries, 3);
});

t('indexInsertions: after the first definition, several in a file from the end; indexEntryFor escapes', () => {
  const a = F('A.tex', 'a \\emph{струм} b \\emph{опір}\nc \\emph{струм}');
  const r = T.termsReport([a], { index: true });
  assert.strictEqual(T.indexInsertions([a], r).get('A.tex'), 'a \\emph{струм}\\index{струм} b \\emph{опір}\\index{опір}\nc \\emph{струм}');
  assert.strictEqual(T.indexEntryFor('\\emph{Закон} Кулона'), 'Закон Кулона');
  assert.strictEqual(T.indexEntryFor('а!б@в|г"д'), 'а"!б"@в"|г""д');
});

t('formatTermsReport: the parts', () => {
  const r = T.termsReport([F('A.tex', 'заряд тут.\n\\emph{заряд}')], { index: true });
  const md = T.formatTermsReport(r, { folder: 'proj', index: true, macros: ['\\emph'] });
  assert.ok(md.startsWith('# Терміни — proj') && md.includes('| заряд | A.tex:2 | A.tex:1 — заряд тут. | 1 |') && md.includes('- заряд (A.tex:2)'));
  assert.ok(T.formatTermsReport(T.termsReport([F('A.tex', '\\emph{заряд}')], {}), {}).includes('Вимкнено'));
});

t('byBookOrder: the order of the folders in main.tex, unknown folders after them, files of the root last', () => {
  const l = [F('z.tex'), F('C/c.tex'), F('Q/q.tex'), F('B/b.tex'), F('A/a.tex')].sort(T.byBookOrder(['A', 'B', 'C']));
  assert.deepStrictEqual(l.map((x) => x.path), ['A/a.tex', 'B/b.tex', 'C/c.tex', 'Q/q.tex', 'z.tex']);
});

t('indexProgram: the magic comment in the first lines; only known programs', () => {
  assert.deepStrictEqual(W.indexProgram('% !TEX program = lualatex\n% !TEX indexprogram = upmendex\n\\documentclass{book}'), { name: 'upmendex', raw: 'upmendex' });
  assert.strictEqual(W.indexProgram('%!TeX TS-indexprogram = MakeIndex').name, 'makeindex');
  assert.deepStrictEqual(W.indexProgram('% !TEX indexprogram = rm'), { name: '', raw: 'rm' }, 'an unknown name starts nothing');
  assert.strictEqual(W.indexProgram('\\documentclass{book}\n').name, '');
  assert.strictEqual(W.indexProgram('x\n'.repeat(70) + '% !TEX indexprogram = upmendex').name, '', 'far from the top: not a magic comment');
  assert.strictEqual(W.indexProgram('% indexprogram = upmendex').name, '');
});

t('buildSteps: the index after the bibliography and before the second run, only with tools, runs > 1, a known name, and when .idx exists', () => {
  const ex = (o) => W.buildSteps(Object.assign({ exe: 'l', args: ['a'], n: 3, tools: true, job: 'a' }, o)).map((x) => x.exe);
  assert.deepStrictEqual(ex({ index: 'upmendex' }), ['l', 'biber', 'bibtex', 'upmendex', 'l', 'l']);
  assert.deepStrictEqual(ex({}), ['l', 'biber', 'bibtex', 'l', 'l'], 'no comment: as before');
  assert.deepStrictEqual(ex({ index: 'rm' }), ['l', 'biber', 'bibtex', 'l', 'l']);
  assert.deepStrictEqual(ex({ index: 'upmendex', n: 1 }), ['l']);
  assert.deepStrictEqual(ex({ index: 'upmendex', tools: false }), ['l', 'l', 'l']);
  const step = W.buildSteps({ exe: 'l', args: [], n: 2, tools: true, job: 'main', index: 'makeindex' })[3];
  assert.deepStrictEqual([step.exe, step.args, step.tex], ['makeindex', ['main'], false]);
  assert.ok(!W.stepApplies(step, { exists: () => false }) && W.stepApplies(step, { exists: (f) => f === 'main.idx' }));
});

t('latexmkIndexArgs: one -e argument for another program, nothing for makeindex', () => {
  assert.deepStrictEqual(W.latexmkIndexArgs('upmendex'), ['-e', '$makeindex="upmendex %O -o %D %S";']);
  assert.deepStrictEqual(W.latexmkIndexArgs('makeindex'), []);
  assert.deepStrictEqual(W.latexmkIndexArgs(''), []);
  assert.deepStrictEqual(W.latexmkIndexArgs('rm'), []);
});
console.log(n + ' tests passed');
