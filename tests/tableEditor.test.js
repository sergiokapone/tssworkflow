'use strict';
// node tests/tableEditor.test.js [path/to/extension]  - tableEditorPure.js: tabularray mode=, the Z selector; macrosPure.toKatexMacros
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const T = require(path.join(ext, 'tableEditorPure.js'));
const MP = require(path.join(ext, 'macrosPure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

// the modes of every cell, row by row
const modes = (src) => {
  const env = T.locateTables(src)[0];
  const r = T.parseTable(src, env);
  assert.ok(r.model, r.skip);
  return T.toView(r.model, new Map()).rows.map((row) => row.cells.map((c) => c.style.mode));
};

const MAXWELL = String.raw`\begin{tblr}{
  colspec = {Q[l,m,4cm]X[l,m]Q[l,m,4cm]},
  row{1} = {c, font=\bfseries},
  cell{2-5}{2-Z} = {l, m, mode=dmath, font=\small},
  hlines
}
A & B & C \\
Gauss & \oiint\limits_S \Bfield\cdot d\vect{S} = 0 & \divg\Bfield = 0 \\
Faraday & \oint\limits_L \Efield\cdot d\vect{r} = 0 & \rot\Efield = 0 \\
\end{tblr}`;

t('cell{2-5}{2-Z}: mode=dmath reaches columns 2..last of rows 2..5 only', () => {
  assert.deepStrictEqual(modes(MAXWELL), [['', '', ''], ['', 'dmath', 'dmath'], ['', 'dmath', 'dmath']]);
});

t('mode= in colspec, column{}, row{}: later rules win, imath is math, text switches off', () => {
  const src = String.raw`\begin{tblr}{colspec={Q[l,mode=dmath]Q[c]Q[r]}, column{3}={mode=text}, row{2}={mode=imath}}
a & b & c \\
x & y & z \\
1 & 2 & 3 \\
\end{tblr}`;
  assert.deepStrictEqual(modes(src), [['dmath', '', 'text'], ['math', 'math', 'math'], ['dmath', '', 'text']]);
});

t('\\SetCell{mode=...} beats the rules, with and without [r=,c=]', () => {
  const src = String.raw`\begin{tblr}{colspec={ccc}, column{1}={mode=text}}
\SetCell{mode=dmath} a & b & c \\
\SetCell[c=2]{mode=math} d & & f \\
\end{tblr}`;
  const m = modes(src);
  assert.strictEqual(m[0][0], 'dmath');
  assert.strictEqual(m[1][0], 'math');
});

t('selectors: Z alone, an open range, odd; the last matching rule wins', () => {
  const src = String.raw`\begin{tblr}{colspec={cc}, row{Z}={mode=dmath}, row{2-}={mode=text}, column{odd}={mode=math}}
a & b \\
c & d \\
e & f \\
\end{tblr}`;
  const m = modes(src);
  assert.strictEqual(m[2][0], 'math');  // column{odd} is the last rule
  assert.strictEqual(m[2][1], 'text');  // row{2-} came after row{Z}
  assert.strictEqual(m[1][1], 'text');
  assert.strictEqual(m[0][1], '');      // row 1 matches nothing
});

t('a table without mode= and tabular have no modes at all', () => {
  assert.deepStrictEqual(modes(String.raw`\begin{tblr}{colspec={cc}}
a & b \\
\end{tblr}`), [['', '']]);
  assert.deepStrictEqual(modes(String.raw`\begin{tabular}{lcr}
a & b & c \\
\end{tabular}`), [['', '', '']]);
});

t('the text of the file is not touched by the view', () => {
  const env = T.locateTables(MAXWELL)[0];
  const r = T.parseTable(MAXWELL, env);
  T.toView(r.model, new Map());
  assert.strictEqual(T.serialize(r.model, MAXWELL, env), MAXWELL);
});

const STY = String.raw`\newcommand{\vect}[1]{\symbf{#1}}
\newcommand{\Bfield}{\vect{B}}
\newcommand{\divg}{\nabla\cdot}
\DeclareMathOperator{\rot}{rot}
\DeclareMathOperator*{\Lim}{lim}
\newcommand{\opt}[2][x]{#1#2}`;

t('toKatexMacros: commands with arguments, operators, starred operators', () => {
  const k = MP.toKatexMacros(MP.scanMacros(STY));
  assert.strictEqual(k['\\Bfield'], '\\mathbf{B}');
  assert.strictEqual(k['\\vect'], '\\mathbf{#1}');
  assert.strictEqual(k['\\divg'], '\\nabla\\cdot');
  assert.strictEqual(k['\\rot'], '\\operatorname{rot}');
  assert.strictEqual(k['\\Lim'], '\\operatorname*{lim}');
});

t('toKatexMacros: a default for the first argument cannot be expressed, so the macro is left out', () => {
  assert.ok(!('\\opt' in MP.toKatexMacros(MP.scanMacros(STY))));
});

t('toKatexMacros: no macros, no problem', () => {
  assert.deepStrictEqual(MP.toKatexMacros([]), {});
});

try {
  const katex = require(path.join(ext, 'media', 'katex', 'katex.min.js'));
  t('KaTeX renders the project macros without errors', () => {
    const k = MP.toKatexMacros(MP.scanMacros(STY));
    const html = katex.renderToString('\\displaystyle \\divg\\Bfield = 0 \\quad \\rot\\Bfield', { throwOnError: false, output: 'html', strict: 'ignore', macros: Object.assign({}, k) });
    assert.ok(/class="katex"/.test(html) && !/katex-error|#cc0000/.test(html));
  });
} catch (e) { console.log('skip KaTeX test: ' + e.message); }

console.log('\n' + n + ' tests passed');
