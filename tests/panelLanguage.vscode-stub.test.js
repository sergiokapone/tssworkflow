'use strict';
// node tests/panelLanguage.vscode-stub.test.js [path/to/extension]
// the panel "Команди": panelLanguage uk / en / auto (auto follows tssworkflow.language, i18n.js)
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const I = require(path.join(ext, 'i18n'));
const S = require(path.join(ext, 'sidebarPure'));

let panel = 'auto';
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
const stub = {
  TreeItem, ThemeIcon: class { constructor(id) { this.id = id; } }, EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  window: { activeTextEditor: null }, workspace: {}
};
const orig = Module._load;
Module._load = function (request, parent) {
  if (request === 'vscode') return stub;
  if (parent && /[\\/]sidebar\.js$/.test(parent.filename) && request === './util') return { cfg: () => ({ get: (k, d) => (k === 'panelLanguage' ? panel : d) }) };
  return orig.apply(this, arguments);
};
const sidebar = require(path.join(ext, 'sidebar'));

const labels = (lang, setting) => {
  I.setLang(lang); panel = setting;
  const p = new sidebar.Provider({}, { 'tssworkflow.compilePdf': 'TSS Workflow: Compile + open PDF' });
  const top = p.getChildren();
  const group = top[1];
  return { state: top[0].item.label, group: group.item.label, first: group.children[0].item.label, building: top[0].children[0].item.label };
};
try {
  const UK = { state: 'Стан', group: 'Збірка й PDF', first: 'Зібрати відкритий файл (розділ, рисунок, окремий) і відкрити PDF', building: 'Збірка не запущена' };
  const EN = { state: 'State', group: 'Build & PDF', first: 'Compile + open PDF', building: 'No build running' };
  assert.deepStrictEqual(labels('uk', 'auto'), UK, 'auto, tssworkflow.language = uk: Ukrainian (as before the setting existed)');
  assert.deepStrictEqual(labels('en', 'auto'), EN, 'auto, tssworkflow.language = en: English');
  assert.deepStrictEqual(labels('en', 'uk'), UK, 'an explicit uk wins over the language of the extension');
  assert.deepStrictEqual(labels('uk', 'en'), EN, 'an explicit en wins too (the old behaviour of panelLanguage)');
  assert.deepStrictEqual(labels('uk', 'whatever'), UK, 'an unknown value is auto');
  assert.deepStrictEqual([S.resolveLang('uk', 'en'), S.resolveLang('en', 'uk'), S.resolveLang('auto', 'en'), S.resolveLang('auto', 'uk'), S.resolveLang(undefined, 'en'), S.resolveLang('auto', undefined)], ['uk', 'en', 'en', 'uk', 'en', 'uk']);
  console.log('panelLanguage: all ok');
} catch (e) { console.error('FAIL', e); process.exitCode = 1; } finally { I.setLang('uk'); }
