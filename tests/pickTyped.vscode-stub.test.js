'use strict';
// node tests/pickTyped.vscode-stub.test.js [path/to/extension]
// 0.22.1: pickTyped.js with a fake QuickPick: the typed value as an extra entry (after the matches, before them when it has arguments, not at all when it
// is a name that exists), the choice, the dismissal, and that the promise is settled once.
const assert = require('assert'), path = require('path'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

let qp;
const makeQp = () => {
  const h = {};
  qp = { items: [], selectedItems: [], disposed: 0, shown: 0, placeholder: '',
    onDidChangeValue: (f) => { h.change = f; }, onDidAccept: (f) => { h.accept = f; }, onDidHide: (f) => { h.hide = f; },
    show() { this.shown++; }, dispose() { this.disposed++; }, h };
  return qp;
};
const stub = { window: { createQuickPick: makeQp }, QuickPickItemKind: { Separator: -1 } };
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
const I = require(path.join(EXT, 'i18n'));
const { pickTyped, sep } = require(path.join(EXT, 'pickTyped'));

const base = [sep('Group'), { label: 'bold', pick: { name: 'bold' } }, { label: 'italic', pick: { name: 'italic' } }];
const parse = (v) => (v.trim() ? { name: v.trim().split(' ')[0], label: v.trim(), pick: { name: v.trim().split(' ')[0], typed: v.trim() }, withArgs: /\s/.test(v.trim()) } : null);

t('the typed value: after the matches, before them with arguments, nothing for an existing name, back to the list when emptied', async () => {
  I.setLang('uk');
  const p = pickTyped(base, 'Pick', parse);
  assert.strictEqual(qp.placeholder, 'Pick');
  assert.strictEqual(qp.shown, 1);
  assert.deepStrictEqual(qp.items, base);
  qp.h.change('mycmd');
  assert.strictEqual(qp.items.length, 4);
  const last = qp.items[3];
  assert.deepStrictEqual([last.label, last.description, last.alwaysShow], ['$(add) mycmd', 'ввести як є', true]);
  qp.h.change('mycmd arg');
  assert.strictEqual(qp.items[0].label, '$(add) mycmd arg', 'with arguments the typed entry is first');
  assert.strictEqual(qp.items.length, 4);
  qp.h.change('bold');
  assert.deepStrictEqual(qp.items, base, 'an existing name adds nothing');
  qp.h.change('bold x');
  assert.strictEqual(qp.items[0].pick.typed, 'bold x', 'an existing name with arguments is still typed');
  qp.h.change('  ');
  assert.deepStrictEqual(qp.items, base);
  qp.h.change('zzz');
  qp.selectedItems = [qp.items[qp.items.length - 1]];
  qp.h.accept();
  assert.deepStrictEqual(await p, { name: 'zzz', typed: 'zzz' });
  assert.strictEqual(qp.disposed, 1);
});

t('English description; choose a listed item; a separator or an empty choice gives undefined; hide gives undefined', async () => {
  I.setLang('en');
  let p = pickTyped(base, 'P', parse);
  qp.h.change('mycmd');
  assert.strictEqual(qp.items[3].description, 'enter as is');
  qp.selectedItems = [base[2]];
  qp.h.accept();
  assert.deepStrictEqual(await p, { name: 'italic' });
  p = pickTyped(base, 'P', parse);
  qp.selectedItems = [base[0]]; // the separator has no pick
  qp.h.accept();
  assert.strictEqual(await p, undefined);
  p = pickTyped(base, 'P', parse);
  qp.h.hide();
  assert.strictEqual(await p, undefined);
  I.setLang('uk');
});

t('the promise is settled once: hide after accept does not dispose twice', async () => {
  const p = pickTyped(base, 'P', parse);
  qp.selectedItems = [base[1]];
  qp.h.accept();
  qp.h.hide();
  qp.h.accept();
  assert.deepStrictEqual(await p, { name: 'bold' });
  assert.strictEqual(qp.disposed, 1);
  assert.deepStrictEqual(sep('G'), { label: 'G', kind: -1 });
});

(async () => {
  try {
    for (const [name, fn] of tests) { try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; return; } }
    console.log('\n' + n + ' tests passed');
  } finally { Module._load = load; try { I.setLang('uk'); } catch (e) { /* ignore */ } }
})();
