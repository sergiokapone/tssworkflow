'use strict';
// node tests/tikz-inline.test.js [path/to/extension]
// 0.6.1: Format inline \tikz (formattersPure.formatInlineTikz) and inline \tikz pictures in "Extract tikzpicture to tikz/" (tikzExtract.js)
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const N = require(path.join(ext, 'formattersPure.js'));
const T = require(path.join(ext, 'tikzExtract.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const squash = (s) => s.replace(/\s+/g, '');
const fmt = (s, o) => N.formatInlineTikz(s, Object.assign({ unit: '    ' }, o || {}));

const LONG = '\\tikz[>latex]{ \\node [] (0) at (0, -1) {a; b}; \\node [] (1) at (0, +1) {}; \\draw[line width=2pt, gray, arrowpos={0.7}{4pt}{7pt}] (0.center) to (1.center); ' +
  '\\foreach \\n in {1,...,4} { \\draw[blue!40] (0, 0) ; \\draw (1,1) -- (2,2); } \\begin{scope}[shift={(1,0)}] \\draw (0,0) circle (1); \\end{scope} \\draw[thin] (0,0) -- (1,1) node[left] {$\\vect{j}$}; }';

/* --------------------------------- formatInlineTikz --------------------------------- */
t('one statement per line; ; inside node text, \\foreach bodies and scopes are nested; only whitespace changes', () => {
  const r = fmt('    & ' + LONG + ' \\\\');
  assert.strictEqual(r.formatted, 1);
  assert.deepStrictEqual(r.skipped, []);
  assert.strictEqual(r.text, [
    '    & \\tikz[>latex]{',
    '        \\node [] (0) at (0, -1) {a; b};',
    '        \\node [] (1) at (0, +1) {};',
    '        \\draw[line width=2pt, gray, arrowpos={0.7}{4pt}{7pt}] (0.center) to (1.center);',
    '        \\foreach \\n in {1,...,4} {',
    '            \\draw[blue!40] (0, 0) ;',
    '            \\draw (1,1) -- (2,2);',
    '        }',
    '        \\begin{scope}[shift={(1,0)}]',
    '            \\draw (0,0) circle (1);',
    '        \\end{scope}',
    '        \\draw[thin] (0,0) -- (1,1) node[left] {$\\vect{j}$};',
    '    } \\\\'
  ].join('\n'));
  assert.strictEqual(squash(r.text), squash('    & ' + LONG + ' \\\\'));
});
t('second run changes nothing (a range in several lines is not touched)', () => {
  const a = fmt(LONG).text;
  const b = fmt(a);
  assert.strictEqual(b.text, a);
  assert.strictEqual(b.formatted, 0);
});
t('minLength: a short \\tikz stays (an icon in the text), 0 means all, the default is 100', () => {
  const s = 'Піктограма \\tikz[baseline]{\\draw (0,0) -- (1,1); \\draw (1,1) -- (2,0);} в тексті.';
  assert.strictEqual(fmt(s).formatted, 0);
  assert.strictEqual(fmt(s, { minLength: 0 }).formatted, 1);
  assert.strictEqual(fmt(LONG, { minLength: 100000 }).formatted, 0);
});
t('the base indent is the indent of the line; two \\tikz on a line; the text around stays', () => {
  const s = '  A \\tikz{ \\draw (0,0) -- (1,1); \\draw (1,1) -- (2,2); } B \\tikz{ \\node {x}; \\node {y}; } C';
  const r = fmt(s, { minLength: 0 });
  assert.strictEqual(r.formatted, 2);
  assert.strictEqual(r.text, ['  A \\tikz{', '      \\draw (0,0) -- (1,1);', '      \\draw (1,1) -- (2,2);', '  } B \\tikz{', '      \\node {x};', '      \\node {y};', '  } C'].join('\n'));
});
t('the unit is taken from the options (tab)', () => {
  const r = fmt('\\tikz{ \\draw (0,0) -- (1,1); \\draw (1,1) -- (2,2); }', { minLength: 0, unit: '\t' });
  assert.ok(r.text.split('\n')[1].startsWith('\t\\draw'));
});
t('\\tikz \\draw ...; without braces, \\tikzset and a text around are skipped or ignored, nothing is lost', () => {
  const s = '\\tikz \\draw (0,0) -- (1,1); i \\tikzset{a/.style={b -- c}} i \\tikzpicture';
  const r = fmt(s, { minLength: 0 });
  assert.strictEqual(r.text, s);
  assert.strictEqual(r.formatted, 0);
  assert.strictEqual(r.skipped.length, 1);
  assert.ok(/без дужок/.test(r.skipped[0].reason));
});
t('a statement without ; at the end and a command without ; before \\foreach / \\begin do not swallow their neighbours', () => {
  const r = fmt('\\tikz{ \\pgfmathsetmacro{\\r}{2} \\foreach \\i in {1,2} { \\draw (\\i,0) circle (\\r pt); } \\draw (0,0) -- (1,1) }', { minLength: 0 });
  assert.strictEqual(r.text, ['\\tikz{', '    \\pgfmathsetmacro{\\r}{2}', '    \\foreach \\i in {1,2} {', '        \\draw (\\i,0) circle (\\r pt);', '    }', '    \\draw (0,0) -- (1,1)', '}'].join('\n'));
});
t('only: the selection or the cursor picks the ranges; found counts the ones in reach', () => {
  const s = '\\tikz{ \\node {a}; \\node {b}; }\n\\tikz{ \\node {c}; \\node {d}; }';
  const second = s.indexOf('\\tikz', 5);
  const r = fmt(s, { minLength: 0, only: [second + 3, second + 3] });
  assert.strictEqual(r.found, 1);
  assert.strictEqual(r.formatted, 1);
  assert.ok(r.text.startsWith('\\tikz{ \\node {a}; \\node {b}; }\n\\tikz{\n'));
  assert.strictEqual(fmt(s, { minLength: 0, only: [0, s.length] }).formatted, 2);
  assert.strictEqual(fmt(s, { minLength: 0, only: [14, 14] }).found, 1);
});
t('a \\tikz inside a % comment or with unbalanced braces gives nothing', () => {
  assert.strictEqual(fmt('% \\tikz{ \\node {a}; \\node {b}; }', { minLength: 0 }).found, 0);
  assert.strictEqual(fmt('\\tikz{ \\node {a}; \\node {b}; ', { minLength: 0 }).found, 0);
});

/* ------------------------ inline pictures in the extractor ------------------------ */
const SRC = [
  '\\begin{figure}',
  '  \\begin{tikzpicture}',
  '    \\node {\\tikz \\draw (0,0) -- (1,1);};',
  '  \\end{tikzpicture}',
  '  \\caption{x}\\label{tikz:Env}',
  '\\end{figure}',
  '\\begin{frame}',
  '  \\begin{tblr}{colspec={c}}',
  '    \\tikz[>latex]{ \\draw (0,0) -- (1,1); } \\\\',
  '  \\end{tblr}',
  '  % \\tikz{ \\node {c}; }',
  '  \\tikzset{a/.style={b}} and \\tikz \\node {z};',
  '\\end{frame}'
];
t('findInlinePictures: \\tikz[..]{..} and \\tikz ...; only; not \\tikzset, not a comment, not inside an environment picture', () => {
  const envs = T.findPictures(SRC, ['tikzpicture', 'circuitikz']);
  const inl = T.findInlinePictures(SRC, envs);
  assert.deepStrictEqual(inl.map((p) => [p.begin.line, p.begin.col, p.end.line, p.end.col, p.inline]), [[8, 4, 8, 42, true], [11, 29, 11, 45, true]]);
  assert.strictEqual(SRC[8].slice(4, 42), '\\tikz[>latex]{ \\draw (0,0) -- (1,1); }');
  assert.strictEqual(SRC[11].slice(29, 45), '\\tikz \\node {z};');
});
t('allPictures: environments and inline pictures in the order of the source; the inline ones can be switched off', () => {
  const all = T.allPictures(SRC, ['tikzpicture'], true);
  assert.deepStrictEqual(all.map((p) => p.begin.line + (p.inline ? 'i' : 'e')), ['1e', '8i', '11i']);
  assert.deepStrictEqual(T.allPictures(SRC, ['tikzpicture'], false).map((p) => p.begin.line), [1]);
});
t('plan() for an inline picture in a table cell: the file gets the code, the text gets \\localinput', () => {
  const inl = T.findInlinePictures(SRC, T.findPictures(SRC, ['tikzpicture']))[0];
  const p = T.plan(SRC, inl, 'Cell.tikz', '\n');
  assert.strictEqual(p.content, '\\tikz[>latex]{ \\draw (0,0) -- (1,1); }\n');
  assert.strictEqual(p.replacement, '\\localinput{Cell.tikz}');
});
t('pictureAt: the cursor inside an inline picture picks it', () => {
  const all = T.allPictures(SRC, ['tikzpicture'], true);
  const at = T.pictureAt(SRC, all, { line: 8, col: 20 });
  assert.ok(at.pic && at.pic.inline && at.pic.begin.line === 8);
});
console.log('\n' + n + ' tests passed');
