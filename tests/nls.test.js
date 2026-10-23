'use strict';
// node tests/nls.test.js [path/to/extension]
// 0.22.0: the static texts of package.json (the submenus, the five panels, the welcome texts) are %keys% of package.nls.json (English,
// the default) and package.nls.uk.json (Ukrainian). The two files have the same keys, every %key% of the manifest is there, the welcome
// texts of both languages have the same buttons, and viewTitles.js sets the titles of the panels from the setting of the extension.
const assert = require('assert'), path = require('path'), fs = require('fs'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
const raw = fs.readFileSync(path.join(EXT, 'package.json'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(EXT, 'package.nls.json'), 'utf8'));
const uk = JSON.parse(fs.readFileSync(path.join(EXT, 'package.nls.uk.json'), 'utf8'));
const CYR = /[А-Яа-яІіЇїЄєҐґ]/;
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } };

t('the two files have the same keys; English has no Ukrainian, Ukrainian has it in every text', () => {
  assert.deepStrictEqual(Object.keys(uk).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) { assert.ok(!CYR.test(en[k]), 'English with Ukrainian letters: ' + k); assert.ok(CYR.test(uk[k]), 'Ukrainian without Ukrainian letters: ' + k); }
});

t('every %key% of package.json is in the files, and no key is left unused', () => {
  const used = new Set([...raw.matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]));
  for (const k of used) assert.ok(k in en, 'missing in package.nls.json: ' + k);
  for (const k of Object.keys(en)) assert.ok(used.has(k), 'not used by package.json: ' + k);
  assert.ok(used.size >= 11);
});

t('the welcome texts of the two languages have the same buttons and the same line breaks', () => {
  const cmds = (s) => [...s.matchAll(/\(command:([^)]+)\)/g)].map((m) => m[1]);
  for (const k of Object.keys(en).filter((x) => x.startsWith('welcome.'))) {
    assert.deepStrictEqual(cmds(uk[k]), cmds(en[k]), k);
    assert.strictEqual(uk[k].split('\n').length, en[k].split('\n').length, k);
  }
});

t('viewTitles: the title of a panel follows the language of the extension and changes at once', () => {
  const orig = Module._load;
  Module._load = function (req, ...r) { return req === 'vscode' ? {} : orig.call(this, req, ...r); };
  try {
    const I = require(path.join(EXT, 'i18n'));
    const VT = require(path.join(EXT, 'viewTitles'));
    const a = { title: '' }, b = { title: '' };
    I.setLang('uk'); VT.track(a, 'tssworkflow.chaptersView'); VT.track(b, 'tssworkflow.labelsView');
    assert.deepStrictEqual([a.title, b.title], ['Розділи', 'Мітки']);
    I.setLang('en'); VT.apply();
    assert.deepStrictEqual([a.title, b.title], ['Chapters', 'Labels']);
    assert.strictEqual(VT.track(a, 'tssworkflow.unknown'), a); // an unknown panel is returned as it is
    for (const id of Object.keys(VT.TITLES)) assert.ok(raw.includes('"' + id.replace('View', 'View') + '"') || raw.includes(id), id);
  } finally { Module._load = orig; require(path.join(EXT, 'i18n')).setLang('uk'); }
});

console.log('nls: ' + n + ' checks passed');
