'use strict';
// node tests/tblr-tikz.test.js [path/to/extension]
// Format tblr keeps the lines of a cell with multi-line TikZ code (0.5.3); the other cells are formatted as before
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const N = require(path.join(ext, 'extra4Pure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const O = { maxWidth: 100, unit: '    ', tabSize: 4 };
const fmt = (s) => N.formatTblr(s, O);
const squash = (s) => s.replace(/\s+/g, '');

const TBL = [
  '\\begin{tblr}{colspec={c|c}}',
  '    \\tikz[>latex]{',
  '        \\node [] (0) at (0, -1) {};',
  '        \\draw[line width=2pt, gray] (0.center) to (1.center);',
  '        \\foreach \\n in {1,...,4} { \\draw[blue!40] (0, 0) ; }',
  '    }',
  '    & \\tikz[>latex]{ \\node [] (0) at (0, -1) {}; \\node [] (1) at (0, +1) {};',
  '        \\draw[thin, green!50!black] (0,0) -- (1,1);',
  '',
  '        \\draw[-{>}] (0,-0.1) -- ++(0, 0.5) node[left] {$\\vect{j}$}; } \\\\',
  '    $\\oint\\limits_L \\Bfield\\cdot d\\vect{r} = \\frac{4\\pi}c I$',
  '    & $\\oint\\limits_L \\Bfield\\cdot d\\vect{r} = 0$ \\\\',
  '\\end{tblr}',
  ''
].join('\n');

t('multi-line \\tikz cells keep their lines, the blank line inside stays, nothing is skipped', () => {
  const r = fmt(TBL);
  assert.deepStrictEqual(r.skipped, []);
  assert.strictEqual(squash(r.text), squash(TBL), 'only whitespace may change');
  assert.strictEqual(r.text.split('\n').length, TBL.split('\n').length);
  assert.ok(r.text.split('\n').includes(''), 'blank line inside the TikZ code kept');
});
t('layout: first cell at the row level, `& ` one level deeper, the rest of a cell deeper than the row', () => {
  const L = fmt(TBL).text.split('\n');
  assert.strictEqual(L[1], '    \\tikz[>latex]{');
  assert.ok(/^ {8}& \\tikz\[>latex\]\{ \\node/.test(L[L.findIndex((x) => x.includes('& \\tikz'))]));
  // the closing `}` stood less indented than the body: it is on the cell level, the body one level deeper
  assert.ok(L.slice(2, 5).every((x) => /^ {12}\S/.test(x)), L.slice(2, 5).join('|'));
  assert.strictEqual(L[5], '        }');
});
t('second run changes nothing; a one-level different indent of the input gives the same result', () => {
  const a = fmt(TBL).text;
  assert.strictEqual(fmt(a).text, a);
  const shifted = TBL.replace(/^ {4}/gm, '  ').replace(/^ {8}/gm, '      ');
  assert.strictEqual(fmt(shifted).text, a);
});
t('the closing line of a cell may be less indented than the body: relative indents are kept', () => {
  const r = fmt('\\begin{tblr}{colspec={c}}\n  \\tikz{\n      \\draw (0,0) -- (1,1);\n   }\n\\end{tblr}\n').text.split('\n');
  assert.strictEqual(r[1], '    \\tikz{');
  assert.ok(r[2].startsWith('        ') && r[3].startsWith('        '));
  assert.ok(r[2].length - r[2].trimStart().length > r[3].length - r[3].trimStart().length);
});
t('rows with multi-line TikZ do not switch the grid off for the other rows', () => {
  const r = fmt(['\\begin{tblr}{colspec={c|c}}', 'a & b \\\\', 'ccc & d \\\\', '\\tikz{', '  \\draw (0,0) -- (1,1);', '} & x \\\\', '\\end{tblr}', ''].join('\n')).text.split('\n');
  assert.strictEqual(r[1], '    a   & b \\\\');
  assert.strictEqual(r[2], '    ccc & d \\\\');
});
t('regression (0.5.1 output): a single-line \\tikz and a cell broken over lines are collapsed as before', () => {
  const src = '\\begin{tblr}{colspec={c|c}}\na & b \\\\\nlonger cell & \\tikz[baseline]{ \\draw (0,0) -- (1,1); } \\\\\n\\hline\nx &\n text\n spread \\\\\n\\end{tblr}\n';
  assert.strictEqual(fmt(src).text, [
    '\\begin{tblr}{colspec={c|c}}',
    '    a           & b                                        \\\\',
    '    longer cell & \\tikz[baseline]{ \\draw (0,0) -- (1,1); } \\\\',
    '    \\hline',
    '    x           & text spread                              \\\\',
    '\\end{tblr}',
    ''
  ].join('\n'));
  assert.strictEqual(fmt('\\begin{tblr}{colspec={c|c}}\n a&b \\\\\n cc & d \\\\\n\\end{tblr}\n').text, '\\begin{tblr}{colspec={c|c}}\n    a  & b \\\\\n    cc & d \\\\\n\\end{tblr}\n');
});
const comments = (s) => s.split('\n').map((l) => { const m = /(^|[^\\])%.*$/.exec(l); return m ? m[0].replace(/^[^%]*/, '') : null; }).filter(Boolean);
const CM = [
  '\\begin{tblr}{colspec={c|c}}',
  'a   % note about a',
  '& b \\\\',
  'c & \\tikz{',
  '  \\draw (0,0) -- (1,1); % diagonal',
  '} % end of cell',
  '\\\\',
  'd & e % last',
  '\\\\',
  '\\end{tblr}',
  ''
].join('\n');
t('a % inside a row (0.6.1) no longer skips the table: it is formatted, every comment stays on its own line end', () => {
  const r = fmt(CM);
  assert.deepStrictEqual(r.skipped, []);
  assert.strictEqual(squash(r.text), squash(CM));
  assert.deepStrictEqual(comments(r.text), comments(CM));
  assert.strictEqual(fmt(r.text).text, r.text);
});
t('after a cell that ends with a comment the next `&` and the row end start a new line, never inside the comment', () => {
  const L = fmt(CM).text.split('\n');
  for (const l of L) {
    const at = l.indexOf('%');
    if (at >= 0) assert.ok(!/&|\\\\/.test(l.slice(at)), 'nothing after the comment on: ' + l);
  }
  assert.ok(L.some((x) => /^\s+\\\\$/.test(x)), 'the row end sits on its own line: ' + L.join('|'));
});
t('a cell with a comment, the cell after it and the escaped \\% are kept apart', () => {
  const r = fmt('\\begin{tblr}{colspec={c|c}}\n 5\\% & x % why\n  y \\\\\n\\end{tblr}\n');
  assert.deepStrictEqual(r.skipped, []);
  assert.ok(r.text.includes('5\\%'));
  assert.deepStrictEqual(comments(r.text), ['% why']);
  assert.strictEqual(squash(r.text), squash('\\begin{tblr}{colspec={c|c}}\n 5\\% & x % why\n  y \\\\\n\\end{tblr}\n'));
});
t('a table without comments is formatted exactly as before', () => {
  assert.strictEqual(fmt('\\begin{tblr}{colspec={c|c}}\n a&b \\\\\n cc & d \\\\\n\\end{tblr}\n').text, '\\begin{tblr}{colspec={c|c}}\n    a  & b \\\\\n    cc & d \\\\\n\\end{tblr}\n');
});
console.log('\n' + n + ' tests passed');
