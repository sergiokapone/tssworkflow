'use strict';
// node tests/debounce.test.js [path/to/extension]
// util.debounce / cancelTimer / timerPending / disposeTimers: the one place of the "clearTimeout + setTimeout" pairs.
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
const stub = new Proxy({ workspace: { createFileSystemWatcher: () => null }, window: {}, Uri: {} }, { get: (o, k) => (k in o ? o[k] : noop) });
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
const U = require(path.join(ext, 'util.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('calls with one key run fn once, ms after the LAST call, with the last fn', async () => {
  const log = [];
  const t0 = Date.now();
  U.debounce('k', 60, () => log.push('first'));
  await sleep(35);
  U.debounce('k', 60, () => log.push('second @' + (Date.now() - t0 >= 90)));
  await sleep(40);
  assert.deepStrictEqual(log, [], 'the second call restarted the wait: not yet at 75 ms');
  assert.strictEqual(U.timerPending('k'), true);
  await sleep(60);
  assert.deepStrictEqual(log, ['second @true']);
});

t('keys are independent', async () => {
  const log = [];
  U.debounce('a', 20, () => log.push('a'));
  U.debounce('b', 20, () => log.push('b'));
  U.debounce('a', 20, () => log.push('a2'));
  await sleep(50);
  assert.deepStrictEqual(log.sort(), ['a2', 'b']);
});

t('a finished timer is forgotten (no entry per key that was ever used)', async () => {
  for (let i = 0; i < 200; i++) U.debounce('doc:' + i, 5, () => {});
  assert.strictEqual(U.timerPending('doc:199'), true);
  await sleep(40);
  assert.strictEqual(U.timerPending('doc:0'), false);
  assert.strictEqual(U.timerPending('doc:199'), false);
});

t('cancelTimer: true for a pending key, false otherwise; a cancelled timer never runs', async () => {
  let ran = 0;
  U.debounce('c', 20, () => ran++);
  assert.strictEqual(U.cancelTimer('c'), true);
  assert.strictEqual(U.cancelTimer('c'), false);
  assert.strictEqual(U.cancelTimer('never-used'), false);
  await sleep(40);
  assert.strictEqual(ran, 0);
});

t('the callback may schedule the same key again (the entry is removed before fn runs)', async () => {
  let ran = 0;
  const again = () => { ran++; if (ran < 3) U.debounce('loop', 10, again); };
  U.debounce('loop', 10, again);
  await sleep(80);
  assert.strictEqual(ran, 3);
  assert.strictEqual(U.timerPending('loop'), false);
});

t('disposeTimers clears every pending timer', async () => {
  let ran = 0;
  U.debounce('x', 20, () => ran++); U.debounce('y', 20, () => ran++);
  U.disposeTimers();
  assert.strictEqual(U.timerPending('x') || U.timerPending('y'), false);
  await sleep(40);
  assert.strictEqual(ran, 0);
});

t('unref: the timer does not keep the process alive, a normal one does', () => {
  const a = U.debounce('u1', 1000, () => {}, true);
  const b = U.debounce('u2', 1000, () => {});
  assert.strictEqual(a.hasRef(), false);
  assert.strictEqual(b.hasRef(), true);
  U.disposeTimers();
});

t('initCaches registers the disposer even without a file watcher: pending timers are cleared with the extension', async () => {
  const ctx = { subscriptions: [] };
  assert.strictEqual(U.initCaches(ctx), false, 'no watcher: no caching');
  assert.strictEqual(ctx.subscriptions.length, 1);
  let ran = 0;
  U.debounce('d', 20, () => ran++);
  ctx.subscriptions.forEach((s) => s.dispose());
  await sleep(40);
  assert.strictEqual(ran, 0);
  assert.strictEqual(U.timerPending('d'), false);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  console.log('\n' + n + ' tests passed');
  process.exit(0);
})();
