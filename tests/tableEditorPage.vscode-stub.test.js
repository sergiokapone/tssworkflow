'use strict';
// node tests/tableEditorPage.vscode-stub.test.js [path/to/extension]
// the HTML of the page of the table editor, host and page together: the language of the page, the translated hint, the JSON block with the texts, the helper before the script of the page,
// and the helper (media/common/i18n.js) run over the very block that the host made: T('...') gives the text in the language of the extension.
const assert = require('assert'), path = require('path'), fs = require('fs'), vm = require('vm'), Module = require('module');
const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const I = require(path.join(EXT, 'i18n'));
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };

// vscode: only what the page needs; everything else that the module asks while it is loaded is a no-op
const base = {
  Uri: { joinPath: (u, ...p) => ({ path: [u.path].concat(p).join('/') }), file: (f) => ({ path: f, fsPath: f }) },
  window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
  workspace: {}, languages: {}, commands: { registerCommand: () => ({ dispose() {} }) }, env: { language: 'en' }
};
const lenient = (o) => new Proxy(o, { get: (t, k) => (k in t ? (t[k] && typeof t[k] === 'object' && !Array.isArray(t[k]) ? lenient(t[k]) : t[k]) : typeof k === 'string' && /^(on|register|create)/.test(k) ? () => ({ dispose() {}, event() {} }) : undefined) });
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? lenient(base) : orig.call(this, r, ...a); };
const TE = require(path.join(EXT, 'tableEditor'));

const page = (lang) => {
  I.setLang(lang);
  const webview = { cspSource: 'csp:', asWebviewUri: (u) => ({ toString: () => 'res:/' + u.path }) };
  return TE._html(webview, { path: 'EXT' });
};
const blockOf = (html) => JSON.parse(/<script type="application\/json" id="tss-i18n">(.*?)<\/script>/.exec(html)[1]);
const run = (html) => {
  const code = fs.readFileSync(path.join(EXT, 'media', 'common', 'i18n.js'), 'utf8');
  const m = /<script type="application\/json" id="tss-i18n">(.*?)<\/script>/.exec(html);
  const box = { document: { getElementById: (id) => (id === 'tss-i18n' ? { textContent: m[1] } : null) } };
  box.window = box;
  vm.runInNewContext(code, box);
  return box.T;
};

try {
  const uk = page('uk'), en = page('en');
  ok(uk.includes('<html lang="uk">') && en.includes('<html lang="en">'), 'the language of the page');
  ok(en.includes('Enter/Tab/arrows: move') && !/Enter\/Tab\/стрілки/.test(en), 'the hint is English');
  ok(uk.includes('Enter/Tab/стрілки: рух'), 'the hint is Ukrainian in uk');
  ok(/об&#39;єднати/.test(en) === false && /merge \/ unmerge/.test(en), 'the apostrophes and slashes of the hint are escaped or kept, nothing is lost');
  eq(blockOf(uk)["⊞ Об'єднати"], "⊞ Об'єднати", 'Ukrainian: as written');
  eq(blockOf(en)["⊞ Об'єднати"], '⊞ Merge');
  eq(blockOf(en)['Видаляй рядки по одному.'], 'Delete rows one by one.');
  eq(blockOf(en)['{0}. Правь її в коді.'], '{0}. Edit it in the code.', 'the {0} stays: the page fills it');
  // the order of the tags: the block, the helper, the libraries, the script of the page
  const iBlock = en.indexOf('id="tss-i18n"'), iHelper = en.indexOf('res:/EXT/media/common/i18n.js'), iPage = en.indexOf('res:/EXT/media/tableEditor/webview.js');
  ok(iBlock > 0 && iHelper > iBlock && iPage > iHelper, 'the block, then the helper, then the script of the page: ' + [iBlock, iHelper, iPage]);
  ok(en.split('<script type="application/json"').length === 2, 'one block');
  ok(/<script nonce="[^"]+" src="res:\/EXT\/media\/common\/i18n\.js"><\/script>/.test(en), 'the helper is loaded with the nonce of the page');
  // end to end: the helper over the block of the host
  const T = run(en);
  eq([T("⊞ Об'єднати"), T('{0}. Правь її в коді.', 'Reason'), T('Колір «{0}» не знайдено в проєкті: у PDF він буде з визначення (тут показано без фону)', 'red'), T('Немає в словнику {0}', 1)], ['⊞ Merge', 'Reason. Edit it in the code.', 'The color “red” was not found in the project: in the PDF it will come from the definition (shown here without a background)', 'Немає в словнику 1']);
  eq(run(uk)("⊞ Об'єднати"), "⊞ Об'єднати");
} finally { I.setLang('uk'); Module._load = orig; }
console.log('tableEditorPage.vscode-stub: ' + n + ' checks passed');
