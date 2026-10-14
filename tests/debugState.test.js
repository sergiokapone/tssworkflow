'use strict';
// node tests/debugState.test.js [path/to/extension]  - the state report: the text (pure) and the command (stubbed vscode)
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
const handlers = {}, shown = [];
const stub = new Proxy({
  version: '1.141.0',
  commands: { registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; }, executeCommand: async () => undefined },
  workspace: { createFileSystemWatcher: () => null, textDocuments: [{}, {}, {}], openTextDocument: async (o) => { shown.push(o); return { o }; } },
  window: { showTextDocument: async () => undefined },
  ViewColumn: { Beside: 2 },
  Uri: {}
}, { get: (o, k) => (k in o ? o[k] : noop) });
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
const D = require(path.join(ext, 'debugStatePure.js'));
const U = require(path.join(ext, 'util.js'));
const S = require(path.join(ext, 'debugState.js'));
const PI = require(path.join(ext, 'projectIndex.js'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const base = () => ({ version: '0.20.1', vscodeVersion: '1.141.0', platform: 'win32', node: 'v24.21.0', uptimeSec: 3725, subscriptions: 223, timers: ['labels.refresh', 'suggest'], caching: true, findCache: 3, docMap: 5, index: { labels: 80, cites: 80 }, panels: { 'Таблиця': true, 'Галерея макросів': false }, openDocs: 7, memory: { rss: 300 * 1048576, heapUsed: 120 * 1048576, heapTotal: 180 * 1048576, external: 8 * 1048576 } });

t('the report names every number that can leak, with the values', () => {
  const r = D.report(base(), null);
  for (const s of ['0.20.1', '1.141.0', 'win32', '223', 'labels.refresh, suggest', 'Таблиця', 'cites 80, labels 80', '300.0 МБ', '120.0 МБ', '1 год 2 хв']) assert.ok(r.includes(s), 'missing: ' + s);
  assert.ok(!r.includes('Галерея макросів'), 'a closed panel is not listed as open');
});

t('the first call has no deltas and says how to get them', () => {
  const r = D.report(base(), null);
  assert.ok(!/\(\+\d|\(−|\(0\)/.test(r), 'no deltas');
  assert.ok(/перший виклик/.test(r));
});

t('the second call shows the change since the first: growth with a sign, no change as 0', () => {
  const a = base();
  const prev = D.counters(a);
  const b = base(); b.subscriptions = 229; b.memory.heapUsed = 130 * 1048576; b.panels['Галерея макросів'] = true;
  const r = D.report(b, prev);
  assert.ok(/\| 229 \(\+6\) \|/.test(r), 'subscriptions +6');
  assert.ok(/\(\+10\.0 МБ\)/.test(r), 'heap +10 MB');
  assert.ok(/Відкриті панелі webview \| 2 \(\+1\)/.test(r), 'panels +1');
  assert.ok(/\| 2 \(0\)/.test(r) || /Очікуючі таймери[^|]*\| 2 \(0\)/.test(r), 'timers unchanged');
  const r2 = D.report(b, D.counters(b));
  assert.ok(/\| 229 \(0\) \|/.test(r2));
});

t('a pipe in a key cannot break the table; a missing docMap and a disabled cache are said plainly', () => {
  const s = base(); s.timers = ['a|b']; s.docMap = null; s.caching = false;
  const r = D.report(s, null);
  assert.ok(r.includes('a\\|b'));
  assert.ok(/ще не побудовано/.test(r) && /\*\*ні\*\*/.test(r));
});

t('util.timerKeys / cacheStats and projectIndex.stats report what they hold', () => {
  U.debounce('dbg.a', 5000, () => {}); U.debounce('dbg.b', 5000, () => {});
  assert.ok(U.timerKeys().includes('dbg.a') && U.timerKeys().includes('dbg.b'));
  U.cancelTimer('dbg.a'); U.cancelTimer('dbg.b');
  assert.ok(!U.timerKeys().includes('dbg.a'));
  const cs = U.cacheStats();
  assert.strictEqual(typeof cs.caching, 'boolean'); assert.strictEqual(typeof cs.findCache, 'number');
  assert.deepStrictEqual(PI.stats(), {});
});

t('the command is registered, opens a Markdown report, and the second call shows the change', async () => {
  const ctx = { subscriptions: [], extension: { packageJSON: { version: '0.20.1' } } };
  S.register(ctx);
  assert.strictEqual(ctx.subscriptions.length, 1);
  assert.strictEqual(typeof handlers['tssworkflow.debugState'], 'function');
  await handlers['tssworkflow.debugState']();
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].language, 'markdown');
  assert.ok(shown[0].content.includes('0.20.1') && shown[0].content.includes('`context.subscriptions`'));
  assert.ok(!/\(\+\d/.test(shown[0].content), 'first call: no deltas');
  for (let i = 0; i < 5; i++) ctx.subscriptions.push({ dispose() {} }); // what a leaking panel would do
  await handlers['tssworkflow.debugState']();
  assert.ok(/\| 6 \(\+5\) \|/.test(shown[1].content), 'the leak is visible: ' + (shown[1].content.match(/context\.subscriptions[^\n]*/) || [''])[0]);
});

t('every panel module exports isOpen (the report asks them)', () => {
  const fs = require('fs');
  for (const f of ['selectionPreview.js', 'tableEditor.js', 'macroGallery.js', 'formulaOverview.js']) assert.ok(/exports\.isOpen = \(\) => !!panel/.test(fs.readFileSync(path.join(ext, f), 'utf8')), f);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + String(e && e.stack || e).replace(/\n/g, '\n  ')); }
  }
  console.log('\n' + n + ' tests passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
