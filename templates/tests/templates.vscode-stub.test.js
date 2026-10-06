'use strict';
// end-to-end run of templates.js against a stub of the vscode API
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-'));
const proj = path.join(tmp, 'proj'); fs.mkdirSync(proj);
const store = path.join(tmp, 'store');
const log = { msgs: [], opened: [], shown: [] };
let answers = { pick: [], input: [], warn: [] };
const cfgv = {};
const stub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in cfgv ? cfgv[k] : d) }),
    workspaceFolders: [{ uri: { fsPath: proj } }],
    getWorkspaceFolder: () => ({ uri: { fsPath: proj } }),
    openTextDocument: async (a) => (a && a.content !== undefined ? { content: a.content, isUntitled: true } : { uri: a, getText: () => fs.readFileSync(a.fsPath, 'utf8') }),
  },
  window: {
    activeTextEditor: null,
    showQuickPick: async (items) => { const want = answers.pick.shift(); const arr = Array.isArray(items) ? items : []; log.lastItems = arr; return typeof want === 'function' ? want(arr) : want; },
    showInputBox: async (o) => { const v = answers.input.shift(); if (v !== undefined && v !== null && o.validateInput) log.lastValidation = o.validateInput(v); return v; },
    showWarningMessage: async (...a) => { log.msgs.push(a[0]); return answers.warn.shift(); },
    showInformationMessage: async (m) => { log.msgs.push(m); },
    showTextDocument: async (d) => { const ed = { document: d, selection: null, revealRange() {} }; log.shown.push(ed); return ed; },
  },
  commands: { registerCommand: (id, fn) => { stub._cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  env: { openExternal: async (u) => { log.opened.push(u.fsPath); } },
  Uri: { file: (p) => ({ fsPath: p }) },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Selection: class { constructor(a, b) { this.a = a; this.b = b; } },
  Range: class { constructor(a, b) { this.a = a; this.b = b; } },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  QuickPickItemKind: { Separator: -1 },
  _cmds: {},
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : orig.call(this, r, ...a); };
const M = require(path.join(ext, 'templates.js'));
M.register({ subscriptions: [], extensionPath: ext, globalStorageUri: { fsPath: store } });
const C = stub._cmds;
(async () => {
  assert.deepStrictEqual(Object.keys(C).sort(), ['tssworkflow.insertTemplate', 'tssworkflow.makeTemplate', 'tssworkflow.manageTemplates', 'tssworkflow.newFromTemplate', 'tssworkflow.openTemplatesFolder']);

  // 1. only the built-in template exists; no folder open -> new untitled document with the cursor
  const folders = stub.workspace.workspaceFolders;
  stub.workspace.workspaceFolders = undefined;
  answers.pick = [(arr) => arr.find((x) => x.t && !x.t.multi && x.t.kind !== 'fragment' && x.t.source === 'builtin')];
  await C['tssworkflow.newFromTemplate']();
  assert.ok(log.shown.at(-1).document.content.includes('\\begin{document}'));
  assert.ok(log.lastItems.some((x) => x.kind === -1 && x.label === 'Вбудовані'));
  stub.workspace.workspaceFolders = folders;

  // 1b. 0.4.4: a folder is open, nothing clicked -> the file is created in that folder, no Save As
  answers.pick = [(arr) => arr.find((x) => x.t && !x.t.multi && x.t.kind !== 'fragment' && x.t.source === 'builtin')];
  answers.input = ['from palette'];
  await C['tssworkflow.newFromTemplate']();
  assert.ok(fs.existsSync(path.join(proj, 'from palette.tex')), 'file created in the workspace folder');
  assert.ok(!log.shown.at(-1).document.isUntitled);
  // newFromTemplateInWorkspace = false brings the untitled document back
  cfgv.newFromTemplateInWorkspace = false;
  answers.pick = [(arr) => arr.find((x) => x.t && !x.t.multi && x.t.kind !== 'fragment' && x.t.source === 'builtin')];
  await C['tssworkflow.newFromTemplate']();
  assert.ok(log.shown.at(-1).document.isUntitled);
  delete cfgv.newFromTemplateInWorkspace;

  // 2. make a user template from a selection
  const doc = { uri: { fsPath: path.join(proj, 'a.tex') }, isUntitled: false, getText: () => 'SEL ${date}${cursor}' };
  stub.window.activeTextEditor = { document: doc, selection: { isEmpty: true } };
  answers.input = ['Мій / шаблон', 'короткий опис'];
  answers.pick = [(arr) => arr[0]]; // user folder (project folder is also offered)
  await C['tssworkflow.makeTemplate']();
  const f = path.join(proj, '.vscode', 'templates');
  const saved = fs.existsSync(path.join(store, 'templates', 'Мій шаблон.tex')) ? path.join(store, 'templates', 'Мій шаблон.tex') : null;
  assert.ok(saved, 'user template saved with sanitised name');
  assert.strictEqual(fs.readFileSync(saved, 'utf8'), '% !TSS description: короткий опис\nSEL ${date}${cursor}');

  // 3. new file in a folder from that template; ${date} filled, cursor set, duplicate name rejected
  fs.writeFileSync(path.join(proj, 'taken.tex'), 'x');
  answers.pick = [(arr) => arr.find((x) => x.t && x.t.source === 'user')];
  answers.input = ['taken'];
  await C['tssworkflow.newFromTemplate']({ fsPath: proj });
  assert.strictEqual(log.lastValidation, 'Такий файл уже є');
  answers.pick = [(arr) => arr.find((x) => x.t && x.t.source === 'user')];
  answers.input = ['new one'];
  await C['tssworkflow.newFromTemplate']({ fsPath: proj });
  const nf = fs.readFileSync(path.join(proj, 'new one.tex'), 'utf8');
  assert.ok(/^SEL \d{4}-\d{2}-\d{2}$/.test(nf), nf);
  assert.ok(log.shown.at(-1).selection, 'caret placed');

  // 4. project templates come first
  fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(f, 'Проєктний.tex'), 'P');
  answers.pick = [undefined];
  await C['tssworkflow.newFromTemplate']();
  const labels = log.lastItems.map((x) => x.label);
  assert.deepStrictEqual(labels.slice(0, 2), ['Проєкт', 'Проєктний']);

  // 5. manage: copy built-in, rename, delete
  answers.pick = [(arr) => arr.find((x) => x.t && x.t.source === 'builtin' && x.t.stem === 'ukr-lualatex-article'), 'Скопіювати до моїх шаблонів'];
  await C['tssworkflow.manageTemplates']();
  assert.ok(fs.readdirSync(path.join(store, 'templates')).some((n) => n.startsWith('Стаття')));
  answers.pick = [(arr) => arr.find((x) => x.t && x.t.name === 'Проєктний'), 'Перейменувати'];
  answers.input = ['Нова назва'];
  await C['tssworkflow.manageTemplates']();
  assert.ok(fs.existsSync(path.join(f, 'Нова назва.tex')) && !fs.existsSync(path.join(f, 'Проєктний.tex')));
  answers.pick = [(arr) => arr.find((x) => x.t && x.t.name === 'Нова назва'), 'Видалити'];
  answers.warn = ['Видалити'];
  await C['tssworkflow.manageTemplates']();
  assert.ok(!fs.existsSync(path.join(f, 'Нова назва.tex')));

  // 6. open folder; custom templatesDir
  await C['tssworkflow.openTemplatesFolder']();
  assert.strictEqual(log.opened.at(-1), path.join(store, 'templates'));
  cfgv.templatesDir = path.join(tmp, 'mine');
  await C['tssworkflow.openTemplatesFolder']();
  assert.strictEqual(log.opened.at(-1), path.join(tmp, 'mine'));
  console.log('stub end-to-end: all ok');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
