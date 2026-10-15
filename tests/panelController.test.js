'use strict';
// node tests/panelController.test.js [path/to/extension]  - webviewKit.createPanelController on a stub of vscode
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const created = [], written = [];
function makePanel(viewType, title, show, options) {
  const p = { viewType, title, show, options, revealed: [], live: 0, posted: [], msgHandlers: [], disposeHandlers: [], stateHandlers: [], disposed: false, visible: true };
  const track = (arr, fn, subs) => { const rec = { fn }; arr.push(rec); p.live++; const d = { dispose() { if (!rec.dead) { rec.dead = true; p.live--; } } }; if (subs) subs.push(d); return d; };
  p.webview = { html: '', cspSource: 'csp', asWebviewUri: (u) => u, postMessage: (m) => { p.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (fn, _t, subs) => track(p.msgHandlers, fn, subs) };
  p.onDidDispose = (fn, _t, subs) => track(p.disposeHandlers, fn, subs);
  p.onDidChangeViewState = (fn, _t, subs) => track(p.stateHandlers, fn, subs);
  p.reveal = (col, pf) => p.revealed.push([col, pf]);
  p.dispose = () => { if (p.disposed) return; p.disposed = true; for (const h of p.disposeHandlers.slice()) if (!h.dead) h.fn(); };
  p.send = (m) => p.msgHandlers.filter((h) => !h.dead).forEach((h) => h.fn(m));
  created.push(p);
  return p;
}
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
const stub = new Proxy({
  ViewColumn: { One: 1, Two: 2, Beside: -2 },
  Uri: { joinPath: (b, ...p) => ({ base: b, p }), file: (f) => ({ fsPath: f }) },
  window: { createWebviewPanel: (vt, title, show, options) => makePanel(vt, title, show, options) },
  env: { clipboard: { writeText: async (t) => { written.push(t); } } },
  workspace: { createFileSystemWatcher: () => null }
}, { get: (o, k) => (k in o ? o[k] : noop) });
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
const K = require(path.join(ext, 'webviewKit.js'));
const U = require(path.join(ext, 'util.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { extensionUri: { ext: true } };
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const make = (extra) => {
  const log = { resets: 0, renders: [], collects: 0, messages: [] };
  const ctl = K.createPanelController(Object.assign({
    id: 'probe', title: 'Probe', html: (w, u) => '<html>' + (u && u.ext) + '</html>',
    collect: async () => { log.collects++; return { n: log.collects }; },
    render: (r, c) => { log.renders.push(r.n); c.post({ type: 'data', n: r.n }); },
    onMessage: (m) => log.messages.push(m.type),
    onReset: () => { log.resets++; }
  }, extra));
  return { ctl, log };
};

t('open creates one panel with the type, title, options and page; the second open reveals it', async () => {
  const { ctl } = make({ preserveFocus: true, roots: () => [{ fsPath: '/proj' }] });
  const before = created.length;
  const p = ctl.open(ctx);
  assert.strictEqual(created.length, before + 1);
  assert.strictEqual(p.viewType, 'tssworkflow.probe');
  assert.strictEqual(p.title, 'Probe');
  assert.deepStrictEqual(p.show, { viewColumn: -2, preserveFocus: true });
  assert.strictEqual(p.options.enableScripts, true);
  assert.strictEqual(p.options.retainContextWhenHidden, true);
  assert.strictEqual(p.options.localResourceRoots.length, 2);
  assert.strictEqual(p.webview.html, '<html>true</html>');
  assert.strictEqual(ctl.open(ctx), p);
  assert.strictEqual(created.length, before + 1, 'no second panel');
  assert.deepStrictEqual(p.revealed, [[undefined, false]]);
  p.dispose();
});

t('nothing is collected before the page says ready; then the update runs and the data goes to the page', async () => {
  const { ctl, log } = make();
  const p = ctl.open(ctx);
  await ctl.update();
  assert.strictEqual(log.collects, 0, 'not ready: no work');
  p.send({ type: 'ready' });
  assert.strictEqual(ctl.ready, true);
  await sleep(30);
  assert.strictEqual(log.collects, 1);
  assert.deepStrictEqual(p.posted, [{ type: 'data', n: 1 }]);
  p.dispose();
});

t('an answer that is no longer the last one is dropped (the old update finished late)', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  let call = 0;
  const { ctl, log } = make({ collect: async () => { call++; if (call === 1) { await slow; return { n: 'old' }; } return { n: 'new' }; } });
  const p = ctl.open(ctx);
  p.send({ type: 'ready' }); await sleep(20);          // the first update waits
  const second = ctl.update();                          // the second finishes first
  await second;
  release(); await sleep(20);
  assert.deepStrictEqual(log.renders, ['new'], 'only the newest answer is shown');
  p.dispose();
});

t('closing the panel: onReset runs, the timer is cancelled, a late answer is dropped, every listener is disposed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctl, log } = make({ collect: async () => { await gate; return { n: 1 }; } });
  const p = ctl.open(ctx);
  p.send({ type: 'ready' }); await sleep(20);   // an update is waiting for the gate
  ctl.schedule(500);
  assert.ok(U.timerPending('probe.update'));
  p.dispose();
  assert.strictEqual(log.resets, 1);
  assert.strictEqual(ctl.isOpen(), false);
  assert.strictEqual(U.timerPending('probe.update'), false, 'the deferred update is cancelled');
  assert.strictEqual(p.live, 0, 'no listener of the closed panel is left');
  release(); await sleep(20);
  assert.deepStrictEqual(log.renders, [], 'the answer that came after the close is not shown');
  assert.strictEqual(ctl.post({ type: 'x' }), undefined, 'post to a closed panel is a no-op');
  ctl.schedule(0); await sleep(10);
  assert.strictEqual(U.timerPending('probe.update'), false, 'schedule on a closed panel does nothing');
});

t('after a close the panel opens again as a new one with fresh state (ready is false)', async () => {
  const { ctl } = make();
  const a = ctl.open(ctx); a.send({ type: 'ready' }); a.dispose();
  const b = ctl.open(ctx);
  assert.notStrictEqual(a, b);
  assert.strictEqual(ctl.ready, false);
  b.dispose();
});

t('messages: copy goes to the clipboard and is confirmed; refresh, others and null are routed; noCopy hands copy to the module', async () => {
  const seen = [];
  const { ctl, log } = make({ onRefresh: (c) => seen.push('refresh') });
  const p = ctl.open(ctx);
  p.send(null); p.send({ type: 'goto' }); p.send({ type: 'refresh' });
  p.send({ type: 'copy', text: '\\eqref{a}', what: '\\eqref' }); await sleep(10);
  assert.deepStrictEqual(log.messages, ['goto']);
  assert.deepStrictEqual(seen, ['refresh']);
  assert.deepStrictEqual(written.slice(-1), ['\\eqref{a}']);
  assert.ok(p.posted.some((m) => m.type === 'copied' && m.what === '\\eqref'));
  p.send({ type: 'copy', text: 'x'.repeat(2000001) }); await sleep(5);
  assert.strictEqual(written.length, 1, 'an oversized text is refused');
  p.dispose();
  const b = make({ noCopy: true });
  const q = b.ctl.open(ctx); q.send({ type: 'copy' });
  assert.deepStrictEqual(b.log.messages, ['copy']);
  q.dispose();
});

t('hooks: onReady replaces the default, onReveal replaces the default reveal, onViewState is wired', async () => {
  const calls = [];
  const { ctl } = make({ onReady: () => calls.push('ready'), onReveal: (c, p) => { calls.push('reveal'); p.dispose(); }, onViewState: (e) => calls.push('state:' + e.webviewPanel.visible) });
  const p = ctl.open(ctx);
  p.send({ type: 'ready' }); p.stateHandlers[0].fn({ webviewPanel: { visible: true } });
  ctl.open(ctx);
  assert.deepStrictEqual(calls, ['ready', 'state:true', 'reveal']);
  assert.strictEqual(ctl.isOpen(), false, 'the toggle closed it');
});

t('begin / live: a module with its own update can drop stale answers', async () => {
  const { ctl } = make();
  const p = ctl.open(ctx);
  const a = ctl.begin(), b = ctl.begin();
  assert.strictEqual(ctl.live(a), false); assert.strictEqual(ctl.live(b), true);
  p.dispose();
  assert.strictEqual(ctl.live(b), false);
});

t('50 openings and closings leave no listener and no timer', async () => {
  const { ctl } = make({ timers: ['probe.extra'] });
  const panels = [];
  for (let i = 0; i < 50; i++) { const p = ctl.open(ctx); panels.push(p); U.debounce('probe.extra', 5000, () => {}); ctl.schedule(5000); p.dispose(); }
  assert.ok(panels.every((p) => p.live === 0), 'listeners left: ' + panels.map((p) => p.live).join(','));
  assert.strictEqual(U.timerPending('probe.extra'), false);
  assert.strictEqual(U.timerPending('probe.update'), false);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + String(e && e.stack || e).replace(/\n/g, '\n  ')); }
  }
  console.log('\n' + n + ' tests passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
