'use strict';
// node tests/lwGuard.vscode-stub.test.js [path/to/extension]
// activate() on a stubbed vscode, the list of processes is a script of the test: the build of this extension (the button, the
// automatic build on save, a clean) does not start while LaTeX Workshop builds the same job, and what the three buttons of the
// question do (wait, stop LaTeX Workshop, start anyway). Nothing runs for real: tasks and processes are stubs.
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const pk = require(path.join(ext, 'package.json'));

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-lwg-'));
const w = (rel, txt) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
w('main.tex', '\\documentclass{book}\n\\begin{document}x\\end{document}\n');
w('alone.tex', '\\documentclass{book}\n');
const CHAP = w('Ch/Ch.tex', '\\chapter{A}\ntext\n');

const handler = { get: (t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const disp = { dispose() {} };

// ---- the script of the test ----
const S = {
  lw: true,                 // is LaTeX Workshop installed
  settings: {},             // tssworkflow.* values
  ps: [],                   // the list of processes: array of lines for ps, or a function (call number) -> lines
  psFail: false,            // the listing command fails
  psCalls: 0,
  pick: undefined,          // what the user clicks in a warning (a title), or a function (message, buttons) -> Promise
  warnings: [],             // { message, buttons }
  started: [],              // tasks that really started
  executed: [],             // commands executed through vscode.commands.executeCommand
  statusMsgs: [],
  endTask: null             // the listener of onDidEndTaskProcess
};
const lwLine = (job) => ' 4242 /usr/bin/perl /usr/bin/latexmk -synctex=1 -lualatex -outdir=' + proj + ' "' + path.join(proj, job) + '"';

const commands = {}, items = [], editorListeners = [];
const folder = { uri: { fsPath: proj, toString: () => 'file://' + proj }, name: 'p', index: 0 };
const cfg = {
  get: (k, d) => (k in S.settings ? S.settings[k] : d),
  update: async () => {}, has: () => false, inspect: (k) => ({ globalValue: k in S.settings ? S.settings[k] : undefined })
};
const mkDoc = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  return { uri: { fsPath: file, path: file, scheme: 'file', toString: () => 'file://' + file }, languageId: 'latex', getText: () => text, lineCount: text.split('\n').length, isDirty: false, fileName: file, lineAt: (i) => ({ text: text.split('\n')[i] || '' }) };
};
let active;
const setActive = (file) => {
  active = { document: mkDoc(file), selection: { active: { line: 0, character: 0 } }, selections: [] };
  vscode.window.activeTextEditor = active;
  editorListeners.forEach((f) => f(active));
};
const vscode = mk({
  commands: mk({
    registerCommand: (id, fn) => { commands[id] = fn; return disp; }, registerTextEditorCommand: (id, fn) => { commands[id] = fn; return disp; },
    executeCommand: async (id, ...a) => { S.executed.push(id); return undefined; }, getCommands: async () => []
  }),
  window: mk({
    activeTextEditor: undefined, visibleTextEditors: [], textEditors: [], terminals: [], tabGroups: mk({ all: [], onDidChangeTabs: () => disp }),
    createStatusBarItem: (al, pr) => { const it = { priority: pr, text: '', tooltip: '', command: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; items.push(it); return it; },
    onDidChangeActiveTextEditor: (f) => { editorListeners.push(f); return disp; },
    showWarningMessage: (message, ...buttons) => {
      S.warnings.push({ message, buttons });
      const p = typeof S.pick === 'function' ? S.pick(message, buttons) : S.pick;
      return Promise.resolve(p);
    },
    showInformationMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: (m) => { S.statusMsgs.push(m); return disp; },
    withProgress: async (opts, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disp })
  }),
  workspace: mk({ workspaceFolders: [folder], textDocuments: [], getConfiguration: () => cfg, getWorkspaceFolder: () => folder, findFiles: async () => [] }),
  extensions: mk({ all: [], getExtension: (id) => (id === 'James-Yu.latex-workshop' && S.lw ? { id, isActive: true, packageJSON: { version: '10.0.0' } } : undefined) }),
  tasks: mk({
    onDidEndTaskProcess: (f) => { S.endTask = f; return disp; },
    executeTask: async (task) => { S.started.push(task); return { task, terminate() {} }; }
  }),
  Task: class { constructor(definition, scope, name, source, execution) { this.definition = definition; this.name = name; this.execution = execution; } },
  ProcessExecution: class { constructor(cmd, args, opts) { this.cmd = cmd; this.args = args; this.opts = opts; } },
  ProgressLocation: { Notification: 15 },
  TaskRevealKind: { Silent: 3 },
  env: mk({ language: 'uk', appName: 'x', uiKind: 1, remoteName: undefined }),
  version: '1.141.0'
});

const realCp = require('child_process');
const load = Module._load;
Module._load = function (req, ...a) {
  if (req === 'vscode') return vscode;
  if (req === 'child_process') {
    return Object.assign({}, realCp, {
      spawn: () => ({ on() {}, unref() {} }),
      execFile: (cmd, args, opts, cb) => {
        if (cmd !== 'ps' && cmd !== 'powershell.exe') return realCp.execFile(cmd, args, opts, cb);
        S.psCalls++;
        const lines = typeof S.ps === 'function' ? S.ps(S.psCalls) : S.ps;
        // on Windows the guard asks PowerShell for JSON (Get-CimInstance): the same lines in that form
        const out = cmd === 'powershell.exe'
          ? JSON.stringify(lines.map((l) => /^\s*(\d+)\s+(.*\S)\s*$/.exec(l)).filter(Boolean).map((m) => ({ ProcessId: +m[1], Name: 'perl.exe', CommandLine: m[2] })))
          : lines.join('\n') + '\n';
        setImmediate(() => (S.psFail ? cb(new Error('no ps'), '', '') : cb(null, out, '')));
        return { on() {}, kill() {} };
      }
    });
  }
  return load.call(this, req, ...a);
};
const ctx = { subscriptions: [], extensionUri: { fsPath: ext, path: ext }, extensionPath: ext, globalState: { get: () => undefined, update: async () => {}, keys: () => [] }, workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] }, asAbsolutePath: (p) => path.join(ext, p), globalStorageUri: { fsPath: path.join(os.tmpdir(), 'tss-gs') }, extension: { packageJSON: pk } };

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BTN = { wait: 'Дочекатися й запустити', stop: 'Зупинити збірку LaTeX Workshop', force: 'Все одно запустити' };

// a clean slate for a scenario; the build that a scenario started is ended, so that the next one is not "busy"
async function reset(over) {
  S.lw = true; S.settings = Object.assign({ 'openPdf.chapter': false, 'openPdf.main': false }, over || {}); S.ps = []; S.psFail = false; S.psCalls = 0; S.pick = undefined;
  S.warnings = []; S.started = []; S.executed = []; S.statusMsgs = [];
  require(path.join(ext, 'lwGuard.js')).reset(); // forget the reading of the previous scenario (one second of cache)
}
async function endBuild() {
  if (!S.started.length) return;
  const task = S.started[S.started.length - 1];
  S.endTask({ execution: { task }, exitCode: 0 });
  await sleep(20);
}
const press = async () => { await commands['tssworkflow.compilePdf'](); await sleep(30); };

(async () => {
  await require(path.join(ext, 'extension.js')).activate(ctx);
  setActive(CHAP);

  // 1. LaTeX Workshop builds main, the user presses the button and closes the question: nothing starts
  await reset({});
  S.ps = [lwLine('main')];
  await press();
  eq(S.started.length, 0, 'no build while LaTeX Workshop builds main');
  eq(S.warnings.length, 1, 'one question');
  ok(/LaTeX Workshop/.test(S.warnings[0].message) && /«main»/.test(S.warnings[0].message) && /PID 4242/.test(S.warnings[0].message), 'the message names the build: ' + S.warnings[0].message);
  eq(S.warnings[0].buttons, [BTN.wait, BTN.stop, BTN.force], 'three buttons');

  // 2. "start anyway": the build starts
  await reset({});
  S.ps = [lwLine('main')]; S.pick = BTN.force;
  await press();
  eq(S.started.length, 1, 'started on the user\'s word');
  await endBuild();

  // 3. nothing runs: no question, the build starts
  await reset({});
  S.ps = [' 1 code ' + path.join(proj, 'main.tex'), ' 2 latexmk -pdf "/somewhere/else/main"'];
  await press();
  eq(S.warnings.length, 0, 'no question');
  eq(S.started.length, 1, 'the build started');
  await endBuild();

  // 4. LaTeX Workshop builds another job (alone): our main build is free to start
  await reset({});
  S.ps = [lwLine('alone')];
  await press();
  eq([S.warnings.length, S.started.length], [0, 1], 'another job is not a conflict');
  await endBuild();

  // 5. the switch is off: the list is not even read
  await reset({ lwGuard: 'off' });
  S.ps = [lwLine('main')];
  await press();
  eq([S.psCalls, S.warnings.length, S.started.length], [0, 0, 1], 'off: no reading, no question');
  await endBuild();

  // 6. without LaTeX Workshop: nothing to check, the list is not read
  await reset({});
  S.lw = false; S.ps = [lwLine('main')];
  await press();
  eq([S.psCalls, S.warnings.length, S.started.length], [0, 0, 1], 'no LaTeX Workshop: not checked');
  await endBuild();

  // 7. scope "project": a build of any file of the project blocks
  await reset({ lwGuard: 'project' });
  S.ps = [lwLine('Other/thing')];
  await press();
  eq([S.warnings.length, S.started.length], [1, 0], 'project scope');
  await reset({ lwGuard: 'job' });
  S.ps = [lwLine('Other/thing')];
  await press();
  eq([S.warnings.length, S.started.length], [0, 1], 'job scope: another file is not a conflict');
  await endBuild();

  // 8. the list cannot be read: the build starts as before
  await reset({});
  S.psFail = true;
  await press();
  eq([S.warnings.length, S.started.length], [0, 1], 'an unreadable list never blocks');
  await endBuild();

  // 9. "wait": LaTeX Workshop is busy for the first reading and free for the second one; the build starts after that
  await reset({});
  S.ps = (call) => (call <= 2 ? [lwLine('main')] : []); // call 1: the check, call 2: the first reading of the wait, call 3: free
  S.pick = BTN.wait;
  const t0 = Date.now();
  await commands['tssworkflow.compilePdf']();
  await sleep(30);
  eq(S.started.length, 1, 'started after LaTeX Workshop had finished');
  ok(Date.now() - t0 >= 1000, 'it really waited a step (' + (Date.now() - t0) + ' ms)');
  ok(S.psCalls >= 3, 'the list was read again: ' + S.psCalls);
  await endBuild();

  // 10. "stop LaTeX Workshop": its kill command is run, then the build starts once the process is gone
  await reset({});
  S.ps = () => (S.executed.includes('latex-workshop.kill') ? [] : [lwLine('main')]);
  S.pick = BTN.stop;
  await press();
  ok(S.executed.includes('latex-workshop.kill'), 'latex-workshop.kill was run');
  eq(S.started.length, 1, 'started after the stop');
  await endBuild();

  // 11. the automatic build (Auto on save): skipped quietly, with a line in the status bar, no question
  await reset({});
  S.ps = [lwLine('main')];
  const build = require(path.join(ext, 'build.js'));
  build.compileOnSave(active.document);
  await sleep(60);
  eq([S.warnings.length, S.started.length], [0, 0], 'the automatic build neither asks nor starts');
  ok(S.statusMsgs.some((m) => /LaTeX Workshop/.test(m) && /main/.test(m)), 'a line in the status bar: ' + JSON.stringify(S.statusMsgs));
  // and when LaTeX Workshop is not building, the automatic build starts
  await reset({});
  S.ps = [];
  build.compileOnSave(active.document);
  await sleep(60);
  eq(S.started.length, 1, 'the automatic build started');
  await endBuild();

  // 12. the same question is not asked twice: a second press while the first question is open does nothing
  await reset({});
  S.ps = [lwLine('main')];
  let release;
  S.pick = () => new Promise((r) => { release = r; });
  const first = commands['tssworkflow.compilePdf']();
  await sleep(40);
  await commands['tssworkflow.compilePdf']();
  await sleep(40);
  eq(S.warnings.length, 1, 'one question on the screen');
  release(undefined);
  await first;
  await sleep(20);
  eq(S.started.length, 0, 'the first question was closed: nothing started');
  // the next press works again
  S.pick = BTN.force;
  await press();
  eq(S.started.length, 1, 'the guard is released after the answer');
  await endBuild();

  // 13. clean: files that LaTeX Workshop writes are not deleted; "start anyway" deletes them
  await reset({});
  const aux = w('main.aux', 'aux');
  S.ps = [lwLine('main')];
  await commands['tssworkflow.cleanAux'](); await sleep(30);
  ok(fs.existsSync(aux), 'main.aux stays while LaTeX Workshop builds');
  ok(/прибирання/.test(S.warnings[0].message), 'the question speaks of the clean: ' + S.warnings[0].message);
  S.pick = BTN.force;
  await commands['tssworkflow.cleanAux'](); await sleep(30);
  ok(!fs.existsSync(aux), 'deleted on the user\'s word');
  await reset({});
  const aux2 = w('main.aux', 'aux');
  S.ps = [];
  await commands['tssworkflow.cleanAux'](); await sleep(30);
  ok(!fs.existsSync(aux2), 'a clean with nothing running is immediate');

  // 14. the setting is declared and has the default that the code uses
  const decl = pk.contributes.configuration.properties ? pk.contributes.configuration.properties['tssworkflow.lwGuard'] : [].concat(pk.contributes.configuration).map((c) => c.properties['tssworkflow.lwGuard']).find(Boolean);
  eq([decl.default, decl.enum], ['job', ['job', 'project', 'off']], 'the declared setting');

  fs.rmSync(proj, { recursive: true, force: true });
  console.log('lwGuard.vscode-stub: ' + n + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
