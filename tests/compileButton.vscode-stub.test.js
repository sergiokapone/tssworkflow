'use strict';
// node tests/compileButton.vscode-stub.test.js [path/to/extension]
// activate() on a stubbed vscode: (1) the external viewer button opens the PDF of the active file (a document with its own
// \documentclass has its own PDF, not main.pdf); (2) the label of the compile button in the status bar: Chapter / Figure / Separate / Main
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const pk = require(path.join(ext, 'package.json'));

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-btn-'));
const w = (rel, txt) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const MAIN = w('main.tex', '\\documentclass{book}\n\\begin{document}x\\end{document}\n');
w('main.pdf', 'pdf');
const NOTE = w('Note/note.tex', '\\documentclass{article}\n\\begin{document}n\\end{document}\n');
const CHAP = w('Ch/Ch.tex', '\\chapter{A}\ntext\n');
const FIG = w('Ch/tikz/pic.tikz', '\\begin{tikzpicture}\\end{tikzpicture}\n');
const CHEAT = w('cheat.tex', '\\documentclass{article}\n');
const DRIVER = w('alone.tex', '\\documentclass{book}\n');

const handler = { get: (t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const disp = { dispose() {} };
const commands = {}, items = [], editorListeners = [], warnings = [], spawned = [];
const folder = { uri: { fsPath: proj, toString: () => 'file://' + proj }, name: 'p', index: 0 };
const cfg = { get: (k, d) => d, update: async () => {}, has: () => false, inspect: () => ({}) };
const mkDoc = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  return { uri: { fsPath: file, path: file, scheme: 'file', toString: () => 'file://' + file }, languageId: /\.tikz$/.test(file) ? 'latex' : 'latex', getText: () => text, lineCount: text.split('\n').length, isDirty: false, fileName: file, lineAt: (i) => ({ text: text.split('\n')[i] || '' }) };
};
let active;
const setActive = (file) => {
  active = { document: mkDoc(file), selection: { active: { line: 0, character: 0 } }, selections: [] };
  vscode.window.activeTextEditor = active;
  editorListeners.forEach((f) => f(active));
};
const vscode = mk({
  commands: mk({ registerCommand: (id, fn) => { commands[id] = fn; return disp; }, registerTextEditorCommand: (id, fn) => { commands[id] = fn; return disp; }, executeCommand: async () => undefined }),
  window: mk({
    activeTextEditor: undefined, visibleTextEditors: [], textEditors: [], terminals: [], tabGroups: mk({ all: [], onDidChangeTabs: () => disp }),
    createStatusBarItem: (al, pr) => { const it = { priority: pr, text: '', tooltip: '', command: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; items.push(it); return it; },
    onDidChangeActiveTextEditor: (f) => { editorListeners.push(f); return disp; },
    showWarningMessage: (m) => { warnings.push(m); return Promise.resolve(undefined); }
  }),
  workspace: mk({ workspaceFolders: [folder], textDocuments: [], getConfiguration: () => cfg, getWorkspaceFolder: () => folder, findFiles: async () => [] }),
  extensions: mk({ all: [], getExtension: () => undefined }),
  env: mk({ language: 'uk', appName: 'x', uiKind: 1, remoteName: undefined }),
  version: '1.141.0'
});
const realCp = require('child_process');
const load = Module._load;
Module._load = function (req, ...a) {
  if (req === 'vscode') return vscode;
  if (req === 'child_process') return Object.assign({}, realCp, { spawn: (cmd, args, o) => { spawned.push({ cmd, args }); return { on() {}, unref() {} }; } });
  return load.call(this, req, ...a);
};
const ctx = { subscriptions: [], extensionUri: { fsPath: ext, path: ext }, extensionPath: ext, globalState: { get: () => undefined, update: async () => {}, keys: () => [] }, workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] }, asAbsolutePath: (p) => path.join(ext, p), globalStorageUri: { fsPath: path.join(os.tmpdir(), 'tss-gs') }, extension: { packageJSON: pk } };
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

(async () => {
  await require(path.join(ext, 'extension.js')).activate(ctx);
  const btn = items.find((i) => i.priority === 100);
  ok(btn, 'the compile button exists');
  const label = (file) => { setActive(file); return btn.text + ' | ' + btn.command; };

  // the label and the action of the button
  eq(label(CHAP), '$(play) Chapter | tssworkflow.compilePdf', 'a chapter');
  eq(label(FIG), '$(play) Figure | tssworkflow.compilePdf', 'a figure');
  eq(label(NOTE), '$(play) Separate | tssworkflow.compileCurrent', 'a document with its own preamble outside the root: Separate, it is built on its own');
  eq(label(CHEAT), '$(play) Separate | tssworkflow.compileCurrent', 'the same in the root, if it is not the main file');
  eq(label(MAIN), '$(play) Main | tssworkflow.compilePdf', 'the main file');
  eq(label(DRIVER), '$(play) Main | tssworkflow.compilePdf', 'the driver builds the whole document too');
  ok(btn.tooltip.includes('on its own') === false && /whole document/.test(btn.tooltip), 'the tooltip of Main: ' + btn.tooltip);
  setActive(NOTE); ok(/on its own/.test(btn.tooltip), 'the tooltip of Separate: ' + btn.tooltip);

  // the external viewer
  const open = () => { spawned.length = 0; warnings.length = 0; commands['tssworkflow.openPdfExternal'](); return { spawned: spawned.slice(), warnings: warnings.slice() }; };
  setActive(NOTE);
  let r = open();
  eq(r.spawned.length, 0, 'no PDF of the note yet: nothing is opened (main.pdf is another document)');
  ok(r.warnings.length === 1 && /note\.pdf/.test(r.warnings[0]), 'a warning names the PDF: ' + r.warnings);
  ok(r.warnings[0].startsWith('PDF цього файла (note.pdf) ще немає.'), 'in Ukrainian by default: ' + r.warnings[0]);
  const I18N = require(path.join(ext, 'i18n'));
  I18N.setLang('en'); // tssworkflow.language
  r = open();
  I18N.setLang('uk');
  eq(r.warnings[0], 'The PDF of this file (note.pdf) does not exist yet. Build it with the ▶ button (“Build this file separately”); main.pdf is not opened because it is another document.', 'the same warning in English');
  w('Note/note.pdf', 'pdf');
  r = open();
  eq(r.spawned.length, 1); ok(r.spawned[0].args.includes(path.join(proj, 'Note', 'note.pdf')), 'the PDF of the separate file: ' + JSON.stringify(r.spawned[0].args));
  ok(!r.spawned[0].args.some((a) => /main\.pdf$/.test(a)), 'not main.pdf');
  setActive(MAIN); r = open();
  ok(r.spawned[0].args.includes(path.join(proj, 'main.pdf')), 'the main file: main.pdf');
  setActive(CHAP); r = open();
  ok(r.spawned[0].args.includes(path.join(proj, 'main.pdf')), 'a chapter is built into main.pdf (jobname), as before');
  fs.rmSync(proj, { recursive: true, force: true });
  console.log('compileButton: ' + n + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
