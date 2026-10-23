'use strict';
// node tests/singleSource.test.js [path/to/extension]
// Things that must be written in one place: the list of excluded folders and the lookup of an open document by path.
// A static guard over the sources (a second copy is how the lists drift apart) plus the behaviour of the shared helpers.
const path = require('path'), fs = require('fs'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const sources = () => fs.readdirSync(ext).filter((f) => /\.js$/.test(f)).map((f) => [f, fs.readFileSync(path.join(ext, f), 'utf8')]);

t('the list of excluded folders is written only in util.js', () => {
  const where = sources().filter(([, s]) => /\*\*\/node_modules\/\*\*/.test(s)).map(([f]) => f);
  assert.deepStrictEqual(where, ['util.js']);
});

t('no module looks an open document up with textDocuments.find except util.js (the Map) and the uri search for non-file schemes', () => {
  const where = sources().filter(([, s]) => /textDocuments\.find\(/.test(s)).map(([f]) => f).sort();
  assert.deepStrictEqual(where, ['settingsCitations.js', 'util.js']);
  const cit = sources().find(([f]) => f === 'settingsCitations.js')[1];
  assert.ok(/uri\.scheme === 'file' \? openDocByPath\(uri\.fsPath\)/.test(cit), 'file: documents go through openDocByPath');
});

t('clearTimeout is written only in util.js (debounce); the rest of the setTimeout calls are the known non-debounce ones', () => {
  const has = (re) => sources().filter(([, s]) => re.test(s)).map(([f]) => f).sort();
  assert.deepStrictEqual(has(/clearTimeout\(/), ['util.js']);
  // build.js: a deferred auto-build and the abort of a stopped build (tied to the build id); tableEditor.js: the prefetch guard
  assert.deepStrictEqual(has(/setTimeout\(/), ['build.js', 'tableEditor.js', 'util.js']);
});

t('the build lives in build.js: extension.js only composes the modules', () => {
  const where = (re) => sources().filter(([, s]) => re.test(s)).map(([f]) => f);
  assert.deepStrictEqual(where(/^async function runBuild\(/m), ['build.js']);
  assert.deepStrictEqual(where(/^async function compileMain\(/m), ['build.js']);
  const e = sources().find(([f]) => f === 'extension.js')[1];
  assert.ok(!/createStatusBarItem\(/.test(e), 'the status bar items of the build are created in build.js');
  assert.ok(/build\.register\(context, \{ channel: LOG \}\)/.test(e));
});

t('EXCLUDE and EXCLUDE_PDF_VERSIONS keep the exact globs the modules had before they were unified', () => {
  const stub = new Proxy({ workspace: {}, window: {}, Uri: {} }, { get: (o, k) => (k in o ? o[k] : new Proxy(function () {}, {})) });
  const load = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
  try {
    const U = require(path.join(ext, 'util.js'));
    assert.strictEqual(U.EXCLUDE, '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**}');
    assert.strictEqual(U.EXCLUDE_PDF_VERSIONS, '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**,**/pdf-versions/**}');
    assert.strictEqual(U.excludeGlob(['**/x/**']), '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**,**/x/**}');
  } finally { Module._load = load; }
});

t('tssworkflow.excludeFolders: excludeNow / excludePdfNow add the folders of the setting at the moment of the call; no module passes the fixed EXCLUDE', () => {
  let setting;
  const ws = { getConfiguration: () => ({ get: (k, d) => (k === 'excludeFolders' && setting !== undefined ? setting : d) }) };
  const stub = new Proxy({ workspace: ws, window: {}, Uri: {} }, { get: (o, k) => (k in o ? o[k] : new Proxy(function () {}, {})) });
  const load = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
  const file = path.join(ext, 'util.js');
  delete require.cache[file];
  try {
    const U = require(file);
    assert.strictEqual(U.excludeNow(), U.EXCLUDE, 'no setting: the fixed list');
    setting = ['old', ' drafts/** ', '**/data/*.csv', '', 'a{b,c}', 42];
    assert.strictEqual(U.excludeNow(), '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**,**/old/**,drafts/**,**/data/*.csv,**/abc/**,**/42/**}');
    assert.strictEqual(U.excludePdfNow(), '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**,**/pdf-versions/**,**/old/**,drafts/**,**/data/*.csv,**/abc/**,**/42/**}');
    setting = 'old';
    assert.strictEqual(U.excludeNow(), U.EXCLUDE, 'not an array: ignored');
  } finally { Module._load = load; delete require.cache[file]; }
  const fixed = sources().filter(([f, s]) => f !== 'util.js' && /\bEXCLUDE(_PDF_VERSIONS)?\b/.test(s)).map(([f]) => f);
  assert.deepStrictEqual(fixed, [], 'these modules ignore tssworkflow.excludeFolders');
});

t('saveDirtyDocs saves the open dirty documents among the paths, skips clean, closed and failing ones, and counts the saved', async () => {
  const saves = [];
  const mkdoc = (p, dirty, fail) => ({ uri: { fsPath: p, scheme: 'file' }, isDirty: dirty, save: async () => { saves.push(p); if (fail) throw new Error('read-only'); return true; } });
  const docs = [mkdoc('/a', true), mkdoc('/b', false), mkdoc('/c', true, true), mkdoc('/d', true)];
  const warnings = [];
  const stub = new Proxy({ workspace: { textDocuments: docs }, window: { showWarningMessage: (m) => { warnings.push(m); } }, Uri: {} }, { get: (o, k) => (k in o ? o[k] : new Proxy(function () {}, {})) });
  const load = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
  delete require.cache[require.resolve(path.join(ext, 'util.js'))];
  try {
    const U = require(path.join(ext, 'util.js'));
    const n = await U.saveDirtyDocs(new Set(['/a', '/b', '/c', '/not-open']));
    assert.deepStrictEqual(saves, ['/a', '/c'], 'only dirty open ones are saved; /d is not asked for');
    assert.strictEqual(n, 1, 'a failed save is not counted');
    assert.strictEqual(warnings.length, 1, 'and the person is told which file stayed modified');
    assert.ok(warnings[0].includes('c'), warnings[0]);
    // a save that answers false (VS Code did not save) is a failure as well
    const f = await U.saveDocs([{ uri: { fsPath: '/x/y.tex' }, save: async () => false }, { uri: { fsPath: '/x/z.tex' }, save: async () => true }]);
    assert.deepStrictEqual(f, ['y.tex']);
    assert.strictEqual(await U.saveDirtyDocs([]), 0);
    assert.strictEqual(warnings.length, 1, 'nothing failed: no warning');
  } finally { Module._load = load; delete require.cache[require.resolve(path.join(ext, 'util.js'))]; }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  console.log('\n' + n + ' tests passed');
})();
