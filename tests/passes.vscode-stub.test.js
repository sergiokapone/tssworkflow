'use strict';
// node tests/passes.vscode-stub.test.js [path/to/extension]
// extension.js on a stub of vscode: tssworkflow.passes runs the same command exactly N times, and the spinner is a
// separate status bar item whose text is written once per build (a codicon restarts its rotation when its item's text changes)
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-'));
fs.mkdirSync(path.join(tmp, 'Ch'));
fs.writeFileSync(path.join(tmp, 'Ch', 'Ch.tex'), '\\chapter{A}\n');
fs.writeFileSync(path.join(tmp, 'alone.tex'), 'x');
const cmds = {}, items = [], started = [], endListeners = [];
const cfgv = {};
const mkProxy = (name) => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => name : mkProxy(name + '.' + String(k))),
  apply: () => mkProxy(name + '()'), construct: () => mkProxy(name + '#')
});
const folder = { uri: { fsPath: tmp } };
const doc = { uri: { fsPath: path.join(tmp, 'Ch', 'Ch.tex') }, getText: () => '\\chapter{A}\n', languageId: 'latex', fileName: path.join(tmp, 'Ch', 'Ch.tex') };
const base = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in cfgv ? cfgv[k] : d), inspect: () => ({}), update: async () => {} }),
    workspaceFolders: [folder], getWorkspaceFolder: () => folder, isTrusted: true,
    onDidSaveTextDocument: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }), onDidCreateFiles: () => ({ dispose() {} }),
    onDidDeleteFiles: () => ({ dispose() {} }), onDidRenameFiles: () => ({ dispose() {} }), textDocuments: [],
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} })
  },
  window: {
    activeTextEditor: { document: doc, viewColumn: 1, selection: null },
    createStatusBarItem: (al, pr) => { const it = { priority: pr, texts: [], shown: false, _t: '', show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
      Object.defineProperty(it, 'text', { get() { return this._t; }, set(v) { this._t = v; this.texts.push(v); } }); items.push(it); return it; },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), createTerminal: () => mkProxy('terminal'),
    showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, showInformationMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }), onDidChangeActiveTextEditor: () => ({ dispose() {} }), onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    createTreeView: () => ({ dispose() {}, onDidChangeVisibility() {} }), registerTreeDataProvider: () => ({ dispose() {} }), tabGroups: undefined
  },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {}, getCommands: async () => [] },
  tasks: {
    onDidEndTaskProcess: (fn) => { const l = { fn, dispose() { const i = endListeners.indexOf(l); if (i >= 0) endListeners.splice(i, 1); } }; endListeners.push(l); return l; },
    executeTask: async (task) => { const ex = { task, terminate() {} }; started.push(task); return ex; }
  },
  extensions: { getExtension: () => undefined },
  Uri: { file: (p) => ({ fsPath: p }) },
  ProcessExecution: class { constructor(c, a, o) { this.process = c; this.args = a; this.options = o; } },
  Task: class { constructor(def, scope, name, source, exec, pm) { this.definition = def; this.name = name; this.execution = exec; } },
  TaskRevealKind: { Silent: 3 }, StatusBarAlignment: { Left: 1, Right: 2 }, ThemeColor: class {}, ViewColumn: { Beside: -2 }, ConfigurationTarget: { Global: 1 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 }
};
const wrap = (o, n) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : mkProxy(n + '.' + String(k))) });
for (const k of ['workspace', 'window', 'commands', 'tasks', 'extensions', 'languages']) base[k] = wrap(base[k] || {}, 'vscode.' + k);
const stub = new Proxy(base, { get: (t, k) => (k in t ? t[k] : mkProxy('vscode.' + String(k))) });
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : orig.call(this, r, ...a); };
const X = require(path.join(ext, 'extension.js'));
const ctx = { subscriptions: [], extensionPath: ext, globalState: { get: () => undefined, update: async () => {} }, workspaceState: { get: () => undefined, update: async () => {} },
  globalStorageUri: { fsPath: path.join(tmp, 'store') }, extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8')) } };
const tick = () => new Promise((r) => setTimeout(r, 20));
const endRun = async (code) => { const l = endListeners.slice(); for (const x of l) x.fn({ execution: { task: started[started.length - 1] }, exitCode: code }); await tick(); };
(async () => {
  try { await X.activate(ctx); } catch (e) { console.error('activate failed (stub too thin?)', e); process.exit(1); }
  assert.ok(cmds['tssworkflow.compile'], 'compile registered');
  const buildItem = items.find((i) => i.priority === 101), spin = items.find((i) => i.priority === 102);
  assert.ok(buildItem && spin, 'two status bar items');

  // passes = 3, singlePass = false: three runs of plain lualatex, one after another
  cfgv.singlePass = false; cfgv.passes = 3; cfgv.lualatex = 'lualatex';
  await cmds['tssworkflow.compile'](); await tick();
  assert.strictEqual(started.length, 1);
  assert.strictEqual(started[0].execution.process, 'lualatex');
  assert.ok(started[0].execution.args.some((a) => /\\input\{alone\.tex\}/.test(a)));
  assert.ok(/ · 1\/3 · /.test(buildItem.text), buildItem.text);
  await endRun(0); assert.strictEqual(started.length, 2); assert.ok(/ · 2\/3 · /.test(buildItem.text), buildItem.text);
  await endRun(0); assert.strictEqual(started.length, 3); assert.ok(/ · 3\/3 · /.test(buildItem.text), buildItem.text);
  await endRun(0); assert.strictEqual(started.length, 3, 'no fourth run');
  assert.ok(/готово/.test(buildItem.text) && /3 прохо/.test(buildItem.text), buildItem.text);
  assert.strictEqual(spin.shown, false, 'spinner hidden after the build');
  assert.deepStrictEqual(spin.texts, ['$(sync~spin)'], 'spinner text written once');
  assert.ok(!/sync~spin/.test(buildItem.texts.join('|')), 'no codicon in the ticking item');

  // a failure in the 2nd run stops the chain
  started.length = 0;
  await cmds['tssworkflow.compile'](); await tick(); await endRun(0); assert.strictEqual(started.length, 2);
  await endRun(1); assert.strictEqual(started.length, 2, 'chain stops on error');
  assert.ok(/помилки/.test(buildItem.text), buildItem.text);

  // passes = 0: latexmk, one task
  started.length = 0; cfgv.passes = 0;
  await cmds['tssworkflow.compile'](); await tick();
  assert.strictEqual(started.length, 1); assert.strictEqual(started[0].execution.process, 'latexmk');
  await endRun(0); assert.strictEqual(started.length, 1);

  // singlePass = true ignores passes
  started.length = 0; cfgv.singlePass = true; cfgv.passes = 5;
  await cmds['tssworkflow.compile'](); await tick(); await endRun(0);
  assert.strictEqual(started.length, 1); assert.strictEqual(started[0].execution.process, 'lualatex');
  console.log('passes + spinner: all ok');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
