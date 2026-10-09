'use strict';
// node tests/activate.vscode-stub.test.js [path/to/extension]  - activate() runs against a stubbed vscode and registers every command of package.json
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const pk = require(path.join(ext, 'package.json'));
const registered = [];
const handler = { get: (t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const disp = { dispose() {} };
const cfg = { get: (k, d) => d, update: async () => {}, has: () => false, inspect: () => ({}) };
const vscode = mk({
  commands: mk({ registerCommand: (id) => { registered.push(id); return disp; }, registerTextEditorCommand: (id) => { registered.push(id); return disp; }, executeCommand: async () => undefined }),
  window: mk({ activeTextEditor: undefined, visibleTextEditors: [], textEditors: [], terminals: [], tabGroups: mk({ all: [], onDidChangeTabs: () => disp }) }),
  workspace: mk({ workspaceFolders: undefined, textDocuments: [], getConfiguration: () => cfg, getWorkspaceFolder: () => undefined, findFiles: async () => [] }),
  extensions: mk({ all: [], getExtension: () => undefined }),
  env: mk({ language: 'uk', appName: 'x', uiKind: 1, remoteName: undefined }),
  version: '1.141.0',
});
const load = Module._load;
Module._load = function (req, ...a) { return req === 'vscode' ? vscode : load.call(this, req, ...a); };
const ctx = { subscriptions: [], extensionUri: { fsPath: ext, path: ext }, extensionPath: ext, globalState: { get: () => undefined, update: async () => {}, keys: () => [] }, workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] }, asAbsolutePath: (p) => path.join(ext, p), globalStorageUri: { fsPath: path.join(require('os').tmpdir(), 'tss-gs') }, extension: { packageJSON: pk } };
(async () => {
  await require(path.join(ext, 'extension.js')).activate(ctx);
  const have = new Set(registered);
  const missing = pk.contributes.commands.map((c) => c.command).filter((id) => !have.has(id));
  assert.deepStrictEqual(missing, [], 'declared in package.json, but activate() did not register them');
  assert.ok(ctx.subscriptions.length > 20, 'activate() pushed only ' + ctx.subscriptions.length + ' disposables');
  console.log('ok  activate(): ' + have.size + ' commands registered, ' + ctx.subscriptions.length + ' disposables');
  console.log('\n1 tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
