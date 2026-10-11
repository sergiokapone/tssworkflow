'use strict';
// node tests/projectStats.vscode-stub.test.js [path/to/extension]
// The command "Project statistics" on a stubbed vscode: the control questions come from quizlist, stats.exclude leaves files and
// folders out of the table and the total
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-stats-'));
const QL = '\\begin{quizlist}\n\\item one\n\\item two\n\\begin{enumerate}\\item nested\\end{enumerate}\n\\item three\n\\end{quizlist}\n';
const files = {
  'main.tex': '\\documentclass{book}\n\\begin{document}\n\\includechapter{Alpha}\n\\includechapter{Preface}\n\\includechapter{Appendix}\n\\end{document}\n',
  'Alpha/Alpha.tex': '\\chapter{Alpha}\n\\section{Теорія}\nслово слово слово\n\\section{Контрольні запитання}\n' + QL,
  'Preface/Preface.tex': '\\chapter{Preface}\nпередмова передмова\n' + QL,
  'Appendix/Appendix.tex': '\\chapter{Appendix}\nдодаток\n',
  'Appendix/Tests/t1.tex': '\\chapter{Tests}\nтест\n' + QL,
  'notes.tex': 'нотатки нотатки нотатки нотатки\n'
};
const texts = new Map();
for (const [rel, txt] of Object.entries(files)) { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); texts.set(f, txt); }
const uris = [...texts.keys()].map((f) => ({ fsPath: f, path: f, scheme: 'file', toString: () => 'file://' + f }));

const handler = { get: (t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const disp = { dispose() {} };
const commands = {}, opened = [];
const cfgv = {};
const folder = { uri: { fsPath: proj, toString: () => 'file://' + proj }, name: 'p', index: 0 };
const cfg = { get: (k, d) => (k in cfgv ? cfgv[k] : d), update: async () => {}, has: () => false, inspect: () => ({}) };
const vscode = mk({
  commands: mk({ registerCommand: (id, fn) => { commands[id] = fn; return disp; }, executeCommand: async () => undefined }),
  window: mk({ createTreeView: () => disp, showTextDocument: async () => undefined, showInformationMessage: async () => undefined }),
  workspace: mk({ workspaceFolders: [folder], getConfiguration: () => cfg, getWorkspaceFolder: () => folder, openTextDocument: async (o) => { opened.push(o.content); return { uri: { fsPath: 'stats.md' } }; }, onDidChangeTextDocument: () => disp, onDidSaveTextDocument: () => disp, onDidChangeConfiguration: () => disp }),
  Uri: { file: (p) => ({ fsPath: p, path: p, toString: () => 'file://' + p }) },
  version: '1.141.0'
});
const load = Module._load;
Module._load = function (req, ...a) { return req === 'vscode' ? vscode : load.call(this, req, ...a); };
const api = { texFiles: async () => uris, textOf: (u) => texts.get(u.fsPath), buildIndex: async () => new Map(), showLog() {} };
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

(async () => {
  require(path.join(ext, 'projectInfo.js')).register({ subscriptions: [] }, api);
  const run = async () => { opened.length = 0; await commands['tssworkflow.projectStats'](); return opened[0]; };
  const row = (md, name) => { const l = md.split('\n').find((x) => x.startsWith('| **' + name + '**')); return l ? l.split('|').map((c) => c.trim()).filter(Boolean) : null; };
  const head = (md) => md.split('\n').find((l) => l.startsWith('| Розділ')).split('|').map((c) => c.trim()).filter(Boolean);

  let md = await run();
  const col = head(md).indexOf('Контр. запитань');
  ok(col > 0, 'the column of control questions: ' + head(md));
  ok(row(md, 'Alpha/Alpha.tex')[col] === '3', 'quizlist: 3 items, the nested one not counted: ' + row(md, 'Alpha/Alpha.tex'));
  ok(row(md, 'Preface/Preface.tex')[col] === '3', 'quizlist outside a section with a title');
  ok(row(md, 'Appendix/Appendix.tex')[col] === '—', 'no quizlist: the dash');
  ok(row(md, 'Разом')[col] === '9', 'the total: Alpha 3 + Preface 3 + Tests 3: ' + row(md, 'Разом'));
  ok(!/Не враховано файлів/.test(md), 'nothing is left out: no note');

  // the old way: the title of a section
  cfgv['stats.questionEnvs'] = [];
  md = await run();
  ok(row(md, 'Alpha/Alpha.tex')[col] === '1', 'an empty list of environments: the section title and plain lists only; quizlist is not one, so only its nested list is seen (the old wrong number): ' + row(md, 'Alpha/Alpha.tex'));
  delete cfgv['stats.questionEnvs'];

  // exclude: a folder, a file, a path, a mask
  cfgv['stats.exclude'] = ['Preface'];
  md = await run();
  ok(row(md, 'Preface/Preface.tex') === null, 'a folder is left out');
  ok(row(md, 'Alpha/Alpha.tex') !== null && row(md, 'notes.tex') !== null, 'the rest stays');
  ok(/Не враховано файлів: 1 /.test(md), 'the note says how many: ' + md.split('\n').slice(-3).join(' '));
  ok(row(md, 'Разом')[col] === '6', 'and it is not in the total: ' + row(md, 'Разом'));
  cfgv['stats.exclude'] = ['Appendix/Tests/', 'notes.tex'];
  md = await run();
  ok(row(md, 'Appendix/Tests/t1.tex') === null && row(md, 'notes.tex') === null && row(md, 'Appendix/Appendix.tex') !== null, 'a path with a slash and a file');
  ok(/Не враховано файлів: 2 /.test(md), md.split('\n').slice(-3).join(' '));
  cfgv['stats.exclude'] = ['**/t*.tex', 'Alpha/*'];
  md = await run();
  ok(row(md, 'Appendix/Tests/t1.tex') === null && row(md, 'Alpha/Alpha.tex') === null, 'masks');
  cfgv['stats.exclude'] = [];
  md = await run();
  ok(row(md, 'Preface/Preface.tex') !== null, 'an empty list leaves nothing out');
  fs.rmSync(proj, { recursive: true, force: true });
  console.log('projectStats.vscode-stub: ' + n + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
