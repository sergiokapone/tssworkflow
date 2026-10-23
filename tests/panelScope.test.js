'use strict';
// node tests/panelScope.test.js [path/to/extension]
// The listeners of a webview panel live as long as the panel (util.panelScope). Before 0.20.0 the panels passed
// context.subscriptions as `disposables`: every opening of "Preview selection", the macro gallery or the formula overview left
// three more disposables there for good, each holding the closed panel. Here panels are opened and closed 40 times on a stub that
// behaves like VS Code (a listener registered with `disposables` is pushed there; dispose() fires onDidDispose).
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// a panel as VS Code makes it: every on* registers a listener, returns a disposable and, when `disposables` is given, pushes it there
function fakePanel(live) {
  const mkEvent = () => {
    const ls = [];
    const reg = (f, thisArg, disposables) => {
      const entry = { f, off: false };
      ls.push(entry); live.add(entry);
      const d = { dispose() { entry.off = true; live.delete(entry); } };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
    reg.fire = (...a) => ls.filter((e) => !e.off).forEach((e) => e.f(...a));
    return reg;
  };
  const dis = mkEvent(), view = mkEvent(), msg = mkEvent();
  const panel = {
    visible: true, active: true,
    reveal() {}, postMessage() {},
    dispose() { panel.disposed = true; dis.fire(); },
    onDidDispose: dis, onDidChangeViewState: view,
    webview: { html: '', cspSource: 'x', postMessage() {}, asWebviewUri: (u) => ({ toString: () => 'https://webview.test' + String(u) }), onDidReceiveMessage: msg, options: {} }
  };
  return panel;
}

t('panelScope: onGone runs, then every listener of the panel is disposed and the list is empty', () => {
  const live = new Set();
  const U = loadUtil();
  const panel = fakePanel(live);
  let gone = 0;
  const subs = U.panelScope(panel, () => { gone++; });
  panel.webview.onDidReceiveMessage(() => {}, null, subs);
  panel.onDidChangeViewState(() => {}, null, subs);
  assert.strictEqual(live.size, 3, 'two + the dispose listener itself');
  panel.dispose();
  assert.strictEqual(gone, 1);
  assert.strictEqual(live.size, 0, 'nothing of the panel stays registered');
  assert.deepStrictEqual(subs, [], 'the list is emptied');
});

t('panelScope: a throwing onGone does not leave the listeners behind', () => {
  const live = new Set();
  const U = loadUtil();
  const panel = fakePanel(live);
  const subs = U.panelScope(panel, () => { throw new Error('cleanup failed'); });
  panel.webview.onDidReceiveMessage(() => {}, null, subs);
  assert.throws(() => panel.dispose(), /cleanup failed/);
  assert.strictEqual(live.size, 0);
});

function loadUtil() {
  const orig = Module._load;
  Module._load = function (req, ...a) { return req === 'vscode' ? loadVs.vs : orig.call(this, req, ...a); };
  for (const k of Object.keys(require.cache)) if (k.startsWith(ext) && /\.js$/.test(k)) delete require.cache[k];
  try { return require(path.join(ext, 'util.js')); } finally { Module._load = orig; }
}

const handler = { get: (t0, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t0, k) => (k in o ? o[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const loadVs = { vs: mk({ Uri: class Uri { constructor(p) { this.path = p; this.fsPath = p; } toString() { return this.path; } static file(f) { return new Uri(f); } static joinPath(u, ...p) { return new Uri([u.path || ''].concat(p).join('/')); } } }) };

// opens and closes the panel of one module 40 times; returns the growth of context.subscriptions and the listeners still alive
function cycles(moduleFile, commandId, hooks) {
  const live = new Set();
  const handlers = {};
  const panels = [];
  const vs = mk({
    Uri: loadVs.vs.Uri, ViewColumn: { One: 1, Two: 2, Beside: -2 },
    commands: mk({ registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; } }),
    window: mk({
      activeTextEditor: undefined, visibleTextEditors: [],
      createWebviewPanel: () => { const p = fakePanel(live); panels.push(p); return p; }
    }),
    workspace: mk({ workspaceFolders: [], textDocuments: [], getConfiguration: () => ({ get: (k, d) => d, inspect: () => ({}) }) })
  });
  const orig = Module._load;
  Module._load = function (req, ...a) {
    if (req === 'vscode') return vs;
    if (req === './macros' && hooks && hooks.macros) return hooks.macros;
    return orig.call(this, req, ...a);
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(ext) && /\.js$/.test(k)) delete require.cache[k];
  try {
    const context = { subscriptions: [], extensionUri: new vs.Uri('/ext') };
    require(path.join(ext, moduleFile)).register(context);
    const base = context.subscriptions.length;
    handlers[commandId](); panels[panels.length - 1].dispose(); // the first cycle: lazy one-time things happen here
    const warm = context.subscriptions.length;
    for (let i = 0; i < 40; i++) {
      handlers[commandId]();
      assert.ok(panels[panels.length - 1] && !panels[panels.length - 1].disposed, 'the command opened a new panel');
      panels[panels.length - 1].dispose();
    }
    return { base, warm, after: context.subscriptions.length, live: live.size, opened: panels.length };
  } finally { Module._load = orig; }
}

for (const [file, cmd] of [['selectionPreview.js', 'tssworkflow.previewSelection'], ['macroGallery.js', 'tssworkflow.macroGallery'], ['formulaOverview.js', 'tssworkflow.formulaOverview']]) {
  t(file + ': 40 openings and closings do not grow context.subscriptions and leave no listener of a closed panel', () => {
    const r = cycles(file, cmd);
    assert.strictEqual(r.opened, 41, 'every command call opened a panel');
    assert.strictEqual(r.after, r.warm, 'context.subscriptions: ' + r.warm + ' -> ' + r.after + ' (before the fix it grew by 2-3 per opening)');
    assert.strictEqual(r.live, 0, 'listeners still registered on closed panels: ' + r.live);
  });
}

for (const [name, fn] of tests) { fn(); n++; console.log('ok  ' + name); }
console.log('\n' + n + ' tests passed');
