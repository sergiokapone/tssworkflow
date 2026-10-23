'use strict';
// node tests/singleButton.vscode-stub.test.js [path/to/extension]
// the one build command (F5 and the button of the tab bar): what it builds for a chapter, a separate document and the main file,
// and whether the PDF is opened (tssworkflow.openPdf.main / .separate / .chapter). Scaffold of passes.vscode-stub.test.js.
// extension.js on a stub of vscode: tssworkflow.passes runs the same command exactly N times, and the spinner is a
// separate status bar item whose text is written once per build (a codicon restarts its rotation when its item's text changes)
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'single-'));
fs.mkdirSync(path.join(tmp, 'Ch'));
fs.writeFileSync(path.join(tmp, 'Ch', 'Ch.tex'), '\\chapter{A}\n');
fs.writeFileSync(path.join(tmp, 'alone.tex'), 'x');
fs.writeFileSync(path.join(tmp, 'main.tex'), '\\documentclass{book}\n');
fs.mkdirSync(path.join(tmp, 'Note'));
fs.writeFileSync(path.join(tmp, 'Note', 'note.tex'), '\\documentclass{article}\n');
const cmds = {}, items = [], started = [], endListeners = [], executed = [], warnings = [];
const cfgv = {};
const mkProxy = (name) => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => name : mkProxy(name + '.' + String(k))),
  apply: () => mkProxy(name + '()'), construct: () => mkProxy(name + '#')
});
const folder = { uri: { fsPath: tmp } };
const doc = { uri: { fsPath: path.join(tmp, 'Ch', 'Ch.tex') }, getText: () => '\\chapter{A}\n', languageId: 'latex', fileName: path.join(tmp, 'Ch', 'Ch.tex') };
const base = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in cfgv ? cfgv[k] : d), inspect: (k) => (k in cfgv ? { workspaceValue: cfgv[k] } : {}), update: async () => {} }),
    workspaceFolders: [folder], getWorkspaceFolder: () => folder, isTrusted: true,
    onDidSaveTextDocument: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }), onDidCreateFiles: () => ({ dispose() {} }),
    onDidDeleteFiles: () => ({ dispose() {} }), onDidRenameFiles: () => ({ dispose() {} }), textDocuments: [],
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} })
  },
  window: {
    activeTextEditor: { document: doc, viewColumn: 1, selection: { isEmpty: true } },
    createStatusBarItem: (al, pr) => { const it = { priority: pr, texts: [], writes: 0, shown: false, _t: '', show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
      for (const k of ['tooltip', 'command']) Object.defineProperty(it, k, { get() { return this['_' + k]; }, set(v) { this['_' + k] = v; this.writes++; } });
      Object.defineProperty(it, 'text', { get() { return this._t; }, set(v) { this._t = v; this.texts.push(v); } }); items.push(it); return it; },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), createTerminal: () => mkProxy('terminal'),
    showWarningMessage: async (m) => { warnings.push(m); return undefined; }, showErrorMessage: async () => undefined, showInformationMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }), onDidChangeActiveTextEditor: () => ({ dispose() {} }), onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    createTreeView: () => ({ dispose() {}, onDidChangeVisibility() {} }), registerTreeDataProvider: () => ({ dispose() {} }), tabGroups: undefined
  },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return { dispose() {} }; }, executeCommand: async (id, ...a) => { executed.push([id, ...a]); }, getCommands: async () => [] },
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

const mk = (rel, text) => { const f = path.join(tmp, rel); return { uri: { fsPath: f }, getText: () => text, languageId: 'latex', fileName: f, isDirty: false, save: async () => true }; };
const DOCS = {
  chapter: mk(path.join('Ch', 'Ch.tex'), '\\chapter{A}\n'),
  separate: mk(path.join('Note', 'note.tex'), '\\documentclass{article}\n\\begin{document}x\\end{document}'),
  main: mk('main.tex', '\\documentclass{book}\n'),
  cls: mk('My.cls', '\\ProvidesClass{My}')
};
const show = (kind) => { stub.window.activeTextEditor = { document: DOCS[kind], viewColumn: 1, selection: { isEmpty: true } }; };
const cwdOf = (task) => task.execution.options && task.execution.options.cwd;
(async () => {
  try { await X.activate(ctx); } catch (e) { console.error('activate failed (stub too thin?)', e); process.exit(1); }
  let n = 0;
  const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
  const ok = (c, m) => { assert.ok(c, m); n++; };
  cfgv.singlePass = true; cfgv.lualatex = 'lualatex';
  cfgv['compilePasses.chapter'] = 1; cfgv['compilePasses.separate'] = 1; cfgv['compilePasses.main'] = 1;
  const opened = () => executed.filter((e) => e[0] === 'vscode.open').length;
  const build = async (kind, finish = true) => {
    show(kind);
    const before = started.length;
    executed.length = 0;
    await cmds['tssworkflow.compilePdf'](); await tick();
    const tasks = started.slice(before);
    if (finish && tasks.length) { await endRun(0); await tick(); }
    return tasks;
  };
  const argsOf = (t) => [t.execution.process].concat(t.execution.args || []).join(' ');

  // the commands without a PDF are gone, the three that stay are there
  for (const id of ['tssworkflow.compile', 'tssworkflow.compileMain']) ok(!cmds[id], id + ' is not registered');
  for (const id of ['tssworkflow.compilePdf', 'tssworkflow.compileMainPdf', 'tssworkflow.compileCurrent']) ok(cmds[id], id + ' is registered');

  // a chapter: through the driver, as before
  let t = await build('chapter');
  eq(t.length, 1, 'one run for a chapter');
  ok(/alone\.tex/.test(argsOf(t[0])) && /TargetChapter\{Ch\}/.test(argsOf(t[0])), 'the chapter goes through the driver: ' + argsOf(t[0]));
  eq(opened(), 1, 'its PDF is opened');

  // a separate document: on its own (the file itself, in its folder), not through the driver and not main.tex
  t = await build('separate');
  eq(t.length, 1, 'one run for a separate document');
  ok(/note\.tex/.test(argsOf(t[0])) && !/alone\.tex|TargetChapter|main\.tex/.test(argsOf(t[0])), 'the file itself: ' + argsOf(t[0]));
  eq(path.resolve(cwdOf(t[0])), path.join(tmp, 'Note'), 'built in the folder of the file');
  eq(opened(), 1, 'its PDF is opened');
  eq(warnings.filter((w) => /documentclass/.test(w)).length, 0, 'no warning about \\documentclass any more');

  // the main file: the whole document
  t = await build('main');
  eq(t.length, 1);
  ok(/main\.tex/.test(argsOf(t[0])), 'the main file builds main.tex: ' + argsOf(t[0]));
  eq(opened(), 1, 'its PDF is opened');

  // the same one command opens the PDF only for the kinds that are not switched off
  for (const [kind, key] of [['chapter', 'openPdf.chapter'], ['separate', 'openPdf.separate'], ['main', 'openPdf.main']]) {
    cfgv[key] = false;
    t = await build(kind);
    eq(t.length, 1, kind + ': the build still runs');
    eq(opened(), 0, kind + ': ' + key + ' = false: the PDF is not opened');
    for (const other of [['chapter', 'openPdf.chapter'], ['separate', 'openPdf.separate'], ['main', 'openPdf.main']]) {
      if (other[0] === kind) continue;
      await build(other[0]);
      eq([other[0], opened()], [other[0], 1], other[0] + ' is not affected by ' + key);
    }
    delete cfgv[key];
    t = await build(kind);
    eq(opened(), 1, kind + ': back on: the PDF is opened');
  }

  // Shift+F5 (compileMainPdf) follows the main setting; Ctrl+F5 (compileCurrent) the separate one
  show('chapter'); executed.length = 0; cfgv['openPdf.main'] = false;
  await cmds['tssworkflow.compileMainPdf'](); await tick(); await endRun(0);
  eq(opened(), 0, 'compileMainPdf: openPdf.main = false');
  delete cfgv['openPdf.main'];
  show('separate'); executed.length = 0; cfgv['openPdf.separate'] = false;
  await cmds['tssworkflow.compileCurrent'](); await tick(); await endRun(0);
  eq(opened(), 0, 'compileCurrent: openPdf.separate = false');
  delete cfgv['openPdf.separate'];
  show('separate'); executed.length = 0;
  await cmds['tssworkflow.compileCurrent'](); await tick(); await endRun(0);
  eq(opened(), 1, 'compileCurrent opens the PDF by default');

  // a class or a package is not a document: a warning with the offer to build the whole one, no build
  show('cls'); const before = started.length; warnings.length = 0;
  await cmds['tssworkflow.compilePdf'](); await tick();
  eq(started.length, before, 'a .cls does not start a build');
  ok(warnings.some((w) => /клас чи пакет/.test(w)), 'and says why');

  // the status bar says the same: the label of the kind, the command of the tab-bar button for everything but Separate
  const status = items.find((i) => i.priority === 100);
  show('separate');
  ok(status, 'the status bar item exists');
  console.log('singleButton: ' + n + ' checks passed');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
