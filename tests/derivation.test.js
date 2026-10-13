'use strict';
/* Tests of derivationPure.js: the rows of a derivation, what changed between neighbouring rows, the variants "rows 1..k".
 * The coloured TeX is checked against the real KaTeX of the extension (media/katex/katex.min.js).
 * Run from the repository root: node tests/derivation.test.js [extension] */
const assert = require('assert');
const path = require('path');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const D = require(path.join(EXT, 'derivationPure.js'));
const katex = require(path.join(EXT, 'media', 'katex', 'katex.min.js'));

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const renders = (tex) => { try { katex.renderToString(tex, { throwOnError: true, strict: 'ignore', macros: { '\\vect': '\\mathbf{#1}' } }); return true; } catch (e) { return false; } };
const C = '\\color{#e8590c}';
const R = '\\color{currentcolor}';
const mark = (cur, prev) => D.markPair(cur, prev);

// ---- rows
eq(D.splitRows('a &= b \\\\ &= c \\\\ &= d'), ['a &= b', '&= c', '&= d'], 'rows are cut by \\\\');
eq(D.splitRows('a &= b \\\\\n &= c \\\\'), ['a &= b', '&= c'], 'a trailing \\\\ gives no empty row');
eq(D.splitRows('a &= \\begin{cases} 1 \\\\ 2 \\end{cases} \\\\ &= c'), ['a &= \\begin{cases} 1 \\\\ 2 \\end{cases}', '&= c'], '\\\\ inside an environment does not cut');
eq(D.splitRows('a &= \\frac{1}{{2 \\\\ 3}} \\\\ &= c'), ['a &= \\frac{1}{{2 \\\\ 3}}', '&= c'], '\\\\ inside braces does not cut');
eq(D.splitRows('a &= b \\\\[2mm] &= c \\\\* &= d'), ['a &= b', '&= c', '&= d'], 'the space after \\\\ is not a part of a row');
eq(D.splitRows('a &= b \\label{x} \\nonumber \\\\ &= c \\tag{1}'), ['a &= b', '&= c'], '\\label, \\nonumber, \\tag leave the row');
eq(D.splitRows('a &= b % c \\\\ d\n \\\\ &= e'), ['a &= b', '&= e'], 'a comment ends the line');
eq(D.splitRows('a &= b \\% c \\\\ &= e'), ['a &= b \\% c', '&= e'], '\\% is not a comment');

// ---- what is marked
eq(mark('a+b', 'a+b'), 'a+b', 'equal rows: nothing is marked');
eq(mark('a=b+d', 'a=b+c'), 'a=b+' + C + 'd' + R, 'one symbol');
eq(mark('a=b', 'a=b+c'), 'a=b', 'something that only disappeared marks nothing in the new row');
eq(mark('x^2+y^2', 'x^2+z^2'), 'x^2+' + C + 'y^2' + R, 'a nucleus with its script is one atom');
eq(mark('p_x^2+p_y^2', 'p_x^2+p_z^2'), 'p_x^2+p_{' + C.replace('\\color', '\\color') + 'y}^2', 'same base and scripts: only the changed index is coloured (in braces)');
eq(mark('\\frac{1}{2m}', '\\frac{1}{2M}'), '\\frac{1}{2' + C + 'm' + R + '}', 'inside the argument of \\frac');
eq(mark('\\left(a+b\\right)^2', '\\left(a+c\\right)^2'), '\\left(a+' + C + 'b' + R + '\\right)^2', 'inside \\left..\\right');
eq(mark('12+3.5', '13+3.5'), C + '12' + R + '+3.5', 'a number is one atom, a decimal too');
eq(mark('a-b', 'a+b'), 'a' + C + '-' + R + 'b', 'an operator keeps its place (a declaration, not a group: the spacing stays)');
eq(mark('\\vect{E}\\cdot\\vect{n}', '\\vect{E}\\cdot\\vect{m}'), '\\vect{E}\\cdot\\vect{' + C + 'n' + R + '}', 'a command of the project with a group is compared inside');
eq(mark('\\sqrt[3]{x}+1', '\\sqrt[3]{y}+1'), '\\sqrt[3]{' + C + 'x' + R + '}+1', 'the optional argument of \\sqrt stays');
eq(mark('a &= b', null), 'a &= b', 'no neighbour: as it is');
eq(mark('&= b+d', 'a &= b+c'), '&= b+' + C + 'd' + R, 'a row that goes on from the left side is compared by what stands after &, the left side is not "lost"');
eq(mark('a &= b+d', '&= b+c'), 'a &= b+' + C + 'd' + R, 'the same the other way round');
ok(!mark('a &= b', 'a &= c').includes(C + '&'), '& is never coloured');

// ---- the result is TeX that KaTeX takes whenever both rows are fine
const corpus = ['\\frac{1}{2}mv^2', '\\frac{1}{2}m(v_x^2+v_y^2)', '\\sum_{i=1}^{N} q_i \\vec{r}_i', '\\sum_{i=1}^{N} q_i \\vec{r}_j', '\\int_0^R \\rho(r)\\,4\\pi r^2\\,\\mathrm{d}r', '\\int_0^R \\rho_0 4\\pi r^2\\,\\mathrm{d}r',
  '\\left(\\frac{a}{b}\\right)^{2}', '\\left(\\frac{a}{c}\\right)^{3}', '\\sqrt[3]{x^2+1}', '\\sqrt{x^2+2}', 'a_{ij}^{kl}', 'a_{ij}^{km}', '\\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}',
  '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', "x'+y''", '\\mathbf{E}=-\\nabla\\varphi', '\\mathbf{E}=-\\frac{\\partial\\mathbf{A}}{\\partial t}', 'e^{-x^2/2}', 'e^{-y^2/2}', '\\text{при } x>0',
  '\\operatorname{tr}A', '2.5\\cdot10^{-3}', '25\\cdot10^{-3}', '{}^{14}_{6}C', '\\overline{x}+\\hat{y}', '\\overline{z}+\\hat{y}', '\\vect{E}=\\vect{F}/q', '\\vect{E}=\\vect{G}/q', 'x^\\alpha y_\\beta', 'x^\\gamma y_\\beta', '\\frac12+\\frac34', '\\frac13+\\frac34', '\\left.\\frac{d f}{d x}\\right|_{x=0}', '\\ce{H2O}'];
let pairs = 0;
for (const a of corpus) {
  for (const b of corpus) {
    if (!renders(a) || !renders(b)) continue;
    for (const [x, y, lhs] of [[a, b, false], ['x &= ' + a, '&= ' + b, true]]) {
      const m = mark(x, y);
      if (lhs) { ok(/^x &= /.test(m) && renders(m.replace('&=', '=')), 'the left side stays and the rest renders: ' + m); continue; }
      ok(renders(m), 'colour breaks the TeX: ' + x + ' | ' + y + ' => ' + m);
      ok(m.replace(/\\color\{[^}]*\}/g, '') === x.replace(/\s+/g, '') || m.replace(/\\color\{[^}]*\}/g, '').replace(/\s+/g, '') === x.replace(/\s+/g, '') || m.replace(/\\color\{[^}]*\}|[{}]/g, '').replace(/\s+/g, '') === x.replace(/[{}]/g, '').replace(/\s+/g, ''), 'colour only: the text of the row is the same: ' + m);
      pairs++;
    }
  }
}
ok(pairs > 800, 'many pairs: ' + pairs);

// ---- stepsFor
eq(D.stepsFor('align', 'a &= b'), null, 'one row: no derivation');
eq(D.stepsFor('equation', 'a=b'), null, 'a plain equation');
eq(D.stepsFor('equation', 'a=b \\\\ c'), null, 'an equation that is not aligned/split inside');
eq(D.stepsFor('multline', 'a \\\\ b'), null, 'multline is one formula, not a derivation');
let r = D.stepsFor('align', 'a &= b+c \\\\ &= b+d \\\\ &= e');
eq(r.count, 3);
eq(r.plain, '\\begin{aligned}a &= b+c \\\\ &= b+d \\\\ &= e\\end{aligned}', 'plain: all rows, no colour');
ok(r.full.includes(C + 'd' + R) && r.full.includes(C + 'e' + R) && !r.full.includes('c' + R), 'full: every row against the row above');
eq(r.steps.length, 3, 'a variant for every row');
ok(r.steps[0] === '\\begin{aligned}a &= b+c\\end{aligned}', 'step 1: the first row');
ok(r.steps[1].includes('\\color{#c2255c}c' + R) && r.steps[1].includes(C + 'd' + R), 'step 2: what the row 1 loses (second colour) and what the row 2 adds');
ok(!r.steps[2].includes('#c2255c}a'), 'step 3: the left side of the first row is not "lost"');
ok(r.steps.every(renders) && renders(r.full) && renders(r.plain), 'everything renders');
r = D.stepsFor('equation', '\\begin{aligned} a&=b \\\\ &=c \\end{aligned}');
eq(r && r.count, 2, 'aligned inside equation');
r = D.stepsFor('equation*', '\\begin{split} a&=b \\\\ &=c \\\\ &=d \\end{split}');
eq(r && r.count, 3, 'split inside equation*');
r = D.stepsFor('gather', 'a=b \\\\ c=d');
ok(r.plain.startsWith('\\begin{gathered}'), 'gather -> gathered');
r = D.stepsFor('alignat', '{2} a&=b&c&=d \\\\ a&=e&c&=d');
eq(r && r.count, 2, 'alignat: the column count is not a row');
const many = Array.from({ length: 30 }, (_, i) => '&= ' + i).join(' \\\\ ');
r = D.stepsFor('align', 'a ' + many);
eq(r.steps, [], 'more than 24 rows: no step variants');
ok(r.full.length > 0, 'but the full view stays');
eq(D.stepsFor('align', Array.from({ length: 70 }, (_, i) => 'a_' + i + '=b').join(' \\\\ ')), null, 'more than 60 rows: not compared');

// ---- robustness: nothing throws on odd input
for (const odd of ['', '{', '}', '\\left(', '\\right)', '\\begin{x}', '\\end{x}', '^', '_', 'a^', 'a_{', '\\frac', '\\frac{1', '\\\\', '\\', '$', '%', 'x\'\'\'', '\\sqrt[', '\\left( \\right', '{{{{', '}}}}', 'a^^b', '\\begin{a}\\begin{b}\\end{a}']) {
  assert.doesNotThrow(() => { D.markPair(odd, 'a+b'); D.markPair('a+b', odd); D.markPair(odd, odd); D.stepsFor('align', odd + ' \\\\ ' + odd); }, 'must not throw on ' + JSON.stringify(odd));
  n++;
}
const big = Array.from({ length: 400 }, (_, i) => 'x_' + i).join('+');
const t0 = Date.now();
D.markPair(big, big.replace('x_200', 'y'));
ok(Date.now() - t0 < 1500, 'a long row is fast enough: ' + (Date.now() - t0) + ' ms');

console.log('derivation: ' + n + ' checks passed');
