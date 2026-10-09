'use strict';
/* Tests of wrapEnvPure.js (pure) and of wrapEnv.js (with a stub of the vscode module).
 * Run from the repository root: node tests/wrapEnv.test.js */
const assert = require('assert');
const path = require('path');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const P = require(path.join(EXT, 'wrapEnvPure.js'));
const MP = require(path.join(EXT, 'macrosPure.js'));
const { runCommand } = require('./vscodeStub');
const fs = require('fs');
const os = require('os');

let n = 0;
const t = (name, fn) => { fn(); n++; };
const apply = (lines, edit) => lines.slice(0, edit.startLine).concat(edit.lines, lines.slice(edit.endLine + 1));
const W = (lines, a, b, o) => P.wrapLines(lines, { line: a[0], character: a[1] }, { line: b[0], character: b[1] }, Object.assign({ name: 'center', rest: '', unit: '\t', indent: true }, o));

t('parseEnvInput', () => {
  assert.deepStrictEqual(P.parseEnvInput('center'), { name: 'center', rest: '' });
  assert.deepStrictEqual(P.parseEnvInput(' equation* '), { name: 'equation*', rest: '' });
  assert.deepStrictEqual(P.parseEnvInput('minipage{0.5\\linewidth}'), { name: 'minipage', rest: '{0.5\\linewidth}' });
  assert.deepStrictEqual(P.parseEnvInput('figure [h!]'), { name: 'figure', rest: '[h!]' });
  assert.deepStrictEqual(P.parseEnvInput('\\begin{tabular}{ll}'), { name: 'tabular', rest: '{ll}' });
  assert.strictEqual(P.parseEnvInput(''), null);
  assert.strictEqual(P.parseEnvInput('1abc'), null);
  assert.strictEqual(P.parseEnvInput('two words'), null);
  assert.strictEqual(P.parseEnvInput('\\begin{a b}'), null);
});

t('catalogue is sane', () => {
  const names = P.STANDARD_ENVS.map((e) => e.name);
  assert.strictEqual(new Set(names).size, names.length, 'duplicate names');
  for (const e of P.STANDARD_ENVS) assert.deepStrictEqual(P.parseEnvInput(e.name + e.rest), { name: e.name, rest: e.rest }, e.name);
});

t('envNamesInText', () => {
  const txt = '\\begin{document}\n\\begin{tblr}{ll}\n% \\begin{hidden}\n\\begin{problem} \\begin{tblr}\\end{tblr}\n100\\% \\begin{figure*}\n';
  assert.deepStrictEqual(P.envNamesInText(txt), ['tblr', 'problem', 'figure*']);
});

t('argsOfMacro', () => {
  const src = '\\newenvironment{one}{}{}\n\\newenvironment{two}[2]{}{}\n\\newenvironment{opt}[2][x]{}{}\n' +
    '\\NewDocumentEnvironment{xp}{O{a} m m}{}{}\n\\newtheorem{thm}{Теорема}\n';
  const envs = new Map(MP.scanMacros(src).filter((e) => e.kind === 'env').map((e) => [e.name, e]));
  assert.strictEqual(P.argsOfMacro(envs.get('one')), '');
  assert.strictEqual(P.argsOfMacro(envs.get('two')), '{}{}');
  assert.strictEqual(P.argsOfMacro(envs.get('opt')), '{}');
  assert.strictEqual(P.argsOfMacro(envs.get('xp')), '{}{}');
  assert.strictEqual(P.argsOfMacro(envs.get('thm')), '');
});

t('wrap whole lines, indentation kept, body indented', () => {
  const L = ['text', '  a', '    b', '', '  c', 'tail'];
  const e = W(L, [1, 2], [4, 3]);
  assert.deepStrictEqual(apply(L, e), ['text', '  \\begin{center}', '\t  a', '\t    b', '', '\t  c', '  \\end{center}', 'tail']);
  assert.deepStrictEqual(e.cursor, { line: 1, character: '  \\begin{center}'.length });
});

t('selection that ends at column 0 leaves the next line alone', () => {
  const L = ['a', 'b', 'c'];
  const e = W(L, [0, 0], [2, 0]);
  assert.deepStrictEqual(apply(L, e), ['\\begin{center}', '\ta', '\tb', '\\end{center}', 'c']);
});

t('selection inside a line splits it', () => {
  const L = ['Before WORD after'];
  const e = W(L, [0, 7], [0, 11], { name: 'quote' });
  assert.deepStrictEqual(apply(L, e), ['Before', '\\begin{quote}', '\tWORD', '\\end{quote}', 'after']);
  assert.deepStrictEqual(e.cursor, { line: 1, character: '\\begin{quote}'.length });
});

t('only the start or only the end is in the middle of a line', () => {
  const L = ['  one two', '  three four'];
  assert.deepStrictEqual(apply(L, W(L, [0, 6], [1, 12])), ['  one', '  \\begin{center}', '\t  two', '\t  three four', '  \\end{center}']);
  assert.deepStrictEqual(apply(L, W(L, [0, 0], [1, 7])), ['  \\begin{center}', '\t  one two', '\t  three', '  \\end{center}', '  four']);
});

t('verbatim and indent=false do not indent', () => {
  const L = ['  x = 1', '  y = 2'];
  assert.deepStrictEqual(apply(L, W(L, [0, 0], [1, 7], { name: 'verbatim' })), ['  \\begin{verbatim}', '  x = 1', '  y = 2', '  \\end{verbatim}']);
  assert.deepStrictEqual(apply(L, W(L, [0, 0], [1, 7], { indent: false })), ['  \\begin{center}', '  x = 1', '  y = 2', '  \\end{center}']);
  assert.deepStrictEqual(apply(['ab cd'], W(['ab cd'], [0, 3], [0, 5], { name: 'verbatim' })), ['ab', '\\begin{verbatim}', 'cd', '\\end{verbatim}']);
});

t('spaces as the indentation unit; arguments; caret in the first {}', () => {
  const L = ['x'];
  const e = W(L, [0, 0], [0, 1], { name: 'minipage', rest: '{}', unit: '    ' });
  assert.deepStrictEqual(apply(L, e), ['\\begin{minipage}{}', '    x', '\\end{minipage}']);
  assert.deepStrictEqual(e.cursor, { line: 0, character: '\\begin{minipage}{'.length });
  const f = W(L, [0, 0], [0, 1], { name: 'figure', rest: '[h!]' });
  assert.deepStrictEqual(f.cursor, { line: 0, character: '\\begin{figure}[h!]'.length });
  const g = W(['  x'], [0, 0], [0, 3], { name: 'tabularx', rest: '{\\linewidth}{}' });
  assert.deepStrictEqual(g.cursor, { line: 0, character: '  \\begin{tabularx}{\\linewidth}{'.length });
});

t('countEnvs, labelFor, label line', () => {
  assert.deepStrictEqual([...P.countEnvs('\\begin{a}\\begin{a}\n% \\begin{x}\n\\begin{document}\\begin{b*}').entries()], [['a', 2], ['b*', 1]]);
  assert.deepStrictEqual(P.labelFor('figure*', { figure: 'pic:' }, 'x'), { prefix: 'pic:', where: 'end' });
  assert.deepStrictEqual(P.labelFor('problem', { problem: 'prb:' }, 'x'), { prefix: 'prb:', where: 'start' });
  assert.strictEqual(P.labelFor('problem', { problem: 'prb:' }, 'a \\label{x}'), null);
  assert.strictEqual(P.labelFor('center', { problem: 'prb:' }, 'x'), null);
  assert.strictEqual(P.labelFor('center', null, 'x'), null);
  const L = ['x'];
  const f = W(L, [0, 0], [0, 1], { name: 'figure', rest: '[h!]', label: { prefix: 'pic:', where: 'end' } });
  assert.deepStrictEqual(apply(L, f), ['\\begin{figure}[h!]', '\tx', '\t\\label{pic:}', '\\end{figure}']);
  assert.deepStrictEqual(f.cursor, { line: 2, character: '\t\\label{pic:'.length });
  const g = W(L, [0, 0], [0, 1], { name: 'problem', label: { prefix: 'prb:', where: 'start' } });
  assert.deepStrictEqual(apply(L, g), ['\\begin{problem}', '\t\\label{prb:}', '\tx', '\\end{problem}']);
});

t('overlaps', () => {
  const L = ['a b', 'c', 'd'];
  const a = W(L, [0, 0], [0, 1]);
  const b = W(L, [0, 2], [0, 3]);
  const c = W(L, [2, 0], [2, 1]);
  assert.strictEqual(P.overlaps([a, b]), true);
  assert.strictEqual(P.overlaps([a, c]), false);
});

/* ---- wrapEnv.js with a stub of vscode ---- */
(async () => {
  const run = (text, selections, pick, cfg, extra) => runCommand(Object.assign({ ext: EXT, module: 'wrapEnv.js', id: 'tssworkflow.wrapEnv', text, selections, pick, cfg }, extra));
  const problem = new Map([['problem', { name: 'problem', kind: 'env', tokens: [{ t: 'm', open: '{', close: '}', optional: false }], file: '/p/C.cls', line: 3 }]]);
  const problem0 = new Map([['problem', { name: 'problem', kind: 'env', tokens: [], file: '/p/C.cls', line: 3 }]]);
  let checks = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
  const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

  let r = await run('a\nb\nc', [[0, 0, 1, 1]], { name: 'center' }, {}, { envs: problem });
  eq(r.h.doc.lines, ['\\begin{center}', '\ta', '\tb', '\\end{center}', 'c']);
  eq(r.mem['tssworkflow.wrapEnv.recent'], [{ name: 'center', rest: '' }]);
  const labels = r.h.vs.window.shown.items.map((i) => (i.kind === -1 ? '--' + i.label : i.label));
  ok(labels.indexOf('--Проєкт (.cls / .sty)') >= 0 && labels.indexOf('problem') > labels.indexOf('--Проєкт (.cls / .sty)'), 'project group');
  ok(labels.indexOf('equation') > labels.indexOf('--Стандартні'), 'standard group');
  eq(r.h.vs.window.shown.items.find((i) => i.label === 'problem').pick.rest, '{}');

  r = await run('a\nb', [[0, 0, 0, 0]], { name: 'minipage' });
  eq(r.h.ed.snippet, '\\begin{minipage}{0.48\\linewidth}\n\t$0\n\\end{minipage}', 'snippet without a field');
  r = await run('a\nb', [[0, 0, 0, 0]], { name: 'tabular' });
  eq(r.h.ed.snippet, '\\begin{tabular}{$1}\n\t$0\n\\end{tabular}', 'snippet with a field inside {}');

  r = await run('a b c', [[0, 0, 0, 1], [0, 2, 0, 3]], { name: 'center' });
  ok(r.h.vs.warned && r.h.doc.lines.join('|') === 'a b c', 'overlapping selections are refused');

  r = await run('x\n\ny', [[0, 0, 0, 1], [2, 0, 2, 1]], { name: 'quote' });
  eq(r.h.doc.lines, ['\\begin{quote}', '\tx', '\\end{quote}', '', '\\begin{quote}', '\ty', '\\end{quote}']);
  eq(r.h.ed.selections.map((s) => s.start.line), [0, 4]);

  r = await run('x', [[0, 0, 0, 1]], { name: 'center' }, { 'wrapEnv.indent': false });
  eq(r.h.doc.lines, ['\\begin{center}', 'x', '\\end{center}']);

  r = await run('x', [[0, 0, 0, 1]], { typed: 'minipage{0.3\\linewidth}' });
  eq(r.h.doc.lines, ['\\begin{minipage}{0.3\\linewidth}', '\tx', '\\end{minipage}']);

  // \label from tssworkflow.labelPrefixes
  const pref = { labelPrefixes: { figure: 'pic:', problem: 'prb:' } };
  r = await run('\\includegraphics{a}\n\\caption{c}', [[0, 0, 1, 11]], { name: 'figure' }, pref);
  eq(r.h.doc.lines, ['\\begin{figure}[h!]', '\t\\includegraphics{a}', '\t\\caption{c}', '\t\\label{pic:}', '\\end{figure}']);
  eq([r.h.ed.selections[0].start.line, r.h.ed.selections[0].start.character], [3, '\t\\label{pic:'.length]);
  r = await run('text', [[0, 0, 0, 4]], { name: 'problem' }, pref, { envs: problem0 });
  eq(r.h.doc.lines, ['\\begin{problem}', '\t\\label{prb:}', '\ttext', '\\end{problem}']);
  r = await run('\\label{mine}', [[0, 0, 0, 12]], { name: 'problem' }, pref, { envs: problem0 });
  eq(r.h.doc.lines, ['\\begin{problem}', '\t\\label{mine}', '\\end{problem}'], 'an existing \\label is kept alone');
  r = await run('text', [[0, 0, 0, 4]], { name: 'problem' }, Object.assign({ 'wrapEnv.label': false }, pref), { envs: problem0 });
  eq(r.h.doc.lines, ['\\begin{problem}', '\ttext', '\\end{problem}'], 'wrapEnv.label=false');
  r = await run('a', [[0, 0, 0, 0]], { name: 'figure' }, pref);
  eq(r.h.ed.snippet, '\\begin{figure}[h!]\n\t$1\n\t\\label{pic:$0}\n\\end{figure}', 'figure snippet: body, then label');
  r = await run('a', [[0, 0, 0, 0]], { name: 'problem' }, pref, { envs: problem0 });
  eq(r.h.ed.snippet, '\\begin{problem}\n\t\\label{prb:$1}\n\t$0\n\\end{problem}', 'problem snippet: label, then body');

  // the group "Ще в проєкті": from all files, most used first, standard and project ones left out
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-'));
  const f1 = path.join(dir, 'a.tex'); const f2 = path.join(dir, 'b.tex');
  fs.writeFileSync(f1, '\\begin{foo}\\end{foo}\\begin{foo}\\begin{center}\\begin{problem}');
  fs.writeFileSync(f2, '\\begin{foo}\\begin{mybox}\\end{mybox}');
  r = await run('x \\begin{local}', [[0, 0, 0, 1]], { name: 'center' }, {}, { files: [f1, f2], envs: problem });
  const items = r.h.vs.window.shown.items;
  const gi = items.findIndex((i) => i.label === 'Ще в проєкті');
  ok(gi >= 0, 'project usage group exists');
  eq(items.slice(gi + 1, gi + 5).map((i) => i.label), ['foo', 'local', 'mybox', 'Стандартні'], 'most used first; center (standard) and problem (project) are not repeated');
  eq(items[gi + 1].detail, '3×');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('wrapEnv: ' + (n + checks) + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
