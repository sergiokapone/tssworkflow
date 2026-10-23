'use strict';
// node tests/wrapEnvDoctor.vscode-stub.test.js [path/to/extension]
// wrapCmd.js, wrapEnv.js (the quick picks: groups, descriptions, placeholders) and environment.js (Doctor: the report, the buttons) in Ukrainian and in English (tssworkflow.language)
const assert = require('assert'), path = require('path'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
const { runCommand, makeVscode } = require('./vscodeStub');
const I = require(path.join(EXT, 'i18n'));
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const lbl = (items) => items.map((i) => (i.kind === -1 ? '--' + i.label : i.label));

async function picks(lang) {
  I.setLang(lang);
  const cmd = await runCommand({ ext: EXT, module: 'wrapCmd.js', id: 'tssworkflow.wrapCmd', text: 'a E b', selections: [[0, 2, 0, 3]], pick: { name: 'emph' }, cmds: new Map() });
  const word = await runCommand({ ext: EXT, module: 'wrapCmd.js', id: 'tssworkflow.wrapCmd', text: 'foo bar', selections: [[0, 5, 0, 5]], pick: { name: 'emph' }, cmds: new Map() });
  const fmt = await runCommand({ ext: EXT, module: 'wrapCmd.js', id: 'tssworkflow.formatSelection', text: 'a bold b', selections: [[0, 2, 0, 6]], pick: { menu: lang === 'en' ? 'Italic' : 'Курсив' }, args: [], cmds: new Map() });
  const env = await runCommand({ ext: EXT, module: 'wrapEnv.js', id: 'tssworkflow.wrapEnv', text: 'x = y', selections: [[0, 0, 0, 5]], pick: { name: 'equation' }, envs: new Map() });
  const envEmpty = await runCommand({ ext: EXT, module: 'wrapEnv.js', id: 'tssworkflow.wrapEnv', text: 'x = y', selections: [[0, 1, 0, 1]], pick: { name: 'equation' }, envs: new Map() });
  return { cmd, word, fmt, env, envEmpty };
}

(async () => {
  try {
    const uk = await picks('uk'), en = await picks('en');
    // wrap in a command: the groups, the description of \emph, the placeholder (three variants), the result does not depend on the language
    eq(uk.cmd.h.doc.lines, en.cmd.h.doc.lines);
    eq(lbl(uk.cmd.h.vs.window.shown.items).filter((l) => l.startsWith('--')), ['--Стандартні']);
    eq(lbl(en.cmd.h.vs.window.shown.items).filter((l) => l.startsWith('--')), ['--Standard']);
    eq(en.cmd.h.vs.window.shown.items.find((i) => i.label === '\\emph').detail, 'Emphasis (italic)');
    eq(uk.cmd.h.vs.window.shown.items.find((i) => i.label === '\\emph').detail, 'Виділення (курсив)');
    eq(en.cmd.h.vs.window.shown.placeholder, 'Wrap the selection in a command: pick from the list or type one, e.g. textcolor{red}');
    eq(en.word.h.vs.window.shown.placeholder, 'Wrap the word at the cursor in a command: pick from the list or type one, e.g. textcolor{red}');
    eq(uk.cmd.h.vs.window.shown.placeholder, 'Обгорнути виділене в команду: вибери зі списку або введи, напр. textcolor{red}');
    // the Format menu: the groups, the labels, "another command"; the English label is an answer
    eq(uk.fmt.h.doc.lines, en.fmt.h.doc.lines);
    ok(uk.fmt.h.doc.lines[0] === 'a \\textit{bold} b', 'italic: ' + uk.fmt.h.doc.lines);
    const f = lbl(en.fmt.h.vs.quickPickItems);
    ok(f.indexOf('--Text') === 0 && f.includes('--Formula') && f.includes('Bold') && f.includes('Italic') && /Another command/.test(f[f.length - 1]), JSON.stringify(f));
    eq(en.fmt.h.vs.quickPickOpts.placeHolder, 'Format the selection');
    ok(!f.some((l) => /[А-Яа-яІіЇїЄєҐґ]/.test(l)), 'no Ukrainian in the menu');
    // wrap in an environment
    eq(uk.env.h.doc.lines, en.env.h.doc.lines);
    eq(en.env.h.vs.window.shown.items.find((i) => i.label === 'equation').detail, 'Numbered equation');
    eq(uk.env.h.vs.window.shown.items.find((i) => i.label === 'equation').detail, 'Формула з номером');
    eq(lbl(en.env.h.vs.window.shown.items).filter((l) => l.startsWith('--')), ['--Standard']);
    eq(en.env.h.vs.window.shown.placeholder, 'Wrap the selection: pick from the list or type your own, e.g. minipage{0.5\\linewidth}');
    eq(en.envEmpty.h.vs.window.shown.placeholder, 'Insert an empty environment: pick from the list or type your own, e.g. minipage{0.5\\linewidth}');

    // Doctor: the report and the buttons of the offer to copy the install commands
    const doctor = async (lang, button) => {
      I.setLang(lang);
      const h = makeVscode('x\n', [[0, 0, 0, 0]], {}, { logParser: 'builtin', pdfViewer: 'vscode', latexmk: 'no-such-latexmk-xyz', lualatex: 'no-such-lualatex-xyz', texlogsieveCommand: 'no-such-tls', pplatexCommand: 'no-such-ppl', latexdiffCommand: 'no-such-ld', externalViewerCommand: 'no-such-viewer' });
      const { vs } = h;
      vs.docs = []; vs.status = []; vs.infos = []; vs.copied = []; vs.terminals = [];
      vs.workspace.workspaceFolders = [{ uri: { fsPath: '/p-no-such-folder' } }];
      vs.workspace.openTextDocument = async (o) => { vs.docs.push(o.content); return { uri: {} }; };
      vs.window.showTextDocument = async () => ({});
      vs.window.setStatusBarMessage = (m) => { vs.status.push(m); };
      vs.window.showInformationMessage = async (m, ...b) => { vs.infos.push([m, ...b]); return b.includes(button) ? button : undefined; };
      vs.window.createTerminal = () => ({ show() {}, sendText(t) { vs.terminals.push(t); } });
      vs.env = { clipboard: { async writeText(t) { vs.copied.push(t); } } };
      vs.extensions = { getExtension: () => undefined };
      vs.commands.registerCommand = (id, fn) => { h.handlers[id] = fn; return { dispose() {} }; };
      const orig = Module._load;
      Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
      for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && /\.js$/.test(k) && !/[\\/]i18n(En)?\.js$/.test(k)) delete require.cache[k];
      try {
        require(path.join(EXT, 'environment')).register({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
        await h.handlers['tssworkflow.checkEnvironment']();
      } finally { Module._load = orig; }
      return vs;
    };
    const dUk = await doctor('uk', 'Скопіювати команди'), dEn = await doctor('en', 'Copy the commands');
    const rep = dEn.docs[0];
    ok(rep.startsWith('# TSS Workflow: Doctor (check of the environment)'), rep.split('\n')[0]);
    ok(rep.includes('| What | State | Where / version | What for | What to do |') && rep.includes('not found in PATH') && rep.includes('PDF viewer') && rep.includes('Install TeX Live (or MiKTeX)'), 'the table: ' + rep.slice(0, 400));
    ok(/\*\*Missing what is needed \(\d+\):\*\* /.test(rep) && /found · ❌ absent, but needed/.test(rep), 'the summary and the legend');
    ok(dUk.docs[0].startsWith('# TSS Workflow: Doctor (перевірка середовища)') && dUk.docs[0].includes('не знайдено в PATH'), 'Ukrainian as before');
    ok(/^Missing what is needed: \d+$/.test(dEn.status[0]) && /^Бракує потрібного: \d+$/.test(dUk.status[0]), 'the status line: ' + dEn.status[0] + ' | ' + dUk.status[0]);
    eq(dEn.infos[0].slice(1), ['Copy the commands', 'Show in the terminal'], 'the buttons');
    ok(/^Doctor: install commands for what is missing: \d+$/.test(dEn.infos[0][0]), dEn.infos[0][0]);
    ok(dEn.copied.length === 1 && /tlmgr install latexmk/.test(dEn.copied[0]), 'the English button copies the commands (the commands are taken from the hints in either language): ' + dEn.copied);
    eq(dUk.copied.length, 1, 'and the Ukrainian one does');
    ok(dUk.copied[0] === dEn.copied[0], 'the same commands in both languages');
  } finally { I.setLang('uk'); }
  console.log('wrapEnvDoctor.vscode-stub: ' + n + ' checks passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
