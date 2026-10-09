'use strict';
/* Tests of wrapCmdPure.js (pure) and of wrapCmd.js (with a stub of vscode).
 * Run from the repository root: node tests/wrapCmd.test.js [extension] */
const assert = require('assert');
const path = require('path');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const C = require(path.join(EXT, 'wrapCmdPure.js'));
const MP = require(path.join(EXT, 'macrosPure.js'));
const { runCommand } = require('./vscodeStub');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };

// pure
eq(C.parseCmdInput('emph'), { name: 'emph', pre: '', open: '{', close: '}', post: '' });
eq(C.parseCmdInput('\\textcolor{red}'), { name: 'textcolor', pre: '{red}', open: '{', close: '}', post: '' });
eq(C.parseCmdInput('  href [x]{u} ').pre, '[x]{u}');
eq(C.parseCmdInput('emph x'), null);
eq(C.parseCmdInput('1'), null);
eq(C.parseCmdInput(''), null);
eq(C.wrapInline('E', { name: 'emph' }), { text: '\\emph{E}', cursor: 8 });
eq(C.wrapInline('E', { name: 'textcolor', pre: '{}' }), { text: '\\textcolor{}{E}', cursor: 11 });
eq(C.wrapInline('x', { name: 'frac', post: '{}' }), { text: '\\frac{x}{}', cursor: 9 });
eq(C.wrapInline('a\nb', { name: 'emph' }).text, '\\emph{a\nb}');
eq(C.wrapInline('x', { name: 'foo', open: '(', close: ')' }).text, '\\foo(x)');
const names = C.STANDARD_CMDS.map((c) => c.name);
eq(new Set(names).size, names.length, 'duplicate names');
for (const c of C.STANDARD_CMDS) eq(C.parseCmdInput(c.name + (c.pre || '')).name, c.name, c.name);

const src = '\\newcommand{\\vect}[1]{\\mathbf{#1}}\n\\newcommand{\\pd}[2]{x}\n\\newcommand{\\R}{R}\n\\NewDocumentCommand{\\bx}{o m}{}\n\\newenvironment{foo}{}{}\n';
const ents = MP.scanMacros(src);
const by = new Map(ents.map((e) => [e.name, e]));
eq(C.partsOfMacro(by.get('vect')), { name: 'vect', pre: '', open: '{', close: '}', post: '' });
eq(C.partsOfMacro(by.get('pd')).post, '{}');
eq(C.partsOfMacro(by.get('bx')).post, '');
eq(C.partsOfMacro(by.get('R')), null);
eq(C.partsOfMacro(by.get('foo')), null);

(async () => {
  const cmds = new Map([['vect', by.get('vect')], ['pd', by.get('pd')], ['R', by.get('R')]]);
  const run = (text, selections, pick, cfg, extra) => runCommand(Object.assign({ ext: EXT, module: 'wrapCmd.js', id: 'tssworkflow.wrapCmd', text, selections, pick, cfg, cmds }, extra));
  const pos = (r) => r.h.ed.selections.map((s) => [s.start.line, s.start.character]);

  let r = await run('a E b', [[0, 2, 0, 3]], { name: 'emph' });
  eq(r.h.doc.lines, ['a \\emph{E} b']);
  eq(pos(r), [[0, 10]]);
  eq(r.mem['tssworkflow.wrapCmd.recent'], [{ name: 'emph', pre: '', open: '{', close: '}', post: '' }]);
  const labels = r.h.vs.window.shown.items.map((i) => (i.kind === -1 ? '--' + i.label : i.label));
  ok(labels.indexOf('\\vect') > labels.indexOf('--Проєкт (.cls / .sty)') && labels.indexOf('\\vect') < labels.indexOf('--Стандартні'), 'project group');
  ok(!labels.includes('\\R'), 'a command without arguments is not offered');
  eq(r.h.vs.window.shown.items.find((i) => i.label === '\\pd').description, '{…}{}');

  // several selections on one line: the caret of the second one moves with the first edit
  r = await run('a b c', [[0, 0, 0, 1], [0, 4, 0, 5]], { name: 'emph' });
  eq(r.h.doc.lines, ['\\emph{a} b \\emph{c}']);
  eq(pos(r), [[0, 8], [0, 19]]);

  // no selection: the word at the caret, a backslash is part of it
  r = await run('foo bar', [[0, 5, 0, 5]], { name: 'textbf' });
  eq(r.h.doc.lines, ['foo \\textbf{bar}']);
  r = await run('x \\alpha y', [[0, 5, 0, 5]], { name: 'mathrm' });
  eq(r.h.doc.lines, ['x \\mathrm{\\alpha} y']);

  // no selection and no word: a snippet
  r = await run('a  b', [[0, 2, 0, 2]], { name: 'emph' });
  eq(r.h.ed.snippet, '\\emph{$1}$0');
  r = await run('a  b', [[0, 2, 0, 2]], { name: 'textcolor' });
  eq(r.h.ed.snippet, '\\textcolor{$1}{$2}$0');
  r = await run('a  b', [[0, 2, 0, 2]], { name: 'frac' });
  eq(r.h.ed.snippet, '\\frac{$1}{$2}$0');

  // typed with arguments, the second argument of a project command, your own entries
  r = await run('x', [[0, 0, 0, 1]], { typed: 'textcolor{red}' });
  eq(r.h.doc.lines, ['\\textcolor{red}{x}']);
  r = await run('x', [[0, 0, 0, 1]], { name: 'pd' });
  eq(r.h.doc.lines, ['\\pd{x}{}']);
  eq(pos(r), [[0, 7]]);
  r = await run('x', [[0, 0, 0, 1]], { name: 'href' }, { 'wrapCmd.extra': ['myc', 'bad name', 'hl{yellow}'] });
  eq(r.h.doc.lines, ['\\href{}{x}']);
  const l2 = r.h.vs.window.shown.items.map((i) => i.label);
  ok(l2.includes('\\myc') && l2.includes('\\hl') && !l2.includes('\\bad'), 'wrapCmd.extra');
  eq(r.h.vs.window.shown.items.find((i) => i.label === '\\hl').description, '{yellow}{…}');

  console.log('wrapCmd: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
