'use strict';
// node tests/webviewPanels.vscode-stub.test.js [path/to/extension]
// the pages of the macro gallery and of the overview of formulas, host and page together, in Ukrainian and in English (tssworkflow.language):
// the shell (webviewKit.shell): the language of the page, the block with the texts, the helper before the script of the page, a page that asks for no texts gets neither;
// the HTML of the host (the title, the buttons, the placeholders) and the page helper over the very block that the host made.
const assert = require('assert'), path = require('path'), fs = require('fs'), vm = require('vm'), Module = require('module');
const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const I = require(path.join(EXT, 'i18n'));
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };

const base = {
  Uri: { joinPath: (u, ...p) => ({ path: [u.path].concat(p).join('/') }), file: (f) => ({ path: f, fsPath: f }) },
  window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
  workspace: {}, languages: {}, commands: { registerCommand: () => ({ dispose() {} }) }, env: { language: 'en' }
};
// whatever else the modules ask of vscode while they are loaded (enums, classes) is something that can be asked again and called
const noop = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : noop()), apply: () => noop(), construct: () => ({}) });
const lenient = (o) => new Proxy(o, { get: (t, k) => (k in t ? (t[k] && typeof t[k] === 'object' && !Array.isArray(t[k]) ? lenient(t[k]) : t[k]) : typeof k === 'string' && /^(on|register|create)/.test(k) ? () => ({ dispose() {}, event() {} }) : typeof k === 'string' ? noop() : undefined) });
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? lenient(base) : orig.call(this, r, ...a); };
const K = require(path.join(EXT, 'webviewKit'));
const MG = require(path.join(EXT, 'macroGallery'));
const FO = require(path.join(EXT, 'formulaOverview'));

const webview = { cspSource: 'csp:', asWebviewUri: (u) => ({ toString: () => 'res:/' + u.path }) };
const blockOf = (html) => { const m = /<script type="application\/json" id="tss-i18n">(.*?)<\/script>/.exec(html); return m ? JSON.parse(m[1]) : null; };
const helper = (html) => {
  const m = /<script type="application\/json" id="tss-i18n">(.*?)<\/script>/.exec(html);
  const box = { document: { getElementById: (id) => (id === 'tss-i18n' ? { textContent: m[1] } : null) } };
  box.window = box;
  vm.runInNewContext(fs.readFileSync(path.join(EXT, 'media', 'common', 'i18n.js'), 'utf8'), box);
  return box.T;
};
const page = (lang, body, js) => { I.setLang(lang); return K.shell(webview, { path: 'EXT' }, { body, css: [], js }); };

try {
  for (const [name, mod, js, title] of [['macroGallery', MG, 'macroGallery/webview.js', ['Галерея макросів', 'Macro gallery']], ['formulaOverview', FO, 'formulaOverview/webview.js', ['Формули проєкту', 'Formulas of the project']]]) {
    I.setLang('uk'); const bUk = mod._t.body();
    I.setLang('en'); const bEn = mod._t.body();
    ok(bUk.includes('<h1>' + title[0] + '</h1>') && bEn.includes('<h1>' + title[1] + '</h1>'), name + ': the title of the page');
    ok(!/[А-Яа-яІіЇїЄєҐґ]/.test(bEn), name + ': no Ukrainian in the English body: ' + (bEn.match(/[^<>]*[А-Яа-яІіЇїЄєҐґ][^<>]*/) || [''])[0]);
    const uk = page('uk', bUk, [js]), en = page('en', bEn, [js]);
    ok(uk.includes('<html lang="uk">') && en.includes('<html lang="en">'), name + ': the language of the page');
    const iBlock = en.indexOf('id="tss-i18n"'), iHelper = en.indexOf('res:/EXT/media/common/i18n.js'), iKit = en.indexOf('res:/EXT/media/common/kit.js'), iPage = en.indexOf('res:/EXT/media/' + js);
    ok(iBlock > 0 && iKit > 0 && iHelper > iKit && iPage > iHelper, name + ': block, kit, helper, script of the page: ' + [iBlock, iKit, iHelper, iPage]);
    const d = blockOf(en);
    ok(Object.keys(d).length >= 5 && Object.values(d).every((v) => typeof v === 'string' && v), name + ': the block has the texts');
    ok(Object.keys(blockOf(uk)).every((k) => blockOf(uk)[k] === k), name + ': in Ukrainian the texts are the keys');
    const T = helper(en);
    eq(T('Скопійовано: {0}', 'x'), 'Copied: x', name + ': T over the block of the host');
  }
  // the page helper over the block of the gallery: the line of the statistics
  const T = helper(page('en', MG._t.body(), ['macroGallery/webview.js']));
  eq(T('Команд: {0}, середовищ: {1}. Не відтворюються в KaTeX: {2}', 4, 2, 1), 'Commands: 4, environments: 2. Not rendered by KaTeX: 1');
  eq(T('Те саме, що <code>\\{0}</code>', 'emph'), 'The same as <code>\\emph</code>');
  // the preview of the selection: the page asks for its texts too (the steps of a derivation, the notes)
  const sp = page('en', '<p>x</p>', ['selectionPreview/webview.js']);
  const spd = blockOf(sp), spT = helper(sp);
  ok(sp.includes('common/i18n.js') && spd['Попередній крок'] === 'Previous step' && spd['Наступний крок'] === 'Next step', 'the block of the preview');
  eq([spT('Крок {0} з {1}', 2, 5), spT('Усі {0} рядків', 7), spT('Не відтворено (є лише в PDF): {0}', 'tikz, table')], ['Step 2 of 5', 'All 7 lines', 'Not rendered (only in the PDF): tikz, table']);
  // a page that asks for no texts: no block, no helper
  const none = page('en', '<p>x</p>', ['no-such-panel/webview.js']);
  ok(!none.includes('tss-i18n') && !none.includes('common/i18n.js'), 'no texts: neither the block nor the helper');
  ok(none.includes('<html lang="en">'), 'but the language of the page is set');
} finally { I.setLang('uk'); Module._load = orig; }
console.log('webviewPanels.vscode-stub: ' + n + ' checks passed');
