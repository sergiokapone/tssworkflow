'use strict';
// node tests/lwCompat.test.js [path/to/extension]
// lwCompatPure.js (the rules, the target of a write) and lwCompat.js (the command, the writes, the reminder at start) on a stub of vscode.
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const L = require(path.join(ext, 'lwCompatPure.js'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const ids = (f) => f.map((x) => x.id);

t('defaults of LaTeX Workshop: autoBuild on file change is a conflict, nothing else is', () => {
  const f = L.lwFindings({}, { compileOnSave: false, pdfViewer: 'vscode' });
  assert.deepStrictEqual(ids(f), ['autoBuild', 'hoverRef']);
  assert.deepStrictEqual(f[0].fixes, [{ key: 'latex.autoBuild.run', value: 'never' }]);
  assert.strictEqual(f[0].level, 'warning');
  assert.strictEqual(f[0].optional, false);
  assert.ok(f[0].why.includes('перезапише'), 'without Auto: the reason is the shared main.*');
  assert.ok(f[0].title.includes('onFileChange'));
});

t('with Auto of this extension the reason is two builds per save', () => {
  const f = L.lwFindings({ 'latex.autoBuild.run': 'onSave' }, { compileOnSave: true });
  assert.ok(f[0].why.includes('дві збірки'));
  assert.ok(f[0].title.includes('onSave'));
});

t('nothing of the build is reported when autoBuild is never', () => {
  const f = L.lwFindings({ 'latex.autoBuild.run': 'never', 'hover.ref.enabled': false }, { compileOnSave: true, pdfViewer: 'vscode' });
  assert.deepStrictEqual(f, []);
});

t('autoClean: a warning with a fix; never is fine', () => {
  const base = { 'latex.autoBuild.run': 'never', 'hover.ref.enabled': false };
  assert.deepStrictEqual(ids(L.lwFindings(Object.assign({ 'latex.autoClean.run': 'onBuilt' }, base), {})), ['autoClean']);
  assert.deepStrictEqual(ids(L.lwFindings(Object.assign({ 'latex.autoClean.run': 'onFailed' }, base), {})), ['autoClean']);
  assert.deepStrictEqual(L.lwFindings(Object.assign({ 'latex.autoClean.run': 'never' }, base), {}), []);
});

t('outDir: an info with an optional fix, the default and "." are fine', () => {
  const base = { 'latex.autoBuild.run': 'never', 'hover.ref.enabled': false };
  const f = L.lwFindings(Object.assign({ 'latex.outDir': '%DIR%/build' }, base), {});
  assert.deepStrictEqual(ids(f), ['outDir']);
  assert.strictEqual(f[0].level, 'info');
  assert.strictEqual(f[0].optional, true);
  assert.deepStrictEqual(f[0].fixes, [{ key: 'latex.outDir', value: '%DIR%' }]);
  for (const ok of ['%DIR%', '.', './', '']) assert.deepStrictEqual(L.lwFindings(Object.assign({ 'latex.outDir': ok }, base), {}), [], JSON.stringify(ok));
});

t('viewer: tab against external in both directions; none and matching are fine', () => {
  const base = { 'latex.autoBuild.run': 'never', 'hover.ref.enabled': false };
  const a = L.lwFindings(Object.assign({ 'view.pdf.viewer': 'external' }, base), { pdfViewer: 'vscode' });
  assert.deepStrictEqual(a.map((x) => [x.id, x.fixes[0].value]), [['viewer', 'tab']]);
  const b = L.lwFindings(Object.assign({ 'view.pdf.viewer': 'tab' }, base), { pdfViewer: 'external' });
  assert.deepStrictEqual(b.map((x) => [x.id, x.fixes[0].value]), [['viewer', 'external']]);
  assert.deepStrictEqual(L.lwFindings(Object.assign({ 'view.pdf.viewer': 'external' }, base), { pdfViewer: 'external' }), []);
  assert.deepStrictEqual(L.lwFindings(Object.assign({ 'view.pdf.viewer': 'external' }, base), { pdfViewer: 'none' }), []);
  assert.deepStrictEqual(L.lwFindings(Object.assign({ 'view.pdf.viewer': 'external' }, base), { pdfViewer: 'latexworkshop' }).map((x) => x.id), ['viewer']);
});

t('hover on \\ref: an optional info', () => {
  const f = L.lwFindings({ 'latex.autoBuild.run': 'never' }, {});
  assert.deepStrictEqual(f.map((x) => [x.id, x.optional, x.fixes[0]]), [['hoverRef', true, { key: 'hover.ref.enabled', value: false }]]);
});

t('needsNudge: only when both automatic builds are on', () => {
  const on = L.lwFindings({}, { compileOnSave: true });
  assert.strictEqual(L.needsNudge(on, { compileOnSave: true }), true);
  assert.strictEqual(L.needsNudge(on, { compileOnSave: false }), false);
  assert.strictEqual(L.needsNudge(L.lwFindings({ 'latex.autoBuild.run': 'never' }, { compileOnSave: true }), { compileOnSave: true }), false);
  assert.strictEqual(L.needsNudge([], null), false);
});

t('writeTarget: where the value is set, else the workspace, else the user settings', () => {
  assert.strictEqual(L.writeTarget({ workspaceFolderValue: 1, workspaceValue: 2 }, true), 'folder');
  assert.strictEqual(L.writeTarget({ workspaceValue: 'x' }, true), 'workspace');
  assert.strictEqual(L.writeTarget({ globalValue: 'x' }, true), 'workspace', 'set only for the user: the fix goes to the workspace');
  assert.strictEqual(L.writeTarget({ globalValue: 'x' }, false), 'global');
  assert.strictEqual(L.writeTarget(undefined, false), 'global');
  assert.strictEqual(L.writeTarget({ workspaceValue: false }, true), 'workspace', 'false is a value');
});

/* ------------------------------ lwCompat.js ------------------------------ */
const handler = { get: (t0, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t0, k) => (k in t0 ? t0[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const st = { lw: {}, ours: {}, inspect: {}, installed: true, folders: [{}], picks: null, quick: null, warn: undefined, warnings: [], infos: [], updates: [], commands: {}, bar: [] };
const lwCfg = { get: (k) => st.lw[k], inspect: (k) => st.inspect[k], update: async (k, v, target) => { if (st.failKey === k) throw new Error('read-only'); st.updates.push([k, v, target]); } };
const ourCfg = { get: (k, d) => (k in st.ours ? st.ours[k] : d) };
const vscode = mk({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  extensions: mk({ getExtension: (id) => (st.installed && id === 'James-Yu.latex-workshop' ? { id } : undefined) }),
  workspace: mk({ getConfiguration: (s) => (s === 'latex-workshop' ? lwCfg : ourCfg), get workspaceFolders() { return st.folders; } }),
  window: mk({
    showQuickPick: async (items, o) => { st.quick = { items, o }; return typeof st.picks === 'function' ? st.picks(items) : st.picks; },
    showWarningMessage: async (m, ...b) => { st.warnings.push([m, b]); return st.warn; },
    showInformationMessage: async (m) => { st.infos.push(m); },
    setStatusBarMessage: (m) => { st.bar.push(m); }
  }),
  commands: mk({ registerCommand: (id, fn) => { st.commands[id] = fn; return { dispose() {} }; } })
});
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : load.call(this, r, ...a); };
const LC = require(path.join(ext, 'lwCompat.js'));
const reset = () => { Object.assign(st, { lw: {}, ours: {}, inspect: {}, installed: true, folders: [{}], picks: null, quick: null, warn: undefined, warnings: [], infos: [], updates: [], bar: [], failKey: null }); };
const ws = { store: {}, get(k) { return this.store[k]; }, async update(k, v) { this.store[k] = v; } };

t('check: LaTeX Workshop is not installed', async () => {
  reset(); st.installed = false;
  const r = await LC.check();
  assert.strictEqual(r.installed, false);
  assert.ok(st.infos[0].includes('не встановлено'));
  assert.strictEqual(st.quick, null);
});

t('check: nothing to report', async () => {
  reset(); st.lw = { 'latex.autoBuild.run': 'never', 'hover.ref.enabled': false };
  const r = await LC.check();
  assert.deepStrictEqual(r.findings, []);
  assert.ok(st.infos[0].includes('Конфліктів'));
});

t('check: the list ticks the required fixes, not the optional ones; the ticked ones are written into the workspace', async () => {
  reset();
  st.lw = { 'latex.autoClean.run': 'onBuilt' };
  st.picks = (items) => items.filter((i) => i.picked);
  const r = await LC.check();
  const labels = st.quick.items.map((i) => [i.picked, i.label.startsWith('$(warning)') ? 'warning' : 'info']);
  assert.deepStrictEqual(labels, [[true, 'warning'], [true, 'warning'], [false, 'info']]);
  assert.ok(st.quick.items[0].description.includes('latex-workshop.latex.autoBuild.run → "never"'));
  assert.ok(st.quick.items[0].detail.length > 20);
  assert.strictEqual(st.quick.o.canPickMany, true);
  assert.deepStrictEqual(st.updates, [['latex.autoBuild.run', 'never', 2], ['latex.autoClean.run', 'never', 2]]);
  assert.strictEqual(r.applied, 2);
  assert.ok(st.bar[0].includes('записано налаштувань 2'));
});

t('check: Esc changes nothing; picking only an info without a fix changes nothing', async () => {
  reset(); st.picks = undefined;
  assert.strictEqual((await LC.check()).applied, 0);
  assert.deepStrictEqual(st.updates, []);
  reset(); st.lw = { 'latex.autoBuild.run': 'never', 'hover.ref.enabled': true };
  st.picks = (items) => items;
  assert.strictEqual((await LC.check()).applied, 1, 'the optional hover fix, when the user ticks it');
  assert.deepStrictEqual(st.updates, [['hover.ref.enabled', false, 2]]);
});

t('applyFixes: a value set in the folder is changed there, without a workspace the user settings; a failed write is reported and skipped', async () => {
  reset();
  st.inspect = { 'latex.autoBuild.run': { workspaceFolderValue: 'onSave' } };
  await LC.applyFixes([{ key: 'latex.autoBuild.run', value: 'never' }]);
  assert.deepStrictEqual(st.updates, [['latex.autoBuild.run', 'never', 3]]);
  reset(); st.folders = undefined;
  await LC.applyFixes([{ key: 'latex.autoBuild.run', value: 'never' }]);
  assert.deepStrictEqual(st.updates, [['latex.autoBuild.run', 'never', 1]]);
  reset(); st.failKey = 'latex.autoBuild.run';
  const n2 = await LC.applyFixes([{ key: 'latex.autoBuild.run', value: 'never' }, { key: 'latex.autoClean.run', value: 'never' }]);
  assert.strictEqual(n2, 1);
  assert.ok(st.warnings[0][0].includes('latex-workshop.latex.autoBuild.run') && st.warnings[0][0].includes('read-only'));
});

t('nudge: asks only when both automatic builds are on, once; "Fix" opens the check, "Never" is remembered', async () => {
  reset(); ws.store = {};
  const ctx = { workspaceState: ws, subscriptions: [] };
  assert.strictEqual(await LC.nudge(ctx), null, 'Auto is off: nothing to say');
  assert.deepStrictEqual(st.warnings, []);
  st.ours = { compileOnSave: true }; st.installed = false;
  assert.strictEqual(await LC.nudge(ctx), null, 'LaTeX Workshop is not installed');
  st.installed = true; st.ours = { compileOnSave: true, 'lwCompat.notify': false };
  assert.strictEqual(await LC.nudge(ctx), null, 'switched off in the settings');
  st.ours = { compileOnSave: true };
  st.lw = { 'latex.autoBuild.run': 'never' };
  assert.strictEqual(await LC.nudge(ctx), null, 'LaTeX Workshop does not build');
  st.lw = {};
  st.warn = 'Не нагадувати';
  await LC.nudge(ctx);
  assert.strictEqual(st.warnings.length, 1);
  assert.ok(st.warnings[0][0].includes('дві автозбірки'));
  assert.deepStrictEqual(st.warnings[0][1], ['Виправити…', 'Не нагадувати']);
  assert.strictEqual(ws.store['lwCompat.dismissed'], true);
  await LC.nudge(ctx);
  assert.strictEqual(st.warnings.length, 1, 'dismissed: not asked again');
  ws.store = {}; st.warn = 'Виправити…'; st.picks = (items) => items.filter((i) => i.picked);
  const r = await LC.nudge(ctx);
  assert.ok(r && r.applied >= 1, 'the fix opens the check, which writes');
  assert.ok(!ws.store['lwCompat.dismissed']);
  ws.store = {}; st.warn = undefined;
  await LC.nudge(ctx);
  assert.ok(!ws.store['lwCompat.dismissed'], 'closing the message does not dismiss it');
});

t('register: the command is registered and the reminder timer does not keep the process alive', () => {
  const ctx = { workspaceState: ws, subscriptions: [] };
  LC.register(ctx);
  assert.strictEqual(typeof st.commands['tssworkflow.checkLatexWorkshop'], 'function');
  assert.strictEqual(ctx.subscriptions.length, 1);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  console.log('\n' + n + ' tests passed');
  process.exit(0);
})();
