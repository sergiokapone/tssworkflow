'use strict';
// node tests/textCommands.vscode-stub.test.js [path/to/extension]
// textCommands.js (normalize, framing, typography, the options of Normalize file) against the shared stub of vscode, in Ukrainian and in English (tssworkflow.language):
// the messages, the buttons of the preview (the English button is understood), the summary, the labels of the quick picks.
const assert = require('assert'), path = require('path'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
const { makeVscode } = require('./vscodeStub');
const I = require(path.join(EXT, 'i18n'));
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };

async function run(lang, { text, sel, fn, button, cfg, quick }) {
  I.setLang(lang);
  const h = makeVscode(text, [sel || [0, 0, 0, 0]], {}, cfg || {});
  const { vs, doc, ed } = h;
  doc.languageId = 'latex'; doc.version = 1; doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  vs.infos = []; vs.status = []; vs.quicks = [];
  vs.window.showInformationMessage = async (m, ...b) => { vs.infos.push([m, ...b]); return b.includes(button) ? button : undefined; };
  vs.window.showWarningMessage = async (m, ...b) => { vs.infos.push(['W:' + m, ...b]); return undefined; };
  vs.window.setStatusBarMessage = (m) => { vs.status.push(m); };
  vs.window.showTextDocument = async () => ed;
  vs.window.showQuickPick = async (items, opts) => { vs.quicks.push({ labels: items.map((i) => i.label), opts }); return undefined; };
  vs.Uri = { parse: (s) => ({ toString: () => s, fsPath: s }), file: (f) => ({ fsPath: f, toString: () => f }) };
  vs.workspace.registerTextDocumentContentProvider = () => ({ dispose() {} });
  vs.ConfigurationTarget = { Global: 1 };
  const orig = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
  for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && /\.js$/.test(k) && !/[\\/]i18n(En)?\.js$/.test(k)) delete require.cache[k];
  try { await require(path.join(EXT, 'textCommands'))[fn](); } finally { Module._load = orig; }
  return { vs, doc, quicks: vs.quicks };
}

(async () => {
  try {
    // 1. nothing to normalize: the message names the mode of the line breaks
    eq((await run('uk', { text: 'Звичайний рядок.\n', fn: 'normalizeCmd' })).vs.infos, [['Нормалізація: змін немає. (переноси рядків не чіпати)']]);
    eq((await run('en', { text: 'Звичайний рядок.\n', fn: 'normalizeCmd' })).vs.infos, [['Normalization: no changes. (leave the line breaks alone)']]);

    // 2. framing: the summary, the buttons of the preview; the answer in the language of the moment applies the change
    const FR = '\\section{Вступ}\nТекст.\n';
    const ukF = await run('uk', { text: FR, fn: 'frameSectionsCmd', button: 'Застосувати' });
    eq(ukF.vs.infos, [['Обрамлення: заголовків 1, формул 0.', 'Застосувати', 'Скасувати']]);
    const enF = await run('en', { text: FR, fn: 'frameSectionsCmd', button: 'Apply' });
    eq(enF.vs.infos, [['Framing: headings 1, equations 0.', 'Apply', 'Cancel']]);
    eq(enF.doc.lines.slice(0, 3), ukF.doc.lines.slice(0, 3), 'the English button applies the same change');
    ok(/^%% -{8,}$/.test(enF.doc.lines[0]) && enF.doc.lines[1] === '\\section{Вступ}', 'the section is framed: ' + enF.doc.lines.slice(0, 3));
    eq(enF.vs.status, ['Framing: headings 1, equations 0.']);
    const noEn = await run('en', { text: FR, fn: 'frameSectionsCmd', button: 'Застосувати' });
    eq(noEn.doc.lines.slice(0, 2), ['\\section{Вступ}', 'Текст.'], 'the Ukrainian button is not an answer in English: nothing applied');

    // 3. nothing to frame: the scope of the search (the file or the selection) is in the sentence
    const TXT = 'Просто текст.\nЩе рядок.\n';
    eq((await run('uk', { text: TXT, fn: 'frameSectionsCmd' })).vs.infos, [['Нічого обрамляти: заголовків і формульних середовищ у файлі не знайдено.']]);
    eq((await run('en', { text: TXT, fn: 'frameSectionsCmd' })).vs.infos, [['Nothing to frame: no headings and equation environments found in the file.']]);
    eq((await run('en', { text: TXT, sel: [0, 0, 1, 5], fn: 'frameSectionsCmd' })).vs.infos, [['Nothing to frame: no headings and equation environments found in the selection.']]);

    // 4. typography of the paragraph under the cursor
    const ty = await run('en', { text: 'Він сказав "привіт" тут.\n', sel: [0, 3, 0, 3], fn: 'typographyCmd' });
    ok(ty.vs.infos.length === 1 && /^Typography fixed: \d+ places$/.test(ty.vs.infos[0][0]), JSON.stringify(ty.vs.infos));
    ok(/«привіт»/.test(ty.doc.lines[0]), 'the quotes are guillemets in the document: ' + ty.doc.lines[0]);
    ok(/^Типографіку виправлено: \d+ місць$/.test((await run('uk', { text: 'Він сказав "привіт" тут.\n', sel: [0, 3, 0, 3], fn: 'typographyCmd' })).vs.infos[0][0]));
    eq((await run('en', { text: 'Нічого міняти тут.\n', sel: [0, 3, 0, 3], fn: 'typographyCmd' })).vs.status, ['Nothing to change']);

    // 5. the options of Normalize file: the labels of the steps and the placeholder
    const q = await run('en', { text: 'x\n', fn: 'normalizeOptions' });
    eq(q.quicks[0].labels, ['Typography (~, ---, «»)', 'Equations \\[ ... \\] → equation*', 'Alignment of tables by &', 'Framing of headings and equations', 'Blank lines (between paragraphs and around headings)']);
    eq(q.quicks[0].opts.placeHolder, 'What Normalize file does (check what you need, Esc cancels)');
    eq((await run('uk', { text: 'x\n', fn: 'normalizeOptions' })).quicks[0].labels[0], 'Типографіка (~, ---, «»)');
  } finally { I.setLang('uk'); }
  console.log('textCommands.vscode-stub: ' + n + ' checks passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
