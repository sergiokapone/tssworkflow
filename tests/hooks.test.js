'use strict';
// node tests/hooks.test.js [path/to/extension]
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const P = require(path.join(ext, 'corePure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

// a piece of a real log (TeX Live 2023, pdflatex): the first line of a \ShowHook block starts with "-> "
const REAL = [
  "-> The hook 'shipout/before':",
  '> The hook is empty.',
  '<recently read> }',
  '                 ',
  'l.4 \\begin{document}',
  '',
  "-> The hook 'shipout/foreground':",
  '> Code chunks:',
  '>     eso-pic -> \\put (0,\\ESO@yoffsetI ){\\ESO@HookIFG \\global \\let \\ESO@HookIIFG \\@empty }',
  '> Execution order:',
  '>     eso-pic.',
  '<recently read> }',
  'l.4 \\begin{document}'
].join('\n');

t('parseShowHooks: "-> The hook" (TeX Live 2023 log)', () => {
  const h = P.parseShowHooks(REAL);
  assert.deepStrictEqual(h.map((x) => x.hook), ['shipout/before', 'shipout/foreground']);
  assert.ok(h[0].text.startsWith("The hook 'shipout/before':") && h[0].text.includes('The hook is empty.'));
  assert.ok(h[1].text.includes('eso-pic -> \\put') && h[1].text.includes('Execution order:'));
  assert.ok(!h[1].text.includes('recently read'));
});
t('parseShowHooks: the older "> The hook" form still works, no hooks gives []', () => {
  const h = P.parseShowHooks("> The hook 'shipout/after':\n> Code chunks:\n>     x -> y\nl.1 a");
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].hook, 'shipout/after');
  assert.deepStrictEqual(P.parseShowHooks('nothing here'), []);
});
t('hooksTarget: chapter, figure, root file, other extension', () => {
  assert.deepStrictEqual(P.hooksTarget('Electro/Electro.tex'), { chapter: 'Electro', tikz: null });
  assert.deepStrictEqual(P.hooksTarget('Electro\\Electro.tex'), { chapter: 'Electro', tikz: null });
  assert.deepStrictEqual(P.hooksTarget('Electro/tikz/fig1.tikz'), { chapter: 'Electro', tikz: 'fig1' });
  assert.strictEqual(P.hooksTarget('main.tex'), null);
  assert.strictEqual(P.hooksTarget('Electro/Pictures/a.png'), null);
  assert.strictEqual(P.hooksTarget(''), null);
});
t('hooksInject: with and without a target', () => {
  const names = ['shipout/before', 'shipout/after'];
  assert.strictEqual(P.hooksInject(names, null, 'main.tex'),
    '\\AddToHook{begindocument/end}{\\ShowHook{shipout/before}\\ShowHook{shipout/after}\\csname@@end\\endcsname}\\input{main.tex}');
  assert.ok(P.hooksInject(names, { chapter: 'X', tikz: 'f' }, 'alone.tex').startsWith('\\def\\TargetChapter{X}\\def\\TargetTikz{f}\\AddToHook'));
  assert.ok(P.hooksInject(names, { chapter: 'X', tikz: null }, 'alone.tex').endsWith('\\input{alone.tex}'));
});
t('diagnoseHooksLog: empty, old LaTeX, error, plain', () => {
  assert.strictEqual(P.diagnoseHooksLog('').empty, true);
  const o = P.diagnoseHooksLog('LaTeX2e <2020-02-02>\n! Undefined control sequence.');
  assert.deepStrictEqual([o.old, o.date, o.error], [true, '2020-02-02', '! Undefined control sequence.']);
  const e = P.diagnoseHooksLog('LaTeX2e <2024-06-01>\n./X.tex:12: Emergency stop');
  assert.deepStrictEqual([e.old, e.error], [false, './X.tex:12: Emergency stop']);
  const p = P.diagnoseHooksLog('just some text');
  assert.deepStrictEqual([p.old, p.date, p.error], [false, null, null]);
});
console.log('\n' + n + ' tests passed');
