'use strict';
// node tests/checksHovers.vscode-stub.test.js [path/to/extension]
// 0.22.1: the hover of an image (the size, the modes file / data, too big, a format without a preview), the hover of a missing picture,
// \localinput and \ref in the document, in Ukrainian and in English (checksHovers.js with a stub of vscode, real files in a temp folder).
const assert = require('assert'), path = require('path'), fs = require('fs'), os = require('os'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-hover-'));
const put = (rel, buf) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
const small = put('Pictures/small.png', Buffer.alloc(2048, 1));
const mid = put('Pictures/mid.png', Buffer.alloc(100 * 1024, 2));
const big = put('Pictures/big.png', Buffer.alloc(3 * 1024 * 1024, 3));
const pdf = put('Pictures/doc.pdf', Buffer.alloc(5000, 4));
put('tikz/fig.tikz', '\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n');
const tex = path.join(root, 'A.tex');

const conf = { imagePreviewMode: 'file', imagePreviewMaxMB: 1 };
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(s, l) { this.value += '\n```' + l + '\n' + s + '\n```\n'; return this; } }
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
const stub = new Proxy({
  MarkdownString, Hover, Range, Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Uri: { file: (f) => ({ fsPath: f, toString: () => 'file://' + f }) },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeActionKind: { QuickFix: { append: () => ({}) }, SourceFixAll: { append: () => ({}) }, Source: { append: () => ({}) } },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in conf ? conf[k] : d) }), workspaceFolders: [{ uri: { fsPath: root } }], getWorkspaceFolder: () => null, textDocuments: [] },
  window: { activeTextEditor: null }
}, { get: (o, k) => (k in o ? o[k] : new Proxy(function () {}, { get: () => () => ({}), apply: () => ({}) })) });
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : load.call(this, r, ...a); };
const I = require(path.join(EXT, 'i18n'));
const H = require(path.join(EXT, 'checksHovers'));
const md = (file) => H.imageHoverMd(file).value;
const doc = (text) => ({ uri: { fsPath: tex }, getText: () => text, lineAt: (i) => ({ text: text.split('\n')[i] }), lineCount: text.split('\n').length });
const hoverText = async (text, line, ch) => { const h = await H.hoverProvider.provideHover(doc(text), { line, character: ch }); return h && (typeof h.contents === 'string' ? h.contents : h.contents.value); };

t('image: the name and the size, the thumbnail in file mode, the link that opens the file', () => {
  I.setLang('uk');
  conf.imagePreviewMode = 'file';
  const v = md(small);
  assert.ok(v.startsWith('**small.png**  ·  2 КБ'), v);
  assert.ok(v.includes('![](file://') && v.includes('[Відкрити зображення](command:vscode.open?'), v);
  I.setLang('en');
  const e = md(small);
  assert.ok(e.startsWith('**small.png**  ·  2 KB') && e.includes('[Open image](command:vscode.open?'), e);
});

t('image: too big for the limit (the limit with the decimal separator of the language), data mode over 64 KB', () => {
  conf.imagePreviewMode = 'file'; conf.imagePreviewMaxMB = 1.5;
  I.setLang('uk');
  let v = md(big);
  assert.ok(v.includes('3,0 МБ') && v.includes('ліміт 1,5 МБ') && v.includes('`tssworkflow.imagePreviewMaxMB`'), v);
  I.setLang('en');
  v = md(big);
  assert.ok(v.includes('Too large for a preview: 3.0 MB, the limit is 1.5 MB'), v);
  conf.imagePreviewMode = 'data';
  v = md(mid);
  assert.ok(v.includes('In `data` mode only files up to 64 KB are shown'), v);
  I.setLang('uk');
  assert.ok(md(mid).includes('У режимі `data` показуються лише файли до 64 КБ'));
  conf.imagePreviewMode = 'data';
  assert.ok(md(small).includes('![](data:image/png;base64,'), 'a small file goes into the hover as data');
  conf.imagePreviewMode = 'file'; conf.imagePreviewMaxMB = 1;
});

t('image: a format without a preview gets only the link', () => {
  I.setLang('uk');
  const v = md(pdf);
  assert.ok(v.includes('Попередній перегляд для .pdf недоступний.') && v.includes('[Відкрити файл]'), v);
  I.setLang('en');
  assert.ok(md(pdf).includes('No preview is available for .pdf.') && md(pdf).includes('[Open file]'));
});

t('hover on \\includegraphics, \\localinput and \\ref', async () => {
  I.setLang('uk');
  const g = '\\includegraphics{missing}';
  assert.strictEqual(await hoverText(g, 0, 20), 'Файл не знайдено: Pictures/missing');
  I.setLang('en');
  assert.strictEqual(await hoverText(g, 0, 20), 'File not found: Pictures/missing');
  assert.ok((await hoverText('\\includegraphics{small}', 0, 20)).startsWith('**small.png**'), 'the extension may be omitted');
  assert.strictEqual(await hoverText('\\localinput{nope}', 0, 14), 'File not found: tikz/nope');
  const li = await hoverText('\\localinput{fig}', 0, 14);
  assert.ok(li.startsWith('**fig.tikz**  (3 lines)') || li.startsWith('**fig.tikz**  (4 lines)'), li);
  I.setLang('uk');
  assert.ok((await hoverText('\\localinput{fig}', 0, 14)).includes('рядків)'));
  assert.strictEqual(await hoverText('plain text', 0, 3), undefined);
  // a \ref to a label of the same document: the label name and the environment around it
  const d = '\\begin{equation}\n  E=mc^2 \\label{eq:e}\n\\end{equation}\nsee \\ref{eq:e}';
  const r = await hoverText(d, 3, 11);
  assert.ok(r && r.includes('**eq:e**') && r.includes('E=mc^2'), r);
});

(async () => {
  try {
    for (const [name, fn] of tests) { try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; return; } }
    console.log('\n' + n + ' tests passed');
  } finally { Module._load = load; try { I.setLang('uk'); } catch (e) { /* ignore */ } fs.rmSync(root, { recursive: true, force: true }); }
})();
