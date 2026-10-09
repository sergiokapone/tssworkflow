'use strict';
// node tests/modules.test.js [path/to/extension]  - the modules as a whole: they load, the require graph is whole, *Pure.js stay free of vscode
const path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const pk = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const files = fs.readdirSync(ext).filter((f) => f.endsWith('.js')).sort();
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ext, f), 'utf8')]));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const requires = (f) => [...src[f].matchAll(/require\(\s*'(\.\/[^']+)'\s*\)/g)].map((m) => m[1].replace(/^\.\//, '').replace(/\.js$/, '') + '.js');

t('every ./require points at an existing module', () => {
  for (const f of files) for (const r of requires(f)) assert.ok(src[r], f + ' requires ' + r + ', which does not exist');
});

t('every module is used: it is the main file or somebody requires it', () => {
  const used = new Set([path.basename(pk.main)]);
  for (const f of files) requires(f).forEach((r) => used.add(r));
  assert.deepStrictEqual(files.filter((f) => !used.has(f)), []);
});

t('*Pure.js modules do not touch vscode (so they can be tested without it)', () => {
  for (const f of files.filter((x) => /Pure\.js$/.test(x))) assert.ok(!/require\(\s*['"]vscode['"]\s*\)/.test(src[f]), f + ' requires vscode');
});

t('no module imports a *Pure.js module that imports back (no cycles)', () => {
  const state = {};
  const visit = (f, stack) => {
    if (state[f] === 2) return;
    assert.ok(state[f] !== 1, 'cycle: ' + stack.concat(f).join(' -> '));
    state[f] = 1;
    for (const r of requires(f)) visit(r, stack.concat(f));
    state[f] = 2;
  };
  files.forEach((f) => visit(f, []));
});

t('every module loads with a stubbed vscode', () => {
  const handler = { get: (_, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
  const load = Module._load;
  Module._load = function (req, ...a) { return req === 'vscode' ? new Proxy(function () {}, handler) : load.call(this, req, ...a); };
  try { for (const f of files) require(path.join(ext, f)); } finally { Module._load = load; }
});

t('the webview script and its stylesheet are there and the script compiles', () => {
  const dir = path.join(ext, 'media', 'tableEditor');
  new vm.Script(fs.readFileSync(path.join(dir, 'webview.js'), 'utf8'), { filename: 'webview.js' });
  assert.ok(fs.readFileSync(path.join(dir, 'webview.css'), 'utf8').includes('body{'));
});

console.log('\n' + n + ' tests passed');
