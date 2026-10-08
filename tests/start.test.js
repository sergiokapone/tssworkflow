'use strict';
// node tests/start.test.js [path/to/extension]
// 0.4.3: welcome view without .tex, context key hasTex, generated settings.json, main file choice, PATH search, environment report
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const P = require(path.join(ext, 'corePure.js'));
const pk = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const implicitActivation = (p) => { const m = /^\^?(\d+)\.(\d+)/.exec(p.engines.vscode); return !!m && (+m[1] > 1 || +m[2] >= 74); }; // onView / onCommand are generated from contributes since VS Code 1.74
let n = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

/* ------------------------------ manifest ------------------------------ */
t('manifest: both versions are equal', () => {
  const m = fs.readFileSync(path.join(ext, '..', 'extension.vsixmanifest'), 'utf8');
  assert.strictEqual(/Identity[^>]*Version="([^"]+)"/.exec(m)[1], pk.version);
});
t('manifest: panels need hasTex, the start view needs its absence, TODO view too', () => {
  const c = pk.contributes;
  const by = (arr, id) => arr.find((v) => v.id === id);
  assert.strictEqual(by(c.views.tssworkflow, 'tssworkflow.commandsView').when, 'tssworkflow.hasTex');
  assert.strictEqual(by(c.views.tssworkflow, 'tssworkflow.chaptersView').when, 'tssworkflow.hasTex');
  assert.strictEqual(by(c.views.tssworkflow, 'tssworkflow.startView').when, '!tssworkflow.hasTex');
  assert.ok(/tssworkflow\.hasTex/.test(by(c.views.explorer, 'tssworkflow.todoView').when));
  assert.ok(implicitActivation(pk), 'the start view activates the extension by itself: engines.vscode >= 1.74');
});
t('manifest: welcome buttons call real commands', () => {
  const ids = new Set(pk.contributes.commands.map((x) => x.command));
  const w = pk.contributes.viewsWelcome.filter((x) => x.view === 'tssworkflow.startView');
  assert.ok(w.length >= 2);
  const text = w.map((x) => x.contents).join('\n');
  for (const m of text.matchAll(/\(command:([^)]+)\)/g)) assert.ok(ids.has(m[1]) || m[1].startsWith('workbench.'), m[1]);
  assert.ok(text.includes('command:tssworkflow.newFromTemplate') && text.includes('command:tssworkflow.initProjectSettings'));
});
t('manifest: new command and setting are declared', () => {
  assert.ok(pk.contributes.commands.some((c) => c.command === 'tssworkflow.checkEnvironment'));
  assert.strictEqual(pk.contributes.configuration.properties['tssworkflow.checkEnvironmentOnStart'].default, true);
  assert.ok(!('tssworkflow.buildSpinner' in pk.contributes.configuration.properties));
});

/* -------------------------------- pure -------------------------------- */
t('pickMainTex: single, main.tex, driver ignored, ask, default', () => {
  assert.deepStrictEqual(P.pickMainTex(['MagFieldVacuum.tex', 'a.png']), { file: 'MagFieldVacuum.tex', source: 'single' });
  assert.deepStrictEqual(P.pickMainTex(['b.tex', 'main.tex', 'c.tex']), { file: 'main.tex', source: 'main' });
  assert.deepStrictEqual(P.pickMainTex(['alone.tex', 'book.tex'], 'alone.tex'), { file: 'book.tex', source: 'single' });
  assert.deepStrictEqual(P.pickMainTex(['alone.tex'], 'alone.tex'), { file: 'alone.tex', source: 'single' });
  assert.deepStrictEqual(P.pickMainTex(['b.tex', 'a.tex']), { choose: ['a.tex', 'b.tex'] });
  assert.deepStrictEqual(P.pickMainTex(['readme.md']), { file: 'main.tex', source: 'default' });
});
t('buildProjectSettings: mainFile, jobname, macroFiles, texlogsieve are conditional', () => {
  const a = P.buildProjectSettings({ mainFile: 'MagFieldVacuum.tex', macroFiles: [], texlogsieve: false });
  assert.strictEqual(a['tssworkflow.mainFile'], 'MagFieldVacuum.tex');
  assert.strictEqual(a['tssworkflow.jobname'], 'MagFieldVacuum');
  assert.ok(!('tssworkflow.macroFiles' in a) && !('tssworkflow.logParser' in a) && !('tssworkflow.texlogsieveTerminal' in a));
  assert.strictEqual(a['tssworkflow.singlePass'], false);
  assert.strictEqual(a['tssworkflow.quoteStyle'], 'enquote');
  assert.strictEqual(a['files.exclude']['**/.vscode'], false);
  assert.strictEqual(a['files.exclude']['**/*.aux'], true);
  assert.deepStrictEqual(a['latex-workshop.hover.preview.mathjax.extensions'], ['boldsymbol']);
  const b = P.buildProjectSettings({ mainFile: 'main.tex', macroFiles: ['sty/x.sty'], texlogsieve: true });
  assert.deepStrictEqual(b['tssworkflow.macroFiles'], ['sty/x.sty']);
  assert.strictEqual(b['tssworkflow.logParser'], 'texlogsieve');
  assert.strictEqual(b['tssworkflow.texlogsieveTerminal'], 'always');
  for (const k of Object.keys(b)) assert.ok(/^(tssworkflow|latex-workshop|files)\./.test(k), k);
  // every tssworkflow key of the template is a declared setting
  for (const k of Object.keys(b).filter((x) => x.startsWith('tssworkflow.'))) assert.ok(k in pk.contributes.configuration.properties, k);
});
t('mergeMissingSettings: comment lines above nested keys, text stays valid JSONC', () => {
  const s = P.buildProjectSettings({ mainFile: 'a.tex' });
  const r = P.mergeMissingSettings('', s, P.PROJECT_SETTINGS_COMMENTS);
  assert.ok(/\n {4}\/\/ --- Файли ---\n {4}"\*\*\/desktop\.ini": true,/.test(r.text), r.text.slice(-900));
  assert.ok(/\n {4}\/\/ --- Папки ---\n {4}"\*\*\/\.archive": true,/.test(r.text));
  assert.deepStrictEqual(P.parseSettings(r.text), JSON.parse(JSON.stringify(s)));
  // into an existing file: existing keys and comments stay, the second run adds nothing
  const old = '{\n  // мій коментар\n  "tssworkflow.mainFile": "x.tex",\n  "files.exclude": {"**/a": true}\n}\n';
  const m = P.mergeMissingSettings(old, s, P.PROJECT_SETTINGS_COMMENTS);
  assert.ok(m.text.includes('// мій коментар') && m.text.includes('"x.tex"'));
  assert.ok(!m.added.includes('tssworkflow.mainFile') && !m.added.includes('files.exclude'));
  assert.strictEqual(P.mergeMissingSettings(m.text, s, P.PROJECT_SETTINGS_COMMENTS).added.length, 0);
  assert.strictEqual(P.parseSettings(m.text)['tssworkflow.mainFile'], 'x.tex');
  assert.strictEqual(P.parseSettings('{ nope'), null);
  assert.deepStrictEqual(P.parseSettings('  '), {});
});
t('findInPath: posix and windows (PATHEXT), explicit path, missing', () => {
  const has = (set) => (f) => set.includes(f);
  assert.strictEqual(P.findInPath('latexmk', { platform: 'linux', env: { PATH: '/a:/b' }, exists: has(['/b/latexmk']) }), '/b/latexmk');
  assert.strictEqual(P.findInPath('latexmk', { platform: 'linux', env: { PATH: '/a' }, exists: has([]) }), null);
  assert.strictEqual(P.findInPath('', { platform: 'linux', env: {}, exists: () => true }), null);
  const w = { platform: 'win32', env: { Path: 'C:\\x;"C:\\tex\\bin"', PATHEXT: '.EXE;.CMD' } };
  assert.strictEqual(P.findInPath('texlogsieve', Object.assign({ exists: has(['C:\\tex\\bin\\texlogsieve.CMD']) }, w)), 'C:\\tex\\bin\\texlogsieve.CMD');
  assert.strictEqual(P.findInPath('SumatraPDF.exe', Object.assign({ exists: has(['C:\\x\\SumatraPDF.exe']) }, w)), 'C:\\x\\SumatraPDF.exe');
  assert.strictEqual(P.findInPath('C:\\Prog\\Sumatra', Object.assign({ exists: has(['C:\\Prog\\Sumatra.EXE']) }, w)), 'C:\\Prog\\Sumatra.EXE');
});
t('formatEnvReport: states, summary of what is missing', () => {
  const r = P.formatEnvReport([
    { name: 'latexmk', what: 'w', state: 'ok', detail: 'v' },
    { name: 'texlogsieve', what: 'w', state: 'missing', detail: 'не знайдено в PATH' },
    { name: 'git', what: 'w', state: 'optional', detail: 'x' }
  ], { folder: '/p' });
  assert.ok(r.includes('| latexmk | ✅ |') && r.includes('| texlogsieve | ❌ |') && r.includes('| git | ○ |'));
  assert.ok(r.includes('Бракує потрібного (1):** texlogsieve'));
  assert.ok(P.formatEnvReport([{ name: 'a', state: 'ok' }]).includes('Усе потрібне'));
});

/* ----------------------- vscode stub: start.js + features ------------------ */
function deepStub() {
  const make = () => new Proxy(function () {}, {
    get: (target, k) => (k in target && k !== 'name' && k !== 'length' && k !== 'prototype' ? target[k] : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : make()),
    apply: () => make(), construct: () => make()
  });
  return make();
}
let currentStub = null;
const origLoad = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? currentStub : origLoad.call(this, r, ...a); };
function load(stub, ...mods) {
  currentStub = stub;
  for (const m of Object.keys(require.cache)) if (m.startsWith(ext + path.sep) && !/pure\.js$/i.test(m)) delete require.cache[m];
  return mods.map((m) => require(path.join(ext, m)));
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'start-'));

t('start.js: key hasTex follows the files; start view is registered', async () => {
  const set = [];
  let files = [];
  let onCreate = null;
  const stub = {
    commands: { executeCommand: async (c, k, v) => { if (c === 'setContext') set.push([k, v]); } },
    window: { createTreeView: (id) => { set.views = (set.views || []).concat(id); return { dispose() {} }; } },
    workspace: {
      findFiles: async () => files,
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidSaveTextDocument: () => ({ dispose() {} }),
      createFileSystemWatcher: () => ({ onDidCreate: (f) => { onCreate = f; return { dispose() {} }; }, onDidDelete: () => ({ dispose() {} }), dispose() {} }),
      getConfiguration: () => ({ get: (k, d) => (k === 'checkEnvironmentOnStart' ? false : d) })
    }
  };
  const [S] = load(stub, 'start.js');
  const subs = [];
  S.register({ subscriptions: subs, globalState: { get: () => true, update: async () => {} } });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(set.slice(-1)[0], ['tssworkflow.hasTex', false]);
  assert.ok(set.views.includes('tssworkflow.startView'));
  files = [{ fsPath: '/p/a.tex' }];
  onCreate();
  await new Promise((r) => setTimeout(r, 450));
  assert.deepStrictEqual(set.slice(-1)[0], ['tssworkflow.hasTex', true]);
  const count = set.length;
  onCreate();
  await new Promise((r) => setTimeout(r, 450));
  assert.strictEqual(set.length, count, 'no repeated setContext for the same value');
  files = [];
  onCreate();
  await new Promise((r) => setTimeout(r, 450));
  assert.deepStrictEqual(set.slice(-1)[0], ['tssworkflow.hasTex', false]);
  // the provider of the start view is empty (the welcome text is shown for an empty view)
});

async function runInit(dirFiles, picks, cfgv, pre) {
  const proj = fs.mkdtempSync(path.join(tmp, 'p-'));
  fs.mkdirSync(path.join(proj, 'sty'));
  fs.writeFileSync(path.join(proj, 'sty', 'my.sty'), '');
  fs.writeFileSync(path.join(proj, 'root.sty'), '');
  for (const f of dirFiles) fs.writeFileSync(path.join(proj, f), '\\documentclass{article}');
  if (pre) { fs.mkdirSync(path.join(proj, '.vscode')); fs.writeFileSync(path.join(proj, '.vscode', 'settings.json'), pre); }
  const cmds = {};
  const stub = deepStub();
  const base = {
    workspaceFolders: [{ name: 'p', uri: { fsPath: proj } }],
    getConfiguration: () => ({ get: (k, d) => (k in cfgv ? cfgv[k] : d), update: async () => {} }),
    findFiles: async () => [{ fsPath: path.join(proj, 'sty', 'my.sty') }, { fsPath: path.join(proj, 'root.sty') }],
    textDocuments: [],
    onDidChangeConfiguration: () => ({ dispose() {} })
  };
  const shown = [];
  const asked = [];
  stub.workspace = new Proxy(base, { get: (o, k) => (k in o ? o[k] : deepStub()) });
  stub.window = new Proxy({
    showQuickPick: async (items, opt) => { asked.push(items.map((x) => x.label)); return picks.shift(); },
    showTextDocument: async (u) => { shown.push(u.fsPath); },
    showInformationMessage: async (m, ...b) => (b.includes('Додати') ? 'Додати' : undefined),
    showWarningMessage: async () => undefined,
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    activeTextEditor: undefined
  }, { get: (o, k) => (k in o ? o[k] : deepStub()) });
  stub.commands = { registerCommand: (id, fn) => { cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} };
  stub.Uri = { file: (p) => ({ fsPath: p }) };
  stub.RelativePattern = class { constructor(b, p) { this.base = b; this.pattern = p; } };
  const [F] = load(stub, 'features.js');
  F.register({ subscriptions: [], extensionPath: ext, globalState: { get: () => undefined, update: async () => {} } }, {});
  await cmds['tssworkflow.initProjectSettings'](proj);
  const file = path.join(proj, '.vscode', 'settings.json');
  return { proj, cmds, asked, shown, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, file };
}

t('initProjectSettings: the only .tex becomes mainFile, jobname follows, macroFiles from subfolders', async () => {
  const r = await runInit(['MagFieldVacuum.tex'], [], {});
  assert.ok(r.text, 'file created');
  const o = P.parseSettings(r.text);
  assert.strictEqual(o['tssworkflow.mainFile'], 'MagFieldVacuum.tex');
  assert.strictEqual(o['tssworkflow.jobname'], 'MagFieldVacuum');
  assert.deepStrictEqual(o['tssworkflow.macroFiles'], ['sty/my.sty']);
  assert.ok(r.text.includes('// --- Папки ---'));
  assert.strictEqual(r.asked.length, 0, 'no question');
});
t('initProjectSettings: main.tex wins over other files; several without main.tex -> question; Esc cancels', async () => {
  let r = await runInit(['main.tex', 'other.tex'], [], {});
  assert.strictEqual(P.parseSettings(r.text)['tssworkflow.mainFile'], 'main.tex');
  assert.strictEqual(r.asked.length, 0);
  r = await runInit(['b.tex', 'a.tex'], [{ label: 'b.tex' }], {});
  assert.deepStrictEqual(r.asked[0], ['a.tex', 'b.tex']);
  assert.strictEqual(P.parseSettings(r.text)['tssworkflow.jobname'], 'b');
  r = await runInit(['b.tex', 'a.tex'], [undefined], {});
  assert.strictEqual(r.text, null, 'cancelled: nothing created');
});
t('initProjectSettings: an empty folder gets main.tex; an existing mainFile is kept and not asked again', async () => {
  let r = await runInit([], [], {});
  assert.strictEqual(P.parseSettings(r.text)['tssworkflow.mainFile'], 'main.tex');
  // two files, but the settings already name the main one: no question, jobname follows it, the key is not duplicated
  r = await runInit(['x.tex', 'y.tex'], [], {}, '{\n  // мій коментар\n  "tssworkflow.mainFile": "y.tex"\n}\n');
  assert.strictEqual(r.asked.length, 0);
  const o = P.parseSettings(r.text);
  assert.strictEqual(o['tssworkflow.mainFile'], 'y.tex');
  assert.strictEqual(o['tssworkflow.jobname'], 'y');
  assert.ok(r.text.includes('// мій коментар'));
  assert.strictEqual((r.text.match(/tssworkflow\.mainFile/g) || []).length, 1);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + n + ' tests passed');
})();
