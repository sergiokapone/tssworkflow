'use strict';
// node tests/typography-code.test.js [path/to/extension]
// TikZ-like code and `% tss-ignore` lines are not text for the typography checks / the typography command (0.5.2, 0.6.0),
// tssworkflow.protectedCommands, and the "fix all" plan (0.6.0)
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const P = require(path.join(ext, 'corePure.js'));
const X = require(path.join(ext, 'projectInfoPure.js'));
let n = 0;
const t = (name, fn) => { P.setProtectedCommands([]); fn(); P.setProtectedCommands([]); n++; console.log('ok  ' + name); };
const rng = (s, extra) => P.tikzInlineRanges(s, extra).map(([a, b]) => s.slice(a, b));
const codes = (lines, o) => X.typographyChecks(lines, o || {}).map((x) => x.line + ':' + x.code + ':' + lines[x.line].substr(x.col, x.len));

/* ---------------------------- tikzInlineRanges ---------------------------- */
t('tikz: \\tikz[opts]{...} over several lines, braces and \\{ \\} counted correctly', () => {
  const s = 'a \\tikz[>latex]{ \\node {x}; \\draw (0,0) -- (1,1);\n  \\node {\\{}; } b';
  assert.deepStrictEqual(rng(s), ['\\tikz[>latex]{ \\node {x}; \\draw (0,0) -- (1,1);\n  \\node {\\{}; }']);
});
t('tikz: \\tikz \\draw ...; without braces ends at the first ; outside braces, not past a blank line', () => {
  assert.deepStrictEqual(rng('x \\tikz \\draw (0,0) -- (1,1); y -- z'), ['\\tikz \\draw (0,0) -- (1,1);']);
  assert.deepStrictEqual(rng('x \\tikz \\node {a;b}; y'), ['\\tikz \\node {a;b};']);
  assert.deepStrictEqual(rng('x \\tikz \\draw (0,0)\n\ny; z'), []);
});
t('tikz: \\tikzset, \\tikzstyle, \\pgfkeys, \\pgfmathsetmacro (two groups), \\tikzmath', () => {
  assert.deepStrictEqual(rng('\\tikzset{x/.style={a -- b}} t'), ['\\tikzset{x/.style={a -- b}}']);
  assert.deepStrictEqual(rng('\\tikzstyle{a}=[draw, a -- b] t'), ['\\tikzstyle{a}=[draw, a -- b]']);
  assert.deepStrictEqual(rng('\\pgfkeys{/a=b -- c} t'), ['\\pgfkeys{/a=b -- c}']);
  assert.deepStrictEqual(rng('\\pgfmathsetmacro{\\x}{1 - 2} t'), ['\\pgfmathsetmacro{\\x}{1 - 2}']);
  assert.deepStrictEqual(rng('\\tikzmath{ a = 1 - 2; } t'), ['\\tikzmath{ a = 1 - 2; }']);
});
t('tikz: other names are not matched; a comment and an unclosed brace give no range', () => {
  assert.deepStrictEqual(rng('\\tikzpicture \\tikzsomething{a - b} \\tikzsetx{a}'), []);
  assert.deepStrictEqual(rng('% \\tikz{ a -- b }\nтекст'), []);
  assert.deepStrictEqual(rng('\\tikz{ a -- b'), []);
});

/* ------------------------------ checks and fixes ------------------------------ */
const TBLR = [
  'Закон Біо-Савара встановлено (1820 р.) шляхом аналізу',
  '\\begin{tblr}{colspec={c|c}}',
  '  \\tikz[>latex, baseline]{ \\draw[gray!50] (0, -1) -- (0,1);',
  '      \\draw[-{>}] (0,-0.1) -- ++(0, 0.5) node[left] {$\\vect{j}$}; } & текст',
  '\\end{tblr}',
  'Далі - тире та 5 см.'
];
t('checks: -- inside \\tikz in a tblr cell is not a hint, the real hints stay', () => {
  assert.deepStrictEqual(codes(TBLR), ['0:typo-nbsp:1820 р.', '5:typo-dash: - ', '5:typo-nbsp:5 см']);
});
t('checks: columns of the hints are not shifted by the blanked code', () => {
  const l = ['\\tikz{ x -- y } і 5 см'];
  assert.deepStrictEqual(codes(l), ['0:typo-nbsp:5 см']);
});
t('typography(): code stays byte for byte, the text around is fixed; second run changes nothing', () => {
  const s = 'Текст \\tikz[baseline]{ \\draw (0,0) -- (1,1); \\node {a - b}; } і далі - тире.\n\\tikzset{x/.style={a -- b}} в 5 см.';
  const r = P.typography(s, {});
  assert.ok(r.text.includes('\\tikz[baseline]{ \\draw (0,0) -- (1,1); \\node {a - b}; }'));
  assert.ok(r.text.includes('\\tikzset{x/.style={a -- b}}'));
  assert.ok(/далі~---\s?тире/.test(r.text) || r.text.includes('далі ---'), r.text);
  assert.strictEqual(P.typography(r.text, {}).text, r.text);
});
t('typography(): text without code gives the same result as before (placeholder not left behind)', () => {
  const r = P.typography('слово - слово, 5 см', {});
  assert.ok(!/[\u0001\u0002\u0003\u0004]/.test(r.text));
});

/* --------------------------- protectedCommands (0.6.0) --------------------------- */
t('protectedCommands: parse ["mytikz", "\\\\myfig:2", garbage, "tikz"]', () => {
  assert.deepStrictEqual(P.parseProtectedCommands(['mytikz', '\\myfig:2', 'bad name', 'tikz', 5, 'x:0']), { mytikz: 1, myfig: 2, x: 1 });
  assert.deepStrictEqual(P.parseProtectedCommands('nope'), {});
});
t('protectedCommands: the argument of a listed command is code, one group by default, `name:2` takes two', () => {
  const s = 'a \\mytikz{x -- y} b \\myfig[o]{p}{q -- r} c {z}';
  assert.deepStrictEqual(rng(s), []);
  assert.deepStrictEqual(rng(s, ['mytikz', 'myfig:2']), ['\\mytikz{x -- y}', '\\myfig[o]{p}{q -- r}']);
  assert.deepStrictEqual(rng(s, ['myfig']), ['\\myfig[o]{p}']);
});
t('protectedCommands: setProtectedCommands drives checks and typography(); an empty list switches it off', () => {
  const L = ['\\mytikz{ a - b } і 5 см'];
  assert.deepStrictEqual(codes(L), ['0:typo-dash: - ', '0:typo-nbsp:5 см']);
  P.setProtectedCommands(['mytikz']);
  assert.deepStrictEqual(codes(L), ['0:typo-nbsp:5 см']);
  assert.ok(P.typography(L[0], {}).text.startsWith('\\mytikz{ a - b }'));
  P.setProtectedCommands([]);
  assert.deepStrictEqual(codes(L), ['0:typo-dash: - ', '0:typo-nbsp:5 см']);
});
t('protectedCommands: an explicit opts list overrides the stored one; a longer name wins over its prefix', () => {
  P.setProtectedCommands(['mytikz']);
  assert.deepStrictEqual(codes(['\\mytikz{ a - b }'], { protectedCommands: [] }), ['0:typo-dash: - ']);
  assert.deepStrictEqual(rng('\\mytikzx{a} \\mytikz{b}', ['mytikz', 'mytikzx']), ['\\mytikzx{a}', '\\mytikz{b}']);
});

/* ------------------------------- % tss-ignore ------------------------------- */
t('ignore: trailing marker = this line; -next and a bare marker on its own line = the next line', () => {
  const L = ['a 5 см % tss-ignore', 'b 5 см', '% tss-ignore-next', 'c 5 см', 'd 5 см', '% tss-ignore', 'e 5 см', 'f 5 см'];
  assert.deepStrictEqual(P.ignoreLineRanges(L), [[0, 0], [3, 3], [6, 6]]);
  assert.deepStrictEqual(codes(L).map((x) => x.split(':')[0]), ['1', '4', '7']);
});
t('ignore: -start ... -end block, a missing -end runs to the end of the file, a lone -end does nothing', () => {
  const L = ['a 5 см', '% tss-ignore-start', 'b 5 см', 'c 5 см', '% tss-ignore-end', 'd 5 см'];
  assert.deepStrictEqual(P.ignoreLineRanges(L), [[2, 3]]);
  assert.deepStrictEqual(codes(L).map((x) => x.split(':')[0]), ['0', '5']);
  assert.deepStrictEqual(P.ignoreLineRanges(['% tss-ignore-start', 'x', 'y']), [[1, 2]]);
  assert.deepStrictEqual(P.ignoreLineRanges(['x', '% tss-ignore-end', 'y']), []);
});
t('ignore: \\% is not a comment, "tss-ignored" is not a marker, case does not matter', () => {
  assert.deepStrictEqual(P.ignoreLineRanges(['5 см \\% tss-ignore']), []);
  assert.deepStrictEqual(P.ignoreLineRanges(['x % tss-ignored']), []);
  assert.deepStrictEqual(P.ignoreLineRanges(['x %TSS-Ignore']), [[0, 0]]);
});
t('ignore: the typography command leaves the ignored lines alone and fixes the rest', () => {
  const s = 'a - b % tss-ignore\nc - d\n% tss-ignore-next\ne - f\ng - h';
  const lines = P.typography(s, {}).text.split('\n');
  assert.strictEqual(lines[0], 'a - b % tss-ignore');
  assert.strictEqual(lines[3], 'e - f');
  assert.notStrictEqual(lines[1], 'c - d');
  assert.notStrictEqual(lines[4], 'g - h');
  assert.strictEqual(lines.length, 5);
});
t('ignore: a block that contains \\begin{equation} does not confuse the checks around it', () => {
  const L = ['% tss-ignore-start', '\\begin{equation}', '5 см', '\\end{equation}', 'тут 5 см', '% tss-ignore-end', 'а 5 см'];
  assert.deepStrictEqual(codes(L), ['6:typo-nbsp:5 см']);
  // an ignored block that opens a formula and never closes it still swallows the rest, as without the markers
  assert.deepStrictEqual(codes(['% tss-ignore-start', '\\begin{equation}', '% tss-ignore-end', 'а 5 см']), []);
});

/* --------------------------------- fix all plan --------------------------------- */
const FIXTXT = ['Довжина 5 см і ось - тире та 1990 р.', '% tss-ignore-next', 'Ще 5 см тут', 'Ось 5 см % tss-ignore', 'Далі 7 кг \\tikz{ \\draw (0,0) -- (1,1); } і 3 с.'];
t('plan: by default only the non-breaking spaces; code, ignored lines, and other hints stay', () => {
  const r = X.applyTypoFixes(FIXTXT);
  assert.strictEqual(r.count, 4);
  assert.deepStrictEqual(r.lines, ['Довжина 5~см і ось - тире та 1990~р.', FIXTXT[1], FIXTXT[2], FIXTXT[3], 'Далі 7~кг \\tikz{ \\draw (0,0) -- (1,1); } і 3~с.']);
});
t('plan: codes: ["typo-dash"] fixes the dash with spaces; unknown codes are ignored; second run changes nothing', () => {
  const r = X.applyTypoFixes(FIXTXT, { codes: ['typo-nbsp', 'typo-dash', 'typo-mixed-macro', 'whatever'] });
  assert.strictEqual(r.lines[0], 'Довжина 5~см і ось --- тире та 1990~р.');
  assert.strictEqual(X.applyTypoFixes(r.lines, { codes: ['typo-nbsp', 'typo-dash'] }).count, 0);
  assert.strictEqual(X.typoFixPlan(FIXTXT, { codes: [] }).length, 0);
});
t('plan: typo-mixed-script uses the look-alike table, a word without a look-alike is skipped', () => {
  const r = X.applyTypoFixes(['Mагнітне поле і bагнітне'], { codes: ['typo-mixed-script'] });
  assert.deepStrictEqual(r, { lines: ['Магнітне поле і bагнітне'], count: 1 });
});
t('plan: positions come from the current text, sorted and without overlaps', () => {
  const plan = X.typoFixPlan(['5 см 6 кг', 'а - б 7 с']);
  assert.deepStrictEqual(plan.map((e) => [e.line, e.col, e.text]), [[0, 0, '5~см'], [0, 5, '6~кг'], [1, 6, '7~с']]);
});
t('tables (documented in 7.9): the checks see the text of a cell and "fix all" fixes it, Ctrl+Alt+T leaves tables alone', () => {
  const L = ['\\begin{tblr}{colspec={c|c}}', '  довжина 5 см & текст \\\\', '\\end{tblr}'];
  assert.deepStrictEqual(codes(L), ['1:typo-nbsp:5 см']);
  assert.strictEqual(X.applyTypoFixes(L).lines[1], '  довжина 5~см & текст \\\\');
  assert.strictEqual(P.typography(L.join('\n'), {}).text.split('\n')[1], L[1]);
});
console.log('\n' + n + ' tests passed');
