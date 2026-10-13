'use strict';
/* Tests of the pure parts of the panels "Macro gallery", "Formulas of the project" and of the command "Copy formula":
 * macroGalleryPure.js (calls, MathJax state), formulaOverviewPure.js (refs, entries), formulaCopyPure.js (formulaAt, MathML).
 * Run from the repository root: node tests/macroGallery.test.js [extension] */
const assert = require('assert');
const path = require('path');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const MP = require(path.join(EXT, 'macrosPure.js'));
const G = require(path.join(EXT, 'macroGalleryPure.js'));
const O = require(path.join(EXT, 'formulaOverviewPure.js'));
const F = require(path.join(EXT, 'formulaCopyPure.js'));
const katex = require(path.join(EXT, 'media', 'katex', 'katex.min.js'));

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };

/* ------------------------------ macro gallery ------------------------------ */
const SRC = String.raw`
% напруженість поля
\newcommand{\vect}[1]{\mathbf{#1}}
\newcommand{\E}[1][E]{\mathbf{#1}}
\NewDocumentCommand{\dd}{s o m}{\mathrm{d}#3}
\DeclareMathOperator{\grad}{grad}
\newtheorem{law}{Закон}
\newcommand{\emphx}[1]{\textbf{\emph{#1}}}
\newcommand{\lbl}[1]{\label{#1}\par}
\NewDocumentEnvironment{note}{m}{\begin{quote}}{\end{quote}}
`;
const entries = MP.scanMacros(SRC).map((e) => Object.assign(e, { file: '/p/a.cls' }));
const byName = (name) => entries.find((e) => e.name === name);
eq(G.exampleCalls(byName('vect')).map((x) => x.call), ['\\vect{x}'], 'one argument');
eq(G.exampleCalls(byName('E')).map((x) => x.call), ['\\E', '\\E[2]'], 'an optional argument: the plain call and the call with it');
eq(G.exampleCalls(byName('dd')).map((x) => x.call), ['\\dd{z}', '\\dd[2]{z}', '\\dd*{z}'], 'xparse: star and optional');
eq(G.exampleCalls(byName('grad')).map((x) => x.call), ['\\grad f(x)'], 'an operator');
eq(G.exampleCalls(byName('law'))[0].call, '\\begin{law} … \\end{law}', 'an environment');
eq(G.exampleCalls(byName('note'))[0].call, '\\begin{note}{x} … \\end{note}', 'an environment with an argument');

const mjInfo = G.mathjaxInfo([String.raw`\newcommand{\vect}[1]{\mathbf{#1}}
\newcommand{\E}[1][E]{\mathrm{#1}}`], entries);
const st = (name) => G.mathjaxState(byName(name), mjInfo).st;
eq(st('vect'), 'ok', 'in the file, the same as the generator writes');
eq(st('E'), 'differs', 'in the file with another body');
eq(st('emphx'), 'missing', 'not in the file');
eq(st('dd'), 'skip', 'MathJax cannot say it');
eq(st('lbl'), 'skip', '\\label and \\par cannot be said either');
eq(st('law'), 'na', 'an environment is not a MathJax macro');
eq(G.mathjaxState(byName('vect'), G.mathjaxInfo([], entries)).st, 'nofile', 'no macros file at all');

const all = { cmds: new Map(entries.filter((e) => e.kind === 'cmd').map((e) => [e.name, e])), envs: new Map(entries.filter((e) => e.kind === 'env').map((e) => [e.name, e])) };
const items = G.buildItems(all, ['/p/a.cls'], mjInfo, (s) => '<p>' + s + '</p>');
eq(items.length, entries.length, 'a card for every macro');
eq(items.map((i) => i.i), items.map((_, k) => k), 'the numbers are the order in the list (the page names a card by its number)');
const vect = items.find((i) => i.name === 'vect');
ok(vect.doc === 'напруженість поля' && vect.sig === '\\vect{#1}' && vect.examples[0].tex === '\\vect{x}' && vect.examples[0].html === '<p>\\vect{x}</p>' && vect.line > 1, JSON.stringify(vect));
const env = items.find((i) => i.name === 'law');
eq(env.examples[0].tex, '', 'an environment is not drawn by KaTeX');
ok(env.examples[0].html.includes('begin{law} Текст.'), 'but by the text converter, with a text inside');
eq(G.buildItems(all, ['/p/a.cls'], mjInfo, () => { throw new Error('x'); })[0].examples[0].html, '', 'a failing renderer leaves the card without a drawing, no crash');

/* ------------------------------ overview of formulas ------------------------------ */
eq([...O.refsOf('Див. \\ref{a}, \\eqref{b,c} \\cref{ d } \\autoref*{e} % \\ref{hid}\n\\pageref[x]{f} \\labelcref{g}')].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'labels of all kinds of references, none from comments');
eq([...O.refsOf('\\label{no} \\verb|x|')], [], '\\label is not a reference');
const files = [
  { path: 'a/a.tex', abs: '/p/a/a.tex', text: 'Див. \\eqref{e:one}.\n\\begin{equation}\\label{e:one} a=b \\end{equation}\n\\begin{align} x&=1 \\\\ y&=2\\label{e:two}\\end{align}\n\\begin{equation*} z \\end{equation*}\n\\begin{equation} w \\end{equation}\n' },
  { path: 'b/b.tex', abs: '/p/b/b.tex', text: '\\begin{equation}\\label{e:b} q \\end{equation}\n' }
];
const used = new Set();
files.forEach((f) => O.refsOf(f.text).forEach((l) => used.add(l)));
const aux = (abs, name) => ({ 'e:one': '1.1', 'e:two': '1.3', 'e:b': '2.1' }[name] || null);
const ent = O.buildEntries(files, { aux, used, render: (s) => '[' + s.length + ']' });
eq(ent.map((e) => [e.f, e.line, e.env, e.num]), [[0, 2, 'equation', '1.1'], [0, 3, 'align', '1.2–1.3'], [0, 4, 'equation*', ''], [0, 5, 'equation', '~1.4'], [1, 1, 'equation', '2.1']], 'files in the given order, numbers from aux (~ is an estimate), * has none');
eq(ent.map((e) => e.unused), [false, true, false, true, true], 'unused: numbered and no label is referred to');
eq(ent.map((e) => e.noLabel), [false, false, true, true, false], 'no label');
eq(ent.map((e) => e.numbered), [true, true, false, true, true]);
ok(ent[0].html.startsWith('[') && ent[0].endLine === 2, 'the source of the formula goes to the renderer');
eq(O.buildEntries(files, { aux, used, render: () => '', limit: 2 }).length, 2, 'the limit');

/* ------------------------------ copy formula ------------------------------ */
const T = 'Текст $a+b$ і \\[ x^2 \\] далі \\(c\\)\n\\begin{align}\n a&=b\\label{q} \\\\ c&=d\n\\end{align}\nціна 5\\$ і 6\\$ без формули\n$$ y $$\n';
const at = (frag) => F.formulaAt(T, T.indexOf(frag));
eq(at('a+b'), { start: 6, end: 11, tex: 'a+b', display: false }, '$..$');
eq(at('x^2').tex, 'x^2', '\\[..\\]'); ok(at('x^2').display, 'a block');
eq(at('c\\)').tex, 'c', '\\(..\\)'); ok(!at('c\\)').display);
eq(at('c&=d').tex, '\\begin{aligned}\n a&=b \\\\ c&=d\n\\end{aligned}', 'align -> aligned, \\label removed');
eq(F.formulaAt(T, T.indexOf('5\\$')), null, 'an escaped \\$ is not a delimiter');
eq(F.formulaAt(T, T.indexOf('Текст')), null, 'text');
eq(at(' y ').tex, 'y', '$$..$$'); ok(at(' y ').display);
eq(F.formulaAt('$a$ $b$', 5).tex, 'b', 'the formula that contains the caret, not the first one');
eq(F.formulaAt('$a\n\nb$', 1), null, 'a paragraph break inside $..$: not a formula');
eq(F.fromSelection(' $y$ '), { tex: 'y', display: false }, 'a selection with the delimiters');
eq(F.fromSelection('\\frac{a}{b}'), { tex: '\\frac{a}{b}', display: false }, 'a selected part');
eq(F.fromSelection('   '), null, 'nothing selected');
ok(/<mfrac>/.test(F.mathmlOf('\\frac{a}{b}', false, katex, {})) && /display="block"/.test(F.mathmlOf('x', true, katex, {})), 'MathML of KaTeX; block for display');
assert.throws(() => F.mathmlOf('\\nosuch', false, katex, {}), /KaTeX|nosuch/); n++;
ok(/mathvariant="bold"/.test(F.mathmlOf('\\vect{E}', false, katex, { '\\vect': '\\mathbf{#1}' })), 'the macros of the project are used');

console.log('macroGallery: ' + n + ' checks passed');
