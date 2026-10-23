'use strict';
// node tests/chapters.vscode-stub.test.js [path/to/extension]
// 0.22.1: the tree of the "Chapters" panel on a real project folder on the disk (chapters.js with a stub of vscode): the order of the
// main file, the groups by \part, the chapters that the main file does not include, a missing X/X.tex, the figures of a chapter,
// the notes in English and in Ukrainian.
const assert = require('assert'), path = require('path'), fs = require('fs'), os = require('os'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-chap-'));
const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('main.tex', '\\part{Механіка}\n\\includechapter{Mech}\n\\includechapter{Gone}\n\\part{Електрика}\n\\multiinclude{El1, El2}\n');
put('Mech/Mech.tex', '\\chapter{Кінематика}\\label{\\currfilebase}\n');
put('Mech/tikz/b.tikz', '');
put('Mech/tikz/a.tikz', '');
put('El1/El1.tex', '\\chapter{Заряди}\n');
put('El2/El2.tex', '\\chapter{Поле}\n');
put('Draft/Draft.tex', '\\chapter{Чернетка}\n'); // a folder X/X.tex that the main file does not include
put('.hidden/.hidden.tex', 'x');
put('Notes/readme.txt', 'no Notes.tex: not a chapter');

class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class ThemeIcon { constructor(id) { this.id = id; } }
class EventEmitter { constructor() { this.event = () => {}; } fire() {} }
const stub = {
  TreeItem, ThemeIcon, EventEmitter, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: { file: (f) => ({ fsPath: f }) },
  window: { activeTextEditor: null, createTreeView: () => ({ title: '' }) },
  workspace: { workspaceFolders: [{ uri: { fsPath: root } }], getWorkspaceFolder: () => null, getConfiguration: () => ({ get: (k, d) => d }) },
  commands: { registerCommand: () => ({}) }
};
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
const I = require(path.join(EXT, 'i18n'));
const Ch = require(path.join(EXT, 'chapters'));
const describe = (nodes) => nodes.map((x) => ({ kind: x.kind, label: x.item.label, desc: x.item.description, icon: x.item.iconPath && x.item.iconPath.id, ctx: x.item.contextValue, kids: (x.children || []).map((k) => k.item.label) }));

t('with \\part: groups in the order of the main file, a missing chapter is marked, the figures are sorted, the folders that are not included go last', () => {
  I.setLang('uk');
  const top = new Ch.Provider().getChildren();
  const d = describe(top);
  assert.deepStrictEqual(d.map((x) => x.label), ['Механіка', 'Електрика', 'Не підключені в головному файлі']);
  assert.deepStrictEqual(d[0].kids, ['Mech', 'Gone']);
  assert.deepStrictEqual(d[1].kids, ['El1', 'El2']);
  assert.deepStrictEqual(d[2].kids, ['Draft'], '.hidden and Notes are not chapters');
  assert.strictEqual(d[0].desc, '2');
  assert.strictEqual(d[2].desc, '1');
  const mech = top[0].children[0], gone = top[0].children[1];
  assert.strictEqual(mech.item.description, 'Кінематика');
  assert.strictEqual(mech.item.contextValue, 'chapter');
  assert.deepStrictEqual(mech.children.map((f) => f.item.label), ['a', 'b'], 'figures by name');
  assert.strictEqual(gone.item.description, 'немає Gone/Gone.tex');
  assert.strictEqual(gone.item.contextValue, 'chapterMissing');
  assert.strictEqual(gone.item.iconPath.id, 'warning');
  assert.strictEqual(gone.item.command, undefined, 'nothing to open');
  assert.strictEqual(mech.item.command.command, 'tssworkflow.openChapter');
  assert.strictEqual(mech.item.command.arguments[0].file, path.join(root, 'Mech', 'Mech.tex'));
});

t('the same tree in English: the notes follow the language, the structure does not', () => {
  I.setLang('uk'); const uk = describe(new Ch.Provider().getChildren());
  I.setLang('en'); const en = describe(new Ch.Provider().getChildren());
  assert.strictEqual(en[2].label, 'Not included in the main file');
  assert.deepStrictEqual(en.map((x) => x.kids), uk.map((x) => x.kids));
  const gone = new Ch.Provider().getChildren()[0].children[1];
  assert.strictEqual(gone.item.description, 'Gone/Gone.tex does not exist');
  assert.strictEqual(gone.item.command, undefined);
  assert.strictEqual(new Ch.Provider().getChildren()[0].children[0].item.command.title, 'Open');
});

t('without \\part: a flat list; a chapter that is not included carries the note itself', () => {
  fs.writeFileSync(path.join(root, 'main.tex'), '\\includechapter{Mech}\n\\multiinclude{El1, El2}\n');
  I.setLang('uk');
  const flat = new Ch.Provider().getChildren();
  assert.deepStrictEqual(flat.map((x) => x.item.label), ['Mech', 'El1', 'El2', 'Draft']);
  assert.strictEqual(flat[3].item.description, 'не підключено в головному файлі · Чернетка');
  assert.strictEqual(flat[3].item.iconPath.id, 'circle-slash');
  I.setLang('en');
  assert.strictEqual(new Ch.Provider().getChildren()[3].item.description, 'not included in the main file · Чернетка');
});

t('no main file: the folders X/X.tex in alphabetical order; no project folder: nothing', () => {
  fs.unlinkSync(path.join(root, 'main.tex'));
  I.setLang('uk');
  assert.deepStrictEqual(new Ch.Provider().getChildren().map((x) => x.item.label), ['Draft', 'El1', 'El2', 'Mech']);
  stub.workspace.workspaceFolders = [];
  assert.deepStrictEqual(new Ch.Provider().getChildren(), []);
});

(async () => {
  try {
    for (const [name, fn] of tests) { try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; return; } }
    console.log('\n' + n + ' tests passed');
  } finally { Module._load = load; try { I.setLang('uk'); } catch (e) { /* ignore */ } fs.rmSync(root, { recursive: true, force: true }); }
})();
