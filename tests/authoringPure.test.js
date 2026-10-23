'use strict';
// node tests/authoringPure.test.js [path/to/extension]
// 0.22.0: authoringPure.js directly (until now only through the stub of authoring.js): the labels of file names, the include line of the
// main file, the \iffalse toggle, Unicode -> LaTeX, DOI and BibTeX keys, the git log, the pgf layers, stale references.
const assert = require('assert'), path = require('path');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
const A = require(path.join(EXT, 'authoringPure'));
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } };

t('stemLabel: ASCII letters, digits, - and _ only; nothing left -> "figure"', () => {
  assert.strictEqual(A.stemLabel('My Figure 1'), 'My-Figure-1');
  assert.strictEqual(A.stemLabel('a__b'), 'a__b');
  assert.strictEqual(A.stemLabel('Рисунок'), 'figure');
  assert.strictEqual(A.stemLabel('--x--'), 'x');
});

t('uniqueStem: the first free name, counting from -2', () => {
  assert.strictEqual(A.uniqueStem([], 'a', '.png'), 'a');
  assert.strictEqual(A.uniqueStem(['a.png'], 'a', '.png'), 'a-2');
  assert.strictEqual(A.uniqueStem(['a.png', 'a-2.png'], 'a', '.png'), 'a-3');
});

t('addIncludeLine: after the last include, with its indent and line ends; already there; none; a commented one does not count', () => {
  const M = '\\includechapter';
  const r = A.addIncludeLine('  \\includechapter{a}\r\n  \\includechapter{b}\r\nend', M, 'c');
  assert.deepStrictEqual([r.ok, r.already, r.line], [true, false, 2]);
  assert.strictEqual(r.text, '  \\includechapter{a}\r\n  \\includechapter{b}\r\n  \\includechapter{c}\r\nend');
  assert.deepStrictEqual(A.addIncludeLine('\\includechapter{a}', M, 'a'), { ok: true, already: true, text: '\\includechapter{a}', line: 0 });
  assert.strictEqual(A.addIncludeLine('% \\includechapter{a}\nx', M, 'b').ok, false);
  assert.strictEqual(A.addIncludeLine('x', M, 'b').line, -1);
});

t('ifBalance and toggleIffalse: conditions with arguments and comments do not count; wrap or unwrap our own block', () => {
  assert.strictEqual(A.ifBalance(['\\iffalse', 'x', '\\fi']), 0);
  assert.strictEqual(A.ifBalance(['\\iffalse', 'x']), 1);
  assert.strictEqual(A.ifBalance(['\\ifthenelse{a}{b}{c}']), 0);
  assert.strictEqual(A.ifBalance(['x % \\iffalse']), 0);
  assert.deepStrictEqual(A.toggleIffalse(['  x', '  y'], 0, 1), { kind: 'wrap', indent: '  ', balance: 0 });
  assert.strictEqual(A.toggleIffalse(['\\iffalse', 'x'], 0, 1).balance, 1, 'an unbalanced selection is reported, not wrapped silently');
  assert.deepStrictEqual(A.toggleIffalse([A.IF_OPEN, 'x', A.IF_CLOSE], 1, 1), { kind: 'unwrap', open: 0, close: 2 });
  // a \iffalse that is not ours (no "% TSS") is not unwrapped
  assert.strictEqual(A.toggleIffalse(['\\iffalse', 'x', '\\fi'], 1, 1).kind, 'wrap');
});

t('unicodeToLatex: Greek and symbols become math, other letters stay', () => {
  const r = A.unicodeToLatex('α ≤ β и °C', 0, 10);
  assert.ok(r.text.includes('\\alpha') && r.text.includes('\\leq') && r.text.includes('\\beta') && r.text.includes('и'), r.text);
  assert.strictEqual(r.count, 4);
  assert.deepStrictEqual(A.unicodeToLatex('привіт', 0, 6), { text: 'привіт', count: 0, chem: 0 });
});

t('DOI and BibTeX keys', () => {
  assert.strictEqual(A.normalizeDoi('https://doi.org/10.1000/ABC.1'), '10.1000/ABC.1');
  assert.strictEqual(A.normalizeDoi('not a doi'), null);
  assert.deepStrictEqual(A.bibKeys('@book{a,x={1}}\n@misc{b,y={2}}'), ['a', 'b']);
  assert.strictEqual(A.uniqueKey('k', new Set()), 'k');
  assert.strictEqual(A.uniqueKey('smith2020', new Set(['smith2020'])), 'smith2020a');
  assert.strictEqual(A.setBibKey('@article{old,\n title={x}\n}', 'new'), '@article{new,\n title={x}\n}');
});

t('parseGitLog (tab-separated), isStale (2 s tolerance, 0 = unknown), layerFix', () => {
  assert.deepStrictEqual(A.parseGitLog('abc\tfix it\t2 days ago\n\ndef\tadd\t1 hour ago\n'), [
    { hash: 'abc', subject: 'fix it', when: '2 days ago' }, { hash: 'def', subject: 'add', when: '1 hour ago' }]);
  assert.strictEqual(A.isStale(1000, 3001), true);
  assert.strictEqual(A.isStale(1000, 3000), false);
  assert.strictEqual(A.isStale(0, 5000), false);
  assert.strictEqual(A.isStale(1000, 0), false);
  const f = A.layerFix('\\pgfsetlayers{background,main}\n', 'foo');
  assert.strictEqual(f.replacement, '\\pgfdeclarelayer{foo}\n\\pgfsetlayers{background, foo, main}');
  assert.strictEqual(A.layerFix('\\pgfdeclarelayer{foo}\n\\pgfsetlayers{foo,main}', 'foo'), null, 'nothing to change');
  assert.strictEqual(A.layerFix('no layers here', 'foo'), null);
});

console.log('authoringPure: ' + n + ' checks passed');
