'use strict';
// node tests/formatters.vscode-stub.test.js [path/to/extension]
// formatters.js (tblr, \tikz, beamer slide numbers) against the shared stub of vscode, in Ukrainian and in English (tssworkflow.language):
// the messages, the titles and the summaries of the previews, the reasons of the skipped places (formattersPure.js).
const assert = require('assert'), path = require('path'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
const { makeVscode } = require('./vscodeStub');
const I = require(path.join(EXT, 'i18n'));
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };

// what register() calls and the test does not look at (on…, register…, create…) is a no-op that returns something disposable
const lenient = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^(on|register|create)/.test(k) ? () => ({ dispose() {} }) : undefined) });

async function run(lang, { id, text, sel }) {
  I.setLang(lang);
  const h = makeVscode(text, [sel || [0, 0, 0, 0]], {}, {});
  const { vs, doc, ed } = h;
  doc.languageId = 'latex'; doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  vs.infos = []; vs.status = []; vs.previews = [];
  vs.window.showInformationMessage = async (m) => { vs.infos.push(m); };
  vs.window.showWarningMessage = async (m) => { vs.infos.push('W:' + m); };
  vs.window.setStatusBarMessage = (m) => { vs.status.push(m); };
  vs.window.showTextDocument = async () => ed;
  vs.workspace = lenient(vs.workspace); vs.window = lenient(vs.window); vs.languages = lenient(vs.languages);
  const handlers = {};
  vs.commands.registerCommand = (cid, fn) => { handlers[cid] = fn; return { dispose() {} }; };
  const orig = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
  for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && /\.js$/.test(k) && !/[\\/]i18n(En)?\.js$/.test(k)) delete require.cache[k];
  try {
    const api = { applyWithPreview: async (e, s, en, lines, title, sum) => { vs.previews.push({ title, sum }); return true; } };
    require(path.join(EXT, 'formatters')).register({ subscriptions: [] }, api);
    await handlers[id]();
  } finally { Module._load = orig; }
  return vs;
}

(async () => {
  try {
    const NO = 'Просто текст.\n';
    // no document of the kind
    eq((await run('uk', { id: 'tssworkflow.formatTblr', text: NO })).infos, ['У файлі немає оточень tblr, longtblr, talltblr.']);
    eq((await run('en', { id: 'tssworkflow.formatTblr', text: NO })).infos, ['No tblr, longtblr, talltblr environments in the file.']);
    eq((await run('en', { id: 'tssworkflow.formatTikz', text: NO })).infos, ['No \\tikz{…} in the file.']);
    eq((await run('uk', { id: 'tssworkflow.formatTikz', text: NO })).infos, ['Немає \\tikz{…} у файлі.']);
    eq((await run('en', { id: 'tssworkflow.renumberBeamer', text: NO })).infos, ['This is not a beamer presentation (no \\documentclass{beamer}), nothing changed.']);
    eq((await run('en', { id: 'tssworkflow.renumberBeamer', text: '\\documentclass{beamer}\n' })).infos, ['The file has no \\begin{frame}, nothing changed.']);

    // tblr: the preview gets the title and the summary in the language of the moment
    const TB = 'Текст.\n\\begin{tblr}{colspec={ll}}\na & b \\\\\ncc  &  d \\\\\n\\end{tblr}\n';
    const tbEn = await run('en', { id: 'tssworkflow.formatTblr', text: TB });
    eq(tbEn.previews, [{ title: 'tblr formatting', sum: 'Tables formatted: 1 (in the file).' }]);
    eq((await run('uk', { id: 'tssworkflow.formatTblr', text: TB })).previews, [{ title: 'Форматування tblr', sum: 'Таблиць відформатовано: 1 (у файлі).' }]);
    // a table that cannot be formatted: the reason of the skip is translated too
    const BAD = 'Текст.\n\\begin{tblr}{colspec={ll}}\na & \\verb|x| \\\\\n\\end{tblr}\n';
    const bad = await run('en', { id: 'tssworkflow.formatTblr', text: BAD });
    ok(bad.infos.length === 1 && /^W:The tables in the file were not changed\. Skipped 1: line \d+: \\verb inside a table\.$/.test(bad.infos[0]), JSON.stringify(bad.infos));
    ok(/^W:Таблиці у файлі не змінено\. Пропущено 1: рядок \d+: \\verb усередині таблиці\.$/.test((await run('uk', { id: 'tssworkflow.formatTblr', text: BAD })).infos[0]));
    const under = await run('en', { id: 'tssworkflow.formatTblr', text: TB, sel: [2, 0, 2, 0] });
    eq(under.previews[0].sum, 'Tables formatted: 1 (under the cursor).');
    eq((await run('uk', { id: 'tssworkflow.formatTblr', text: TB, sel: [2, 0, 2, 0] })).previews[0].sum, 'Таблиць відформатовано: 1 (під курсором).');
    eq((await run('en', { id: 'tssworkflow.formatTblr', text: TB, sel: [0, 0, 3, 3] })).previews[0].sum, 'Tables formatted: 1 (in the selection).');

    // \tikz inline: too short (the message names the scope and the limit), then long enough: split into lines
    const SHORT = '\\tikz{\\draw (0,0) -- (1,1);}\n';
    eq((await run('en', { id: 'tssworkflow.formatTikz', text: SHORT })).infos, ['Nothing to split under the cursor: the code is already on several lines or is shorter than 100 characters (tssworkflow.tikzFormat.minLength).']);
    eq((await run('uk', { id: 'tssworkflow.formatTikz', text: SHORT })).infos, ['Нічого розкладати під курсором: код або вже в кілька рядків, або коротший за 100 символів (tssworkflow.tikzFormat.minLength).']);
    const LONG = 'Текст.\n\\tikz{' + '\\draw (0,0) -- (1,1); '.repeat(8) + '}\n';
    const tk = await run('en', { id: 'tssworkflow.formatTikz', text: LONG });
    ok(tk.previews.length === 1 && tk.previews[0].title === '\\tikz formatting' && /^\\tikz split: \d+ \(in the file\)\.$/.test(tk.previews[0].sum), JSON.stringify(tk.previews) + JSON.stringify(tk.infos));
    ok(/^Розкладено \\tikz: \d+ \(у файлі\)\.$/.test((await run('uk', { id: 'tssworkflow.formatTikz', text: LONG })).previews[0].sum));
  } finally { I.setLang('uk'); }
  console.log('formatters.vscode-stub: ' + n + ' checks passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
