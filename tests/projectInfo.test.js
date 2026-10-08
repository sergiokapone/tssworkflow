'use strict';
// node tests/projectInfo.test.js [path/to/extension]  - the vscode-free helpers: projectInfoPure.js, corePure.js, macrosPure.js
const path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const P = require(path.join(dir, 'corePure.js'));
const X = require(path.join(dir, 'projectInfoPure.js'));
const M = require(path.join(dir, 'macrosPure.js'));

let pass = 0;
const fails = [];
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(name + '\n    ' + String(e.message).split('\n').join('\n    ')); }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error((msg ? msg + ': ' : '') + 'expected ' + y + '\n    got      ' + x);
};
const frame = (lines, rules, opts) => P.frameSections(lines, rules || {}, Object.assign({ blank: true }, opts || {}));
const RULE_S = '%% ' + '-'.repeat(56);
const RULE_E = '% ' + '='.repeat(56);
const DOTS = '% ' + '.'.repeat(57);

/* ------------------------------ frames ------------------------------ */
test('isRuleLine: all the rule characters, including the dot', () => {
  for (const ch of '-=*#_~.') eq(P.isRuleLine('% ' + ch.repeat(10)), true, ch);
  eq(P.isRuleLine('% ...'), false);
  eq(P.isRuleLine('% текст ------------'), false);
});
test('frames: section and equation get the default rules', () => {
  const r = frame(['Текст', '\\section{A}', 'ще', '\\begin{equation}', 'x', '\\end{equation}']);
  eq(r.lines, ['Текст', '', RULE_S, '\\section{A}', RULE_S, '', 'ще', RULE_E, '\\begin{equation}', 'x', '\\end{equation}', RULE_E]);
});
test('frames: a dotted rule from frameRules is accepted for equations', () => {
  const r = frame(['\\begin{equation}', 'x', '\\end{equation}'], { equation: DOTS });
  eq(r.lines[0], DOTS);
});
test('frames: \\section{..}\\hypertarget{..}{} (pandoc style) is framed, not skipped', () => {
  const r = frame(['\\section{A}\\hypertarget{x}{}']);
  eq(r.stat.skipped, 0);
  eq(r.stat.sections, 1);
});
test('frames: \\hypertarget{..}{} above and \\label below stay inside the frame', () => {
  const r = frame(['\\hypertarget{x}{}', '\\section{A}', '\\label{s}', 'Текст']);
  eq(r.lines.slice(0, 5), [RULE_S, '\\hypertarget{x}{}', '\\section{A}', '\\label{s}', RULE_S]);
});
test('frames: text after the heading on the same line is skipped', () => {
  eq(frame(['\\section{A} текст далі']).stat.skipped, 1);
});
test('frames: second run changes nothing', () => {
  const a = frame(['\\section{A}', '', '\\begin{equation}', 'x', '\\end{equation}']);
  const b = frame(a.lines);
  eq(b.count, 0);
  eq(b.stat.already, 2);
});
test('frames: verbatim is left alone', () => {
  const r = frame(['\\begin{verbatim}', '\\section{A}', '\\end{verbatim}']);
  eq(r.count, 0);
});
test('frames: a key set to "" switches the block off', () => {
  eq(frame(['\\begin{equation}', 'x', '\\end{equation}'], { formulas: '' }).count, 0);
});
test('frames: specific key beats headings/formulas', () => {
  const r = frame(['\\begin{align}', 'x', '\\end{align}'], { formulas: DOTS, align: RULE_E });
  eq(r.lines[0], RULE_E);
});
test('frames: custom environments (frameEnvironments) with their own and the "environments" rule', () => {
  const src = ['\\begin{SCfigure}', 'a', '\\end{SCfigure}', '', '\\begin{theorem}', 'b', '\\end{theorem}'];
  const r = frame(src, { SCfigure: DOTS, environments: RULE_E }, { envs: ['SCfigure', 'theorem'] });
  eq(r.lines[0], DOTS);
  eq(r.lines[r.lines.indexOf('\\begin{theorem}') - 1], RULE_E);
  eq(frame(src).count, 0, 'without envs nothing is framed');
});
test('re-frame: old rules are replaced by the new ones, blank lines are not multiplied', () => {
  const old = [RULE_E, '\\begin{equation}', 'x', '\\end{equation}', RULE_E, 'Отже,', RULE_E, '\\begin{equation*}', 'y', '\\end{equation*}', RULE_E];
  const r = frame(old, { equation: DOTS }, { replace: true });
  eq(r.lines, old.map((l) => (l === RULE_E ? DOTS : l)));
  eq(r.stat.replaced, 2);
  eq(frame(r.lines, { equation: DOTS }, { replace: true }).count, 0, 'idempotent');
});
test('re-frame: a heading keeps exactly one blank line around the new rules', () => {
  const old = ['Текст', '', '%% ' + '='.repeat(10), '\\section{A}', '%% ' + '='.repeat(10), '', 'Далі'];
  const r = frame(old, {}, { replace: true });
  eq(r.lines, ['Текст', '', RULE_S, '\\section{A}', RULE_S, '', 'Далі']);
});
test('re-frame: a block with only the top rule gets both new rules', () => {
  const r = frame([RULE_E, '\\begin{equation}', 'x', '\\end{equation}', 'Текст'], {}, { replace: true });
  eq(r.lines, [RULE_E, '\\begin{equation}', 'x', '\\end{equation}', RULE_E, 'Текст']);
});

/* -------------------------------- aux -------------------------------- */
test('parseAux: number, page and title; cleveref duplicates ignored', () => {
  const aux = '\\newlabel{eq:A}{{3.14}{24}{Назва}{equation.3.14}{}}\n\\newlabel{eq:A@cref}{{[equation][14][3]3.14}{[1][23][]24}}\n\\newlabel{pic:B}{{2.1}{5}{}{figure.2.1}{}}';
  const m = X.parseAux(aux);
  eq(m.get('eq:A'), { num: '3.14', page: '24', title: 'Назва' });
  eq(m.get('pic:B').page, '5');
  eq(m.has('eq:A@cref'), false);
});
test('parseAux: \\relax and nested braces', () => {
  eq(X.parseAux('\\newlabel{t}{{\\relax 1.2}{7}{{\\relax Заг}}{x}{}}').get('t').num, '1.2');
});
test('auxInputs', () => eq(X.auxInputs('\\@input{a/a.aux}\n\\@input{b.aux}'), ['a/a.aux', 'b.aux']));

/* ------------------------------ statistics ---------------------------- */
test('countWords: no math, comments, arguments of \\label / \\ref; hyphenated word is one', () => {
  eq(X.countWords('Привіт \\emph{світе} $x^2$ \\label{a} \\ref{b} % коментар\n\\begin{equation} a b c \\end{equation} слово-слово 12'), 3);
});
test('fileStats: sections add up to the total', () => {
  const t = '\\chapter{A}\nтекст раз два\n\\section{B}\nслово \\begin{figure}x\\end{figure} \\begin{equation}a\\end{equation}\n';
  const f = X.fileStats(t, {});
  eq(f.rows.reduce((a, r) => a + r.st.words, 0), f.total.words);
  eq(f.total.figures, 1);
  eq(f.total.eqNum, 1);
});
test('textStats: starred formulas, \\[ \\], extra counters', () => {
  const s = X.textStats('\\begin{equation*}a\\end{equation*} \\[b\\] \\begin{problem}x\\end{problem}', { Задачі: '\\\\begin\\{problem\\}' });
  eq(s.eqStar, 2);
  eq(s.extra['Задачі'], 1);
});

/* --------------------------------- TODO ------------------------------- */
test('scanTodos: keywords in comments, \\todo, not in text', () => {
  const r = X.scanTodos('a % TODO: зробити\n\\todo{ще}\nb % FIXME x\nTODO без коментаря\nc % нічого', ['TODO', 'FIXME']);
  eq(r.map((x) => x.kw + ':' + x.text), ['TODO:зробити', 'TODO:ще', 'FIXME:x']);
});
test('scanTodos: Cyrillic keyword, no match inside a longer word', () => {
  eq(X.scanTodos('% ПЕРЕВІРИТИ формулу\n% TODOS не позначка', ['ПЕРЕВІРИТИ', 'TODO']).length, 1);
});

/* ------------------------------ typography ---------------------------- */
const typo = (lines, o) => X.typographyChecks(lines, o || {}).map((x) => x.code + ':' + lines[x.line].substr(x.col, x.len));
test('typography: space between a number and a unit', () => {
  eq(typo(['Довжина 5 см і 3~кг і 2\\,с і 7 сторін.']), ['typo-nbsp:5 см']);
});
test('typography: abbreviations before a number or a reference', () => {
  eq(typo(['див. рис. 3 і п. \\ref{x}, але ст. Київ']), ['typo-nbsp:рис. ', 'typo-nbsp:п. ']);
});
test('typography: number before р. / тис. / грн', () => {
  eq(typo(['1990 р. і 5 тис. грн']), ['typo-nbsp:1990 р.', 'typo-nbsp:5 тис.']);
});
test('typography: hyphen and double hyphen instead of the dash', () => {
  eq(typo(['Тут - дефіс, а тут -- півтире, тут --- норма.']), ['typo-dash: - ', 'typo-dash: -- ']);
});
test('typography: a word mixing Cyrillic and Latin; fix with look-alikes', () => {
  eq(typo(['Mагнітне поле, hello, магнітне']), ['typo-mixed-script:Mагнітне']);
  eq(X.fixHomoglyphs('Mагнітне'), 'Магнітне');
  eq(X.fixHomoglyphs('bагнітне'), null, 'b has no Cyrillic look-alike');
});
test('typography: formulas, math environments, comments, verbatim are not checked', () => {
  eq(typo(['$5 см$ і \\(3 с\\)', '\\begin{equation}', '5 см', '\\end{equation}', '% 5 см', '\\begin{verbatim}', '5 см', '\\end{verbatim}']), []);
});
test('typography: inline formula that continues on the next line', () => {
  eq(typo(['Формула $a = b +', 'c см$ і далі 5 см тут.']), ['typo-nbsp:5 см']);
});
test('typography: \\vec / \\vect mixed, the rarer one is marked', () => {
  const r = typo(['\\vect a \\vect b \\vec c'], { mixedMacros: [['vec', 'vect']] });
  eq(r, ['typo-mixed-macro:\\vec']);
  eq(typo(['\\vect a \\vect b'], { mixedMacros: [['vec', 'vect']] }), []);
});

/* ------------------------ equations nobody refers to ------------------ */
test('numberedEquations: referenced, unreferenced, without label', () => {
  const eqs = ['\\begin{equation}\\label{a}', 'x', '\\end{equation}', '\\begin{align}', 'y\\label{b}', '\\end{align}', '\\begin{equation}', 'z', '\\end{equation}', '\\begin{equation*}', 'w', '\\end{equation*}'];
  const r = X.numberedEquations(eqs, new Set(['a']));
  eq(r.map((x) => [x.env, x.candidate]), [['equation', false], ['align', true], ['equation', true]]);
});
test('numberedEquations: \\tag keeps the equation out of the candidates', () => {
  eq(X.numberedEquations(['\\begin{equation}', 'x\\tag{1}', '\\end{equation}'], new Set())[0].candidate, false);
});
test('starEquation: star environment, label removed, label-only line dropped', () => {
  const lines = ['\\begin{equation}', '\\label{q}', 'x', '\\end{equation}'];
  eq(X.starEquation(lines, { line: 0, endLine: 3, env: 'equation', beginCol: 0 }), ['\\begin{equation*}', 'x', '\\end{equation*}']);
  const l2 = ['\\begin{align}', 'y\\label{b} \\\\', 'z', '\\end{align}'];
  eq(X.starEquation(l2, { line: 0, endLine: 3, env: 'align', beginCol: 0 }), ['\\begin{align*}', 'y \\\\', 'z', '\\end{align*}']);
});

/* --------------------------------- macros ----------------------------- */
test('scanMacros: \\newcommand with an argument', () => {
  const r = M.scanMacros('\\newcommand{\\vect}[1]{\\symbf{#1}}');
  eq(r.length, 1);
  eq(r[0].name, 'vect');
  eq(r[0].nargs, 1);
});

/* ------------------------ texlogsieve Output report -------------------- */
test('formatTexlogsieveReport: sections in fixed order, sorted by file and line, aligned', () => {
  const e = [
    { kind: 'BadBox', file: 'a/a.tex', line: 52, message: 'Overfull \\hbox (14.7pt too wide)' },
    { kind: 'Warning', file: 'b/b.tex', line: 4, message: 'W2' },
    { kind: 'Error', file: 'a/a.tex', line: 196, message: 'Undefined   control\nsequence.' },
    { kind: 'Warning', file: 'a/a.tex', line: 11, message: 'W1' },
    { kind: 'Warning', file: 'a/a.tex', line: 2, message: 'W0' }
  ];
  const r = P.formatTexlogsieveReport(e, { job: 'main', time: '12:00:00' });
  eq(r[0].indexOf('══ texlogsieve · main.log · 12:00:00 ═'), 0);
  eq(r[1], 'помилок: 1 · попереджень: 3 · overfull/underfull: 1');
  const at = (t) => r.findIndex((l) => l.indexOf(t) === 3);
  eq(at('ПОМИЛКИ (1)') < at('ПОПЕРЕДЖЕННЯ (3)') && at('ПОПЕРЕДЖЕННЯ (3)') < at('OVERFULL / UNDERFULL (1)'), true);
  eq(r.filter((l) => /^  \S/.test(l)).map((l) => l.trim().split(/\s{2,}/)[0]),
    ['a/a.tex:197', 'a/a.tex:3', 'a/a.tex:12', 'b/b.tex:5', 'a/a.tex:53']);
  eq(r.some((l) => l.endsWith('Undefined control sequence.')), true, 'whitespace collapsed');
});
test('formatTexlogsieveReport: location without a line, empty report, outside counter', () => {
  const r = P.formatTexlogsieveReport([{ kind: 'Missing', file: 'a/a.tex', line: null, message: 'x' }], {});
  eq(r.some((l) => l === '  a/a.tex  x'), true);
  const z = P.formatTexlogsieveReport([], { outside: 8 });
  eq(z[1], '✓ Проблем у файлах проєкту немає');
  eq(z[2], '(ще 8 попереджень з пакетів TeX-дерева відкинуто)');
  eq(z.length, 3);
});

console.log(pass + ' passed, ' + fails.length + ' failed');
fails.forEach((f) => console.log('\nFAIL ' + f));
process.exit(fails.length ? 1 : 0);
