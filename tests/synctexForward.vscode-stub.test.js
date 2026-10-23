'use strict';
// node tests/synctexForward.vscode-stub.test.js [path/to/extension]
// activate() on a stubbed vscode: (1) the jump to a line in the external viewer is checked against the synctex file of the PDF
// (a file that is not in the PDF: a warning with two buttons instead of a silent viewer; no synctex file: as before);
// (2) the build tasks (Ctrl+Shift+B) are registered and a task that cannot start a build ends with 1.
const path = require('path'), fs = require('fs'), os = require('os'), zlib = require('zlib'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const pk = require(path.join(ext, 'package.json'));

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-fwd-'));
const w = (rel, txt) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const MAIN = w('main.tex', '\\documentclass{book}\n\\begin{document}x\\end{document}\n');
w('main.pdf', 'pdf');
const CH = w('Ch/Ch.tex', '\\chapter{A}\ntext\n');
const CH2 = w('Ch2/Ch2.tex', '\\chapter{B}\ntext\n');
const CLS = w('My.cls', '\\ProvidesClass{My}\n');
const SYNC = path.join(proj, 'main.synctex.gz');
const writeSync = () => fs.writeFileSync(SYNC, zlib.gzipSync('SyncTeX Version:1\nInput:1:./main.tex\nInput:2:./Ch/Ch.tex\nOutput:pdf\nContent:\n{1\n'));

const handler = { get: (t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in o ? o[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const disp = { dispose() {} };
class EventEmitter { constructor() { this.ls = []; this.event = (fn) => { this.ls.push(fn); return disp; }; } fire(x) { this.ls.slice().forEach((f) => f(x)); } }
class CustomExecution { constructor(cb) { this.callback = cb; } }
class Task { constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, scope, name, source, execution }); } }
const commands = {}, executed = [], editorListeners = [], warnings = [], spawned = [];
let warnAnswer = (m, ...b) => undefined;
let provider = null;
const folder = { uri: { fsPath: proj, toString: () => 'file://' + proj }, name: 'p', index: 0 };
const cfg = { get: (k, d) => d, update: async () => {}, has: () => false, inspect: () => ({}) };
const mkDoc = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  return { uri: { fsPath: file, path: file, scheme: 'file', toString: () => 'file://' + file }, languageId: 'latex', getText: () => text, lineCount: text.split('\n').length, isDirty: false, lineAt: (i) => ({ text: text.split('\n')[i] }) };
};
const setActive = (file, line) => {
  const ed = { document: mkDoc(file), selection: { active: { line: line || 0, character: 0 } }, selections: [] };
  vscode.window.activeTextEditor = ed;
  editorListeners.forEach((f) => f(ed));
};
const vscode = mk({
  EventEmitter, CustomExecution, Task,
  TaskScope: { Workspace: 2 }, TaskGroup: { Build: { id: 'build' } }, TaskRevealKind: { Silent: 2 },
  commands: mk({ registerCommand: (id, fn) => { commands[id] = fn; return disp; }, registerTextEditorCommand: (id, fn) => { commands[id] = fn; return disp; }, executeCommand: async (...a) => { executed.push(a); } }),
  window: mk({
    activeTextEditor: undefined, visibleTextEditors: [], textEditors: [], terminals: [], tabGroups: mk({ all: [], onDidChangeTabs: () => disp }),
    createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
    onDidChangeActiveTextEditor: (f) => { editorListeners.push(f); return disp; },
    showWarningMessage: (m, ...b) => { warnings.push(m); return Promise.resolve(warnAnswer(m, ...b)); }
  }),
  tasks: mk({ registerTaskProvider: (type, p) => { provider = { type, p }; return disp; } }),
  workspace: mk({ workspaceFolders: [folder], textDocuments: [], getConfiguration: () => cfg, getWorkspaceFolder: () => folder, findFiles: async () => [] }),
  extensions: mk({ all: [], getExtension: () => undefined }),
  env: mk({ language: 'uk', appName: 'x', uiKind: 1, remoteName: undefined }),
  version: '1.141.0'
});
const realCp = require('child_process');
const load = Module._load;
Module._load = function (req, ...a) {
  if (req === 'vscode') return vscode;
  if (req === 'child_process') return Object.assign({}, realCp, { spawn: (cmd, args) => { spawned.push({ cmd, args }); return { on() {}, unref() {} }; } });
  return load.call(this, req, ...a);
};
const ctx = { subscriptions: [], extensionUri: { fsPath: ext, path: ext }, extensionPath: ext, globalState: { get: () => undefined, update: async () => {}, keys: () => [] }, workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] }, asAbsolutePath: (p) => path.join(ext, p), globalStorageUri: { fsPath: path.join(os.tmpdir(), 'tss-gs') }, extension: { packageJSON: pk } };
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

(async () => {
  await require(path.join(ext, 'extension.js')).activate(ctx);
  ok(commands['tssworkflow.synctexDiagnose'] && commands['tssworkflow.checkLatexWorkshop'], 'the two new commands are registered');
  const jump = async () => { spawned.length = 0; warnings.length = 0; executed.length = 0; await commands['tssworkflow.externalForwardSearch'](); return { spawned: spawned.slice(), warnings: warnings.slice(), executed: executed.slice() }; };

  // no synctex file: the viewer is opened as before (the build may be unusual)
  setActive(CH, 4);
  let r = await jump();
  eq(r.spawned.length, 1, 'no synctex file: the viewer opens');
  ok(r.spawned[0].args.includes(CH), 'with the file of the editor: ' + JSON.stringify(r.spawned[0].args));
  eq(r.warnings, []);

  // the PDF contains the file
  writeSync();
  r = await jump();
  eq(r.spawned.length, 1, 'the file is in the PDF');
  eq(r.warnings, []);
  ok(r.spawned[0].args.includes(CH));
  setActive(MAIN);
  eq((await jump()).spawned.length, 1, 'the main file is in the PDF');

  // the PDF was built from another chapter: a warning, the viewer is not started
  setActive(CH2, 1);
  r = await jump();
  eq(r.spawned.length, 0, 'the file is not in the PDF: nothing is started');
  eq(r.warnings.length, 1);
  ok(/немає файла «Ch2\.tex»/.test(r.warnings[0]) && /main\.pdf/.test(r.warnings[0]), r.warnings[0]);

  // the first button: open without the jump
  warnAnswer = (m, ...b) => b[0];
  r = await jump();
  eq(r.spawned.length, 1, 'the first button opens the viewer anyway');
  eq(r.executed.filter((x) => x[0] === 'tssworkflow.synctexDiagnose').length, 0);

  // the second button: the diagnosis, no viewer
  warnAnswer = (m, ...b) => b[1];
  r = await jump();
  eq(r.spawned.length, 0);
  eq(r.executed.filter((x) => x[0] === 'tssworkflow.synctexDiagnose').length, 1, 'the second button runs the diagnosis');
  warnAnswer = () => undefined;

  // only the sync command checks: the plain button opens the PDF whatever it contains
  spawned.length = 0; warnings.length = 0;
  await commands['tssworkflow.openPdfExternal']();
  eq(spawned.length, 1, 'the plain button does not check');
  eq(warnings, []);

  // the build tasks
  eq(provider.type, 'tssworkflow');
  const tasks = provider.p.provideTasks();
  eq(tasks.map((x) => x.definition.target), ['current', 'main']);
  setActive(CLS);
  const run = async (task) => {
    const pty = await task.execution.callback();
    const out = { written: '', closed: [] };
    pty.onDidWrite((s) => { out.written += s; }); pty.onDidClose((c) => out.closed.push(c));
    warnings.length = 0;
    pty.open();
    await new Promise((res) => setTimeout(res, 50));
    return out;
  };
  const o = await run(tasks[0]);
  eq(o.closed, [1], 'a class cannot be built as a chapter: the task did not start a build and ends with 1');
  ok(o.written.includes('Збірку не запущено'), o.written);
  ok(warnings.length >= 1, 'and the usual warning is shown: ' + warnings);

  fs.rmSync(proj, { recursive: true, force: true });
  console.log('synctexForward: ' + n + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
