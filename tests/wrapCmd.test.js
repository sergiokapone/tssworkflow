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
ok(C.FORMAT_MENU.some((f) => f.name === 'enquote' && f.group === 'Текст'), '\\enquote is in the Format menu');
ok(C.STANDARD_CMDS.some((f) => f.name === 'enquote'), '\\enquote is in the list of standard commands');
eq(C.wrapInline('самий', C.formatSpec('enquote')), { text: '\\enquote{самий}', cursor: 15 }, 'wraps in \\enquote');
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

/* ---- the menu "Format": command, buttons above a selection, light bulb ---- */
(async () => {
  const cmds = new Map();
  const ctx = (text, selections, extra) => Object.assign({ ext: EXT, module: 'wrapCmd.js', id: 'tssworkflow.formatSelection', text, selections, pick: {}, cmds }, extra);
  let m = 0;
  const e2 = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); m++; };
  const ok2 = (c, msg) => { assert.ok(c, msg); m++; };
  const fmtRun = async (text, selections, name, cfg, menu) => {
    const h = require('./vscodeStub');
    const orig = h.runCommand;
    return orig(Object.assign(ctx(text, selections, { cfg: cfg || {}, pick: { menu } }), { args: name === undefined ? [] : [name] }));
  };

  // a command of the menu by name round the selection (what the buttons call)
  let r = await runCommand(ctx('a bold b', [[0, 2, 0, 6]], { args: ['textbf'] }));
  e2(r.h.doc.lines, ['a \\textbf{bold} b']);
  r = await runCommand(ctx('a bold b', [[0, 2, 0, 6]], { args: ['underline'] }));
  e2(r.h.doc.lines, ['a \\underline{bold} b']);
  r = await runCommand(ctx('x = y', [[0, 0, 0, 1], [0, 4, 0, 5]], { args: ['mathrm'] }));
  e2(r.h.doc.lines, ['\\mathrm{x} = \\mathrm{y}'], 'several selections');
  // no selection: the word at the caret
  r = await runCommand(ctx('foo bar', [[0, 5, 0, 5]], { args: ['emph'] }));
  e2(r.h.doc.lines, ['foo \\emph{bar}']);
  // nothing to format: a message, the text stays
  r = await runCommand(ctx('a  b', [[0, 2, 0, 2]], { args: ['emph'] }));
  e2(r.h.doc.lines, ['a  b']);
  // the menu: groups, the choice, "other command"
  r = await runCommand(ctx('a bold b', [[0, 2, 0, 6]], { args: [], pick: { menu: 'Курсив' } }));
  e2(r.h.doc.lines, ['a \\textit{bold} b']);
  const labels = r.h.vs.quickPickItems.map((i) => (i.kind === -1 ? '--' + i.label : i.label));
  ok2(labels.indexOf('--Текст') === 0 && labels.includes('--Формула') && labels.includes('Напівжирний') && labels[labels.length - 1].includes('Інша команда'), 'menu groups: ' + labels.join(' | '));
  r = await runCommand(ctx('a bold b', [[0, 2, 0, 6]], { args: [], pick: { menu: '$(list-selection) Інша команда…' } }));
  e2(r.h.doc.lines, ['a bold b'], 'the full list is opened instead');
  ok2(r.h.vs.executed.some((x) => x[0] === 'tssworkflow.wrapCmd'), 'the command with the full list is called');
  // an unknown name falls back to the menu
  r = await runCommand(ctx('a bold b', [[0, 2, 0, 6]], { args: ['nonsense'], pick: { menu: 'Капітель' } }));
  e2(r.h.doc.lines, ['a \\textsc{bold} b']);

  // the buttons above a selection
  r = await runCommand(ctx('line1\nsome text', [[1, 0, 1, 4]], { args: [], pick: { menu: 'nothing chosen' }, cfg: {} })); // the menu is dismissed: the selection stays
  const lens = r.h.vs.lensProviders[0];
  const titles = (cfg2) => lens.provideCodeLenses(r.h.doc);
  let ls = lens.provideCodeLenses(r.h.doc);
  e2(ls.map((l) => l.command.title), ['$(bold) Напівжирний', '$(italic) Курсив', 'Підкреслення', '$(chevron-down) Формат'], 'three buttons and the menu');
  e2(ls.map((l) => l.command.arguments || null), [['textbf'], ['textit'], ['underline'], null]);
  e2(ls.map((l) => l.range.start.line), [1, 1, 1, 1], 'all above the first line of the selection');
  void titles;
  // an empty selection or another document: no buttons
  r.h.ed.selections = [new (require('./vscodeStub').Selection)(0, 1, 0, 1)];
  e2(lens.provideCodeLenses(r.h.doc), [], 'empty selection');
  e2(lens.provideCodeLenses({}), [], 'another document');

  // the settings
  const modeRun = async (mode) => {
    const x = await runCommand(ctx('abc def', [[0, 0, 0, 3]], { args: ['textbf'], cfg: { 'wrapCmd.selectionHint': mode } }));
    x.h.ed.selections = [new (require('./vscodeStub').Selection)(0, 0, 0, 3)];
    return { lens: x.h.vs.lensProviders[0].provideCodeLenses(x.h.doc).length, acts: x.h.vs.actionProviders[0][0].provideCodeActions(x.h.doc, new (require('./vscodeStub').Range)(0, 0, 0, 3)).length };
  };
  e2(await modeRun('codelens'), { lens: 4, acts: 0 });
  e2(await modeRun('lightbulb'), { lens: 0, acts: 5 });
  e2(await modeRun('both'), { lens: 4, acts: 5 });
  e2(await modeRun('off'), { lens: 0, acts: 0 });

  // the light bulb entries run the same command; nothing on an empty range
  r = await runCommand(ctx('abc', [[0, 0, 0, 3]], { args: ['textbf'], cfg: { 'wrapCmd.selectionHint': 'both' } }));
  const acts = r.h.vs.actionProviders[0][0].provideCodeActions(r.h.doc, new (require('./vscodeStub').Range)(0, 0, 0, 3));
  e2(acts.map((a) => a.command.arguments || null), [['textbf'], ['textit'], ['emph'], ['underline'], null]);
  ok2(acts.every((a) => a.kind.value === 'refactor.rewrite.tssworkflow' && a.title.startsWith('TSS: ')), 'kind and titles');
  e2(r.h.vs.actionProviders[0][0].provideCodeActions(r.h.doc, new (require('./vscodeStub').Range)(0, 1, 0, 1)), [], 'empty range');
  e2(r.h.vs.actionProviders[0][1].providedCodeActionKinds.map((k) => k.value), ['refactor.rewrite']);

  // the buttons are refreshed a moment after the selection changes (at once when it is cleared)
  r = await runCommand(ctx('abc', [[0, 0, 0, 3]], { args: ['textbf'] }));
  let fired = 0;
  r.h.vs.lensProviders[0].onDidChangeCodeLenses(() => fired++);
  const listener = r.h.vs.selectionListeners[0];
  r.h.doc.languageId = 'latex';
  listener({ textEditor: { document: r.h.doc, selection: new (require('./vscodeStub').Selection)(0, 0, 0, 2) } });
  await new Promise((res) => setTimeout(res, 150));
  e2(fired, 0, 'not yet: the selection may still be changing');
  await new Promise((res) => setTimeout(res, 400));
  e2(fired, 1, 'refreshed once it stopped');
  listener({ textEditor: { document: r.h.doc, selection: new (require('./vscodeStub').Selection)(0, 1, 0, 1) } });
  await new Promise((res) => setTimeout(res, 50));
  e2(fired, 2, 'cleared selection: at once');
  void fmtRun;

  console.log('wrapCmd (format menu): ' + m + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
