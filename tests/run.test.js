'use strict';
// node tests/run.test.js [path/to/extension]
// util.run / util.execFileT: the one way to start an external program, with a time limit by default.
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
const stub = new Proxy({ workspace: { createFileSystemWatcher: () => null }, window: {}, Uri: {} }, { get: (o, k) => (k in o ? o[k] : noop) });
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
const U = require(path.join(ext, 'util.js'));
const node = process.execPath;
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('defaults: a time limit, no console window, a big buffer, utf8; an explicit option wins; timeout 0 means no limit', () => {
  const d = U.runOpts();
  assert.strictEqual(d.timeout, U.RUN_TIMEOUT);
  assert.ok(U.RUN_TIMEOUT > 0 && U.RUN_TIMEOUT <= 300000, 'a finite limit of a few minutes at most');
  assert.strictEqual(d.windowsHide, true);
  assert.strictEqual(d.encoding, 'utf8');
  assert.ok(d.maxBuffer >= 16 * 1024 * 1024);
  assert.strictEqual(U.runOpts({ timeout: 4000 }).timeout, 4000);
  assert.strictEqual(U.runOpts({ timeout: 0 }).timeout, 0);
  assert.strictEqual(U.runOpts({ cwd: '/x', maxBuffer: 5 }).maxBuffer, 5);
  assert.strictEqual(U.runOpts({ cwd: '/x' }).cwd, '/x');
});

t('run resolves with stdout', async () => {
  assert.strictEqual(await U.run(node, ['-e', 'process.stdout.write("привіт")']), 'привіт');
});

t('run rejects with stderr and the exit code when the program fails', async () => {
  await assert.rejects(U.run(node, ['-e', 'console.error("boom"); process.exit(3)']), (e) => e.code === 3 && /boom/.test(e.stderr));
});

t('run rejects with ENOENT for a program that does not exist', async () => {
  await assert.rejects(U.run('tss-no-such-program-xyz', []), (e) => e.code === 'ENOENT');
});

t('a program that never ends is killed at the limit (the old authoring.run waited for ever)', async () => {
  const t0 = Date.now();
  await assert.rejects(U.run(node, ['-e', 'setTimeout(()=>{}, 20000)'], { timeout: 300 }), (e) => e.killed === true);
  assert.ok(Date.now() - t0 < 5000, 'killed in ' + (Date.now() - t0) + ' ms');
});

t('execFileT keeps the callback form, with and without options, and applies the same defaults', async () => {
  const viaOpts = await new Promise((res) => U.execFileT(node, ['-e', 'process.stdout.write("a")'], { cwd: __dirname }, (err, out) => res([err, out])));
  assert.deepStrictEqual(viaOpts, [null, 'a']);
  const noOpts = await new Promise((res) => U.execFileT(node, ['-e', 'process.stdout.write("b")'], (err, out) => res([err, out])));
  assert.deepStrictEqual(noOpts, [null, 'b']);
  const t0 = Date.now();
  const killed = await new Promise((res) => U.execFileT(node, ['-e', 'setTimeout(()=>{}, 20000)'], { timeout: 250 }, (err) => res(err)));
  assert.ok(killed && killed.killed, 'the limit applies to the callback form too');
  assert.ok(Date.now() - t0 < 5000);
});

t('the callback of the old cp.execFile style still gets (err, stdout, stderr)', async () => {
  const r = await new Promise((res) => U.execFileT(node, ['-e', 'process.stdout.write("o");process.stderr.write("e")'], {}, (err, out, errOut) => res([err, out, errOut])));
  assert.deepStrictEqual(r, [null, 'o', 'e']);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + String(e && e.stack || e).replace(/\n/g, '\n  ')); }
  }
  console.log('\n' + n + ' tests passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
