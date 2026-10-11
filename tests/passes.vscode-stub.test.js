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
fs.writeFileSync(path.join(tmp, 'main.tex'), '\\documentclass{book}\n');
fs.mkdirSync(path.join(tmp, 'Note'));
fs.writeFileSync(path.join(tmp, 'Note', 'note.tex'), '\\documentclass{article}\n');
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

  // the old passes = 0 (latexmk decides) is the default now: one run of lualatex; latexmk is asked for with compilePasses.chapter = 0
  started.length = 0; cfgv.passes = 0;
  await cmds['tssworkflow.compile'](); await tick();
  assert.strictEqual(started.length, 1); assert.strictEqual(started[0].execution.process, 'lualatex', 'singlePass = false and passes = 0: the default of one run');
  await endRun(0);
  started.length = 0; cfgv['compilePasses.chapter'] = 0;
  await cmds['tssworkflow.compile'](); await tick();
  assert.strictEqual(started.length, 1); assert.strictEqual(started[0].execution.process, 'latexmk', 'compilePasses.chapter = 0: latexmk');
  await endRun(0); assert.strictEqual(started.length, 1);
  delete cfgv['compilePasses.chapter'];

  // singlePass = true ignores passes
  started.length = 0; cfgv.singlePass = true; cfgv.passes = 5;
  await cmds['tssworkflow.compile'](); await tick(); await endRun(0);
  assert.strictEqual(started.length, 1); assert.strictEqual(started[0].execution.process, 'lualatex');
  // the spinner item is never written after it is shown, however long the build runs; with buildSeconds = false the text item is static too
  started.length = 0; cfgv.singlePass = true; cfgv.buildSeconds = true;
  spin.writes = 0; spin.texts.length = 0; buildItem.texts.length = 0;
  await cmds['tssworkflow.compile'](); await tick();
  const w0 = spin.writes;
  await new Promise((r) => setTimeout(r, 2300));
  assert.strictEqual(spin.writes, w0, 'no property writes to the spinner item while the build runs');
  assert.deepStrictEqual(spin.texts, ['$(sync~spin)']);
  assert.ok(buildItem.texts.length >= 3, 'seconds tick in the text item: ' + buildItem.texts.join('|'));
  await endRun(0);
  cfgv.buildSeconds = false; buildItem.texts.length = 0;
  await cmds['tssworkflow.compile'](); await tick();
  await new Promise((r) => setTimeout(r, 2300));
  assert.ok(buildItem.texts.length <= 2, 'text item is static with buildSeconds = false: ' + buildItem.texts.join('|'));
  assert.ok(!/ с$/.test(buildItem.texts[0] || ''), buildItem.texts[0]);
  await endRun(0);

  // ---- compilePasses.*: main 4, separate 2, chapter / figure 1 (the numbers of the spinner are these numbers)
  cfgv.singlePass = true; delete cfgv.passes; cfgv.showPasses = true; cfgv.buildSeconds = true;
  const spinTxt = () => buildItem.text;
  const exeOf = (t) => t.execution.process;
  const runAll = async (n, hook) => { for (let i = 1; i <= n; i++) { if (hook) hook(i); await endRun(0); } };
  // a chapter: one run, and the spinner says 1/1
  started.length = 0;
  await cmds['tssworkflow.compile'](); await tick();
  assert.strictEqual(started.length, 1); assert.ok(/ · 1\/1 · /.test(spinTxt()), 'a chapter: ' + spinTxt());
  await endRun(0); assert.strictEqual(started.length, 1, 'one run of a chapter');
  // the whole document: 4 runs of lualatex by default, no latexmk, no -g
  started.length = 0;
  await cmds['tssworkflow.compileMain'](); await tick();
  assert.strictEqual(exeOf(started[0]), 'lualatex'); assert.ok(!started[0].execution.args.includes('-g') && !started[0].execution.args.includes('-lualatex'), JSON.stringify(started[0].execution.args));
  assert.strictEqual(started[0].execution.args[started[0].execution.args.length - 1], 'main.tex');
  for (let i = 1; i <= 4; i++) { assert.ok(new RegExp(' · ' + i + '/4 · ').test(spinTxt()), i + ': ' + spinTxt()); assert.strictEqual(started.length, i); await endRun(0); }
  assert.strictEqual(started.length, 4, 'four runs, not five'); assert.ok(/готово/.test(buildItem.text) && /4 прохо/.test(buildItem.text), buildItem.text);
  // the number is set: 3 (and 9 is the largest)
  started.length = 0; cfgv['compilePasses.main'] = 3;
  await cmds['tssworkflow.compileMain'](); await tick(); await runAll(3);
  assert.strictEqual(started.length, 3, 'compilePasses.main = 3'); delete cfgv['compilePasses.main'];
  // 0: latexmk decides
  started.length = 0; cfgv['compilePasses.main'] = 0;
  await cmds['tssworkflow.compileMain'](); await tick();
  assert.strictEqual(exeOf(started[0]), 'latexmk'); assert.ok(started[0].execution.args.includes('-lualatex')); await endRun(0); assert.strictEqual(started.length, 1);
  delete cfgv['compilePasses.main'];
  // biber between the first and the second run when main.bcf exists; a failed biber does not stop the runs
  started.length = 0;
  await cmds['tssworkflow.compileMain'](); await tick();
  fs.writeFileSync(path.join(tmp, 'main.bcf'), 'x');
  await endRun(0);
  assert.strictEqual(exeOf(started[1]), 'biber'); assert.deepStrictEqual(started[1].execution.args, ['main']);
  assert.ok(/ · 1\/4 · /.test(spinTxt()), 'during biber the run counter stays: ' + spinTxt());
  await endRun(2);
  assert.strictEqual(exeOf(started[2]), 'lualatex'); assert.ok(/ · 2\/4 · /.test(spinTxt()), spinTxt());
  await runAll(3); assert.strictEqual(started.length, 5, '4 runs and biber'); assert.ok(/готово/.test(buildItem.text), buildItem.text);
  fs.unlinkSync(path.join(tmp, 'main.bcf'));
  // bibtex when there is no .bcf but the .aux asks for a database
  started.length = 0;
  await cmds['tssworkflow.compileMain'](); await tick();
  fs.writeFileSync(path.join(tmp, 'main.aux'), '\\bibdata{lit}\n');
  await endRun(0); assert.strictEqual(exeOf(started[1]), 'bibtex');
  await runAll(4); assert.strictEqual(started.length, 5);
  fs.unlinkSync(path.join(tmp, 'main.aux'));
  // no bibliography: no tool, 4 runs
  started.length = 0;
  await cmds['tssworkflow.compileMain'](); await tick(); await runAll(4);
  assert.strictEqual(started.length, 4); assert.ok(started.every((t) => exeOf(t) === 'lualatex'));
  // a failed run of the engine stops the chain
  started.length = 0;
  await cmds['tssworkflow.compileMain'](); await tick(); await endRun(0); await endRun(1);
  assert.strictEqual(started.length, 2, 'the failure of a run of the engine stops the chain'); assert.ok(/помилки/.test(buildItem.text), buildItem.text);
  // a file with its own preamble: 2 runs by default, in its own folder
  const noteDoc = { uri: { fsPath: path.join(tmp, 'Note', 'note.tex') }, getText: () => '\\documentclass{article}\n', languageId: 'latex', fileName: path.join(tmp, 'Note', 'note.tex'), isDirty: false };
  const prevEd = stub.window.activeTextEditor;
  stub.window.activeTextEditor = { document: noteDoc, viewColumn: 1, selection: { isEmpty: true } };
  started.length = 0;
  await cmds['tssworkflow.compileCurrent'](); await tick();
  assert.strictEqual(exeOf(started[0]), 'lualatex'); assert.strictEqual(started[0].execution.options.cwd, path.join(tmp, 'Note'));
  assert.strictEqual(started[0].execution.args[started[0].execution.args.length - 1], 'note.tex');
  assert.ok(/ · 1\/2 · /.test(spinTxt()), spinTxt()); await endRun(0); assert.ok(/ · 2\/2 · /.test(spinTxt()), spinTxt()); await endRun(0);
  assert.strictEqual(started.length, 2, 'two runs of a separate file');
  cfgv['compilePasses.separate'] = 5; started.length = 0;
  await cmds['tssworkflow.compileCurrent'](); await tick(); await runAll(5); assert.strictEqual(started.length, 5); delete cfgv['compilePasses.separate'];
  cfgv['compilePasses.separate'] = 0; started.length = 0;
  await cmds['tssworkflow.compileCurrent'](); await tick(); assert.strictEqual(exeOf(started[0]), 'latexmk'); await endRun(0); delete cfgv['compilePasses.separate'];
  stub.window.activeTextEditor = prevEd;
  // a chapter with its own number
  cfgv['compilePasses.chapter'] = 2; started.length = 0;
  await cmds['tssworkflow.compile'](); await tick(); assert.ok(/ · 1\/2 · /.test(spinTxt()), spinTxt()); await runAll(2); assert.strictEqual(started.length, 2); delete cfgv['compilePasses.chapter'];
  console.log('passes + spinner: all ok');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
