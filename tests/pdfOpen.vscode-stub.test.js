'use strict';
// node tests/singleButton.vscode-stub.test.js [path/to/extension]
// which PDF the internal viewer gets after a build (0.18.1): with LaTeX Workshop installed, 'latex-workshop.tab' shows the PDF of ITS root,
// found from the active file; a file it cannot find a root for (a .tikz without \\documentclass and `% !TeX root`) would leave the previous PDF
// (e.g. the standalone one), so the PDF that was just built is opened by its path. Scaffold of singleButton.vscode-stub.test.js.
// extension.js on a stub of vscode: tssworkflow.passes runs the same command exactly N times, and the spinner is a
// separate status bar item whose text is written once per build (a codicon restarts its rotation when its item's text changes)
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'single-'));
fs.mkdirSync(path.join(tmp, 'Ch', 'tikz'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'Ch', 'tikz', 'fig.tikz'), '\\begin{tikzpicture}\\end{tikzpicture}\n');
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
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return { dispose() {} }; }, executeCommand: async (id, ...a) => { executed.push([id, ...a]); }, getCommands: async () => ['latex-workshop.tab', 'latex-workshop.view'] },
  tasks: {
    onDidEndTaskProcess: (fn) => { const l = { fn, dispose() { const i = endListeners.indexOf(l); if (i >= 0) endListeners.splice(i, 1); } }; endListeners.push(l); return l; },
    executeTask: async (task) => { const ex = { task, terminate() {} }; started.push(task); return ex; }
  },
  extensions: { getExtension: () => ({ id: 'James-Yu.latex-workshop' }) },
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
  tikz: mk(path.join('Ch', 'tikz', 'fig.tikz'), '\\begin{tikzpicture}\\end{tikzpicture}\n'),
  chapterRoot: mk(path.join('Ch', 'Ch.tex'), '% !TeX root = ../main.tex\n\\chapter{A}\n'),
  chapterBare: mk(path.join('Ch', 'Ch.tex'), '\\chapter{A}\n'),
  separate: mk(path.join('Note', 'note.tex'), '\\documentclass{article}\n\\begin{document}x\\end{document}')
};
const show = (kind) => { stub.window.activeTextEditor = { document: DOCS[kind], viewColumn: 1, selection: { isEmpty: true }, selections: [] }; };
(async () => {
  try { await X.activate(ctx); } catch (e) { console.error('activate failed (stub too thin?)', e); process.exit(1); }
  let n = 0;
  const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
  const ok = (c, m) => { assert.ok(c, m); n++; };
  cfgv.singlePass = true; cfgv.lualatex = 'lualatex';
  cfgv['compilePasses.chapter'] = 1; cfgv['compilePasses.separate'] = 1; cfgv['compilePasses.main'] = 1;
  const build = async (kind, cmd) => {
    show(kind);
    executed.length = 0;
    const before = started.length;
    await cmds[cmd || 'tssworkflow.compilePdf'](); await tick();
    if (started.length > before) { await endRun(0); await tick(); }
    await tick();
    return executed.map((e) => e[0]);
  };
  const openArg = () => executed.find((e) => e[0] === 'vscode.open');

  // a figure: the active file is a .tikz, LaTeX Workshop cannot find its root: the PDF is opened by its path
  let ids = await build('tikz');
  ok(ids.includes('vscode.open') && !ids.includes('latex-workshop.tab'), 'a .tikz: the PDF is opened by its path, not through latex-workshop.tab: ' + ids);
  eq(path.resolve(openArg()[1].fsPath), path.join(tmp, 'main.pdf'), 'and it is the PDF that was built (main.pdf), not the previous one');
  eq(openArg()[2].viewColumn, -2, 'beside, as the other ways of opening do (pdfBeside)');
  cfgv.pdfBeside = false;
  ids = await build('tikz');
  eq(openArg()[2].viewColumn, undefined, 'pdfBeside = false: in the current group');
  delete cfgv.pdfBeside;

  // a chapter with `% !TeX root`: LaTeX Workshop finds the root itself, as before
  ids = await build('chapterRoot');
  ok(ids.includes('latex-workshop.tab') && !ids.includes('vscode.open'), 'a chapter with a root comment: through LaTeX Workshop: ' + ids);

  // a file with its own \documentclass built on its own (Ctrl+F5): LaTeX Workshop knows it
  ids = await build('separate', 'tssworkflow.compileCurrent');
  ok(ids.includes('latex-workshop.tab') && !ids.includes('vscode.open'), 'a file with \\documentclass: through LaTeX Workshop: ' + ids);

  // a chapter with neither: nothing to find the root by, the PDF goes by its path
  ids = await build('chapterBare');
  ok(ids.includes('vscode.open') && !ids.includes('latex-workshop.tab'), 'neither \\documentclass nor a root comment: by its path: ' + ids);

  // openPdf.chapter = false: nothing is opened for a figure either
  cfgv['openPdf.chapter'] = false;
  ids = await build('tikz');
  ok(!ids.includes('vscode.open') && !ids.includes('latex-workshop.tab'), 'openPdf.chapter = false: no PDF');
  delete cfgv['openPdf.chapter'];

  // external viewer: unchanged (does not go through the two ways)
  cfgv.pdfViewer = 'none';
  ids = await build('tikz');
  ok(!ids.includes('vscode.open') && !ids.includes('latex-workshop.tab'), 'pdfViewer = none: no PDF');
  delete cfgv.pdfViewer;

  console.log('pdfOpen (stub): ' + n + ' checks passed');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
