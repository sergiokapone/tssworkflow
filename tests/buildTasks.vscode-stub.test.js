'use strict';
// node tests/buildTasks.vscode-stub.test.js [path/to/extension]
// buildTasks.js: the tasks of type "tssworkflow" (target current / main), their pseudoterminal and the result of the build as exit code.
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

class EventEmitter { constructor() { this.ls = []; this.event = (fn) => { this.ls.push(fn); return { dispose() {} }; }; } fire(x) { this.ls.slice().forEach((f) => f(x)); } }
class CustomExecution { constructor(cb) { this.callback = cb; } }
class Task { constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, scope, name, source, execution }); } }
let provider = null;
const vscode = {
  EventEmitter, CustomExecution, Task,
  TaskScope: { Workspace: 2 }, TaskGroup: { Build: { id: 'build' } }, TaskRevealKind: { Silent: 2 },
  tasks: { registerTaskProvider: (type, p) => { provider = { type, p }; return { dispose() {} }; } }
};
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : load.call(this, r, ...a); };
const BT = require(path.join(ext, 'buildTasks.js'));

// a build that ends with the given outcome, at once or later
function fakeApi(outcome, delay) {
  const api = { runs: [], stops: 0, outcome: () => outcome, stop: () => { api.stops++; } };
  api.run = (target, openPdf, done) => { api.runs.push([target, openPdf]); if (delay) setTimeout(done, delay); else done(); };
  return api;
}
async function runTask(task) {
  const pty = await task.execution.callback();
  const out = { written: '', closed: [] };
  pty.onDidWrite((s) => { out.written += s; });
  pty.onDidClose((c) => out.closed.push(c));
  return { pty, out };
}

t('provider: two tasks of type tssworkflow in the build group, quiet terminal', () => {
  const api = fakeApi({ ok: true });
  BT.register({ subscriptions: [] }, api);
  assert.strictEqual(provider.type, 'tssworkflow');
  const tasks = provider.p.provideTasks();
  assert.deepStrictEqual(tasks.map((x) => x.definition), [{ type: 'tssworkflow', target: 'current' }, { type: 'tssworkflow', target: 'main' }]);
  assert.deepStrictEqual(tasks.map((x) => x.name), ['Build current file (chapter / figure / standalone) and open PDF', 'Build whole document and open PDF']);
  for (const x of tasks) {
    assert.strictEqual(x.source, 'tssworkflow');
    assert.strictEqual(x.group.id, 'build');
    assert.strictEqual(x.presentationOptions.reveal, 2);
    assert.strictEqual(x.scope, 2);
    assert.ok(x.execution instanceof CustomExecution);
  }
});

t('resolveTask: tasks.json entries with a known target; the internal build tasks (job/id) and unknown targets are not ours', () => {
  const r1 = provider.p.resolveTask({ definition: { type: 'tssworkflow', target: 'main', openPdf: false } });
  assert.deepStrictEqual(r1.definition, { type: 'tssworkflow', target: 'main', openPdf: false });
  assert.strictEqual(r1.name, 'Build whole document (no PDF)');
  const r2 = provider.p.resolveTask({ definition: { type: 'tssworkflow', target: 'current' } });
  assert.deepStrictEqual(r2.definition, { type: 'tssworkflow', target: 'current' }, 'openPdf is not written when it is the default');
  assert.strictEqual(provider.p.resolveTask({ definition: { type: 'tssworkflow', job: 'main', id: 'b1' } }), undefined);
  assert.strictEqual(provider.p.resolveTask({ definition: { type: 'tssworkflow', target: 'bogus' } }), undefined);
  assert.strictEqual(provider.p.resolveTask({}), undefined);
});

t('a successful build ends the task with 0', async () => {
  const api = fakeApi({ ok: true });
  const { pty, out } = await runTask(BT.makeTask({ target: 'current' }, api));
  pty.open();
  assert.deepStrictEqual(api.runs, [['current', true]]);
  assert.ok(out.written.includes('TSS Workflow: Build current file') && out.written.includes('Готово.'));
  assert.deepStrictEqual(out.closed, [0]);
});

t('openPdf false is passed to the build; the target main too', async () => {
  const api = fakeApi({ ok: true });
  const { pty } = await runTask(BT.makeTask({ target: 'main', openPdf: false }, api));
  pty.open();
  assert.deepStrictEqual(api.runs, [['main', false]]);
});

t('a build that ends later closes the task then; errors, a stop and a build that never started give 1', async () => {
  const later = fakeApi({ ok: true }, 15);
  const a = await runTask(BT.makeTask({ target: 'current' }, later));
  a.pty.open();
  assert.deepStrictEqual(a.out.closed, [], 'still running');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(a.out.closed, [0]);
  const bad = await runTask(BT.makeTask({ target: 'current' }, fakeApi({ ok: false, code: 12 })));
  bad.pty.open();
  assert.deepStrictEqual(bad.out.closed, [1]);
  assert.ok(bad.out.written.includes('код 12') && bad.out.written.includes('Problems'));
  const stopped = await runTask(BT.makeTask({ target: 'main' }, fakeApi({ ok: false, stopped: true })));
  stopped.pty.open();
  assert.deepStrictEqual(stopped.out.closed, [1]);
  assert.ok(stopped.out.written.includes('зупинено'));
  const none = await runTask(BT.makeTask({ target: 'main' }, fakeApi(null)));
  none.pty.open();
  assert.deepStrictEqual(none.out.closed, [1]);
  assert.ok(none.out.written.includes('Збірку не запущено'));
});

t('closing the terminal while the build runs stops it, once; after the end nothing is stopped; a late done does not close twice', async () => {
  const api = fakeApi({ ok: true }, 20);
  const { pty, out } = await runTask(BT.makeTask({ target: 'current' }, api));
  pty.open();
  pty.close();
  pty.close();
  assert.strictEqual(api.stops, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(out.closed, [], 'the terminal is already closed: no second close event');
  const done = fakeApi({ ok: true });
  const b = await runTask(BT.makeTask({ target: 'current' }, done));
  b.pty.open();
  b.pty.close();
  assert.strictEqual(done.stops, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  console.log('\n' + n + ' tests passed');
  process.exit(0);
})();
