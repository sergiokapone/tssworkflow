'use strict';
/* keyFormulas.js against a stub of vscode: markKeyFormula edits the document, keyFormulasDraft opens a LaTeX document.
 * node tests/keyFormulas.vscode-stub.test.js [extension] */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const EXT = path.resolve(__dirname, process.argv[2] || '../extension');
const { makeVscode } = require('./vscodeStub');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

const TEXT = '\\chapter{Заряди}\n\\begin{equation}\n  E = mc^2\\label{eq:e}\n\\end{equation}';
function env(cursorLine, files) {
  const h = makeVscode(TEXT, [[cursorLine, 0, cursorLine, 0]], {}, {});
  const { vs, doc } = h;
  doc.languageId = 'latex';
  doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  vs.ViewColumn = { One: 1, Beside: -2 };
  vs.workspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
  vs.workspace.asRelativePath = () => 'a.tex';
  vs.infos = []; vs.opened = []; vs.status = [];
  vs.window.showInformationMessage = (m) => { vs.infos.push(m); };
  vs.window.setStatusBarMessage = (m) => { vs.status.push(m); };
  vs.workspace.openTextDocument = async (o) => { vs.opened.push(o); return o; };
  vs.window.showTextDocument = async () => {};
  const FL = { projectFiles: async () => files || [], chapterOrder: () => [], byChapter: () => () => 0 };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vs;
    if (req === './filesAndLabels') return FL;
    return orig.call(this, req, ...rest);
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && /\.js$/.test(k)) delete require.cache[k];
  const ctx = { subscriptions: [] };
  require(path.join(EXT, 'keyFormulas.js')).register(ctx);
  return { h, vs, doc, done: () => { Module._load = orig; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let e = env(2);
  try {
    await e.h.handlers['tssworkflow.markKeyFormula'](); await sleep(10);
    eq(e.doc.lines[1], '%! key', 'the mark is inserted above \\begin');
    eq(e.doc.lines.length, 5, 'one line added');
    await e.h.handlers['tssworkflow.markKeyFormula'](); await sleep(10);
    eq(e.doc.getText(), TEXT, 'the second call removes it: the text is the same as at the start');
  } finally { e.done(); }

  e = env(0);
  try {
    await e.h.handlers['tssworkflow.markKeyFormula'](); await sleep(10);
    eq(e.doc.getText(), TEXT, 'a cursor outside a formula changes nothing');
    ok(e.vs.infos.length === 1, 'and says so');
  } finally { e.done(); }

  e = env(2);
  try {
    await e.h.handlers['tssworkflow.keyFormulasDraft'](); await sleep(10);
    eq(e.vs.opened.length, 0, 'nothing is marked: no document');
    ok(/%! key/.test(e.vs.infos[0] || ''), 'the message names the mark');
  } finally { e.done(); }

  // the project: a marked formula in a file that is not open
  const files = [{ path: 'Ch/Ch.tex', abs: '/p/Ch/Ch.tex', text: '\\chapter{Поле}\n%! key: Енергія\n\\begin{equation}\n  E = mc^2\\label{eq:e}\n\\end{equation}' }];
  e = env(0, files);
  try {
    await e.h.handlers['tssworkflow.keyFormulasDraft'](); await sleep(10);
    eq(e.vs.opened.length, 1, 'a draft is opened');
    eq(e.vs.opened[0].language, 'latex', 'as a LaTeX document');
    ok(e.vs.opened[0].content.includes('\\item Енергія (\\eqref{eq:e})') && e.vs.opened[0].content.includes('Поле (Ch/Ch.tex)'), 'with the formula and the chapter');
  } finally { e.done(); }

  console.log('keyFormulas (stub): ' + n + ' checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
