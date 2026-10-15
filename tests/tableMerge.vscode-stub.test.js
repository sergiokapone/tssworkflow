'use strict';
// node tests/tableMerge.vscode-stub.test.js [path/to/extension]  - tableEditor.js on the vscode stub: the question before merging
// cells that hold text, the lightbulb actions for \SetCell <-> options, the warning about a cell merged twice
const assert = require('assert');
const path = require('path');
const Module = require('module');
const EXT = path.resolve(__dirname, process.argv[2] || '../extension');
const { makeVscode } = require('./vscodeStub');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEXT = ['\\begin{tblr}{', '  colspec={ccc},', '}', '\\SetCell[c=2]{c} a & & c \\\\', 'd & e & f \\\\', '\\end{tblr}'].join('\n');
const DUP = ['\\begin{tblr}{', '  colspec={ccc},', '  cell{1}{1} = {c=2},', '}', '\\SetCell[c=2]{c} a & & c \\\\', 'd & e & f \\\\', '\\end{tblr}'].join('\n');
const PLAIN = '\\begin{tblr}{colspec={ccc}}\na & b & c \\\\\nd & e & f \\\\\n\\end{tblr}';

async function scenario(text, answer, act) {
  const h = makeVscode(text, [[3, 3, 3, 3]], {}, {});
  const { vs, ed, doc } = h;
  doc.languageId = 'latex';
  doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  ed.selection = ed.selections[0];
  ed.revealRange = () => {}; ed.setDecorations = () => {}; ed.viewColumn = 1;
  const st = { posted: [], edits: [], asked: [], actions: null, diags: new Map(), panel: null };
  let received = null;
  vs.ViewColumn = { One: 1, Two: 2, Beside: -2 };
  vs.ThemeColor = class { constructor(id) { this.id = id; } };
  vs.OverviewRulerLane = { Center: 2 };
  vs.TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
  vs.Uri = class Uri { constructor(p) { this.path = p; this.fsPath = p; } toString() { return this.path; } static file(f) { return new Uri(f); } static joinPath(u, ...p) { return new Uri([u.path || ''].concat(p).join('/')); } };
  vs.WorkspaceEdit = class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ range, text }); } };
  vs.Diagnostic = class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } };
  vs.DiagnosticSeverity = { Warning: 1, Information: 2 };
  vs.CodeActionKind.QuickFix = { value: 'quickfix' };
  vs.window.visibleTextEditors = [ed];
  vs.window.showInformationMessage = vs.window.showErrorMessage = () => {};
  vs.window.showWarningMessage = async (m) => { st.asked.push(m); return answer; };
  vs.window.showTextDocument = async () => ed;
  vs.window.createTextEditorDecorationType = () => ({});
  vs.window.createWebviewPanel = () => ({ title: '', viewColumn: 2, reveal() {}, webview: { html: '', cspSource: 'x', postMessage: (m) => st.posted.push(m), asWebviewUri: (u) => ({ toString: () => String(u) }), onDidReceiveMessage: (f) => { received = f; } }, onDidChangeViewState() {}, onDidDispose() {} });
  vs.workspace.openTextDocument = async () => doc;
  vs.workspace.textDocuments = [doc];
  vs.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
  vs.workspace.onDidSaveTextDocument = () => ({ dispose() {} });
  vs.workspace.applyEdit = async (we) => { st.edits.push(we); return true; };
  vs.workspace.findFiles = async () => [];
  vs.languages.registerCodeLensProvider = () => ({ dispose() {} });
  vs.languages.registerCodeActionsProvider = (sel, prov) => { st.actions = prov; return { dispose() {} }; };
  vs.languages.createDiagnosticCollection = () => ({ set: (u, d) => st.diags.set(u.toString(), d), delete() {}, dispose() {} });
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vs;
    if (req === './macros') return { _allMacros: async () => ({ cmds: new Map(), envs: new Map() }) };
    return orig.call(this, req, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(EXT) && /\.js$/.test(key)) delete require.cache[key];
  try {
    require(path.join(EXT, 'tableEditor.js')).register({ subscriptions: [], extensionUri: new vs.Uri('/ext') }, { log: () => {} });
    await act({ st, vs, doc, open: () => h.handlers['tssworkflow.editTable'](), message: (m) => received(m) });
  } finally { Module._load = orig; }
  return st;
}

(async () => {
  // merging cells that hold text: asked first; "no" leaves the file alone, "yes" merges
  const merge = { type: 'op', op: { type: 'merge', r1: 0, c1: 0, r2: 1, c2: 1 } };
  let st = await scenario(PLAIN, undefined, async ({ open, message }) => { await open(); message({ type: 'ready' }); await sleep(150); message(merge); await sleep(150); });
  eq(st.asked.length, 1, 'the question is asked');
  ok(/текст/.test(st.asked[0]));
  eq(st.edits.length, 0, 'an answer other than yes changes nothing');
  st = await scenario(PLAIN, 'Об\'єднати', async ({ open, message }) => { await open(); message({ type: 'ready' }); await sleep(150); message(merge); await sleep(150); });
  eq(st.edits.length, 1, 'yes: one edit');
  ok(/\\SetCell\[r=2,c=2\]\{\} a/.test(st.edits[0].edits[0].text), st.edits[0].edits[0].text);
  // an empty selection needs no question
  st = await scenario('\\begin{tblr}{colspec={ccc}}\n & & \\\\\n & & \\\\\n\\end{tblr}', undefined, async ({ open, message }) => { await open(); message({ type: 'ready' }); await sleep(150); message(merge); await sleep(150); });
  eq(st.asked.length, 0); eq(st.edits.length, 1, 'no text, no question');

  // the lightbulb on a \SetCell merge, and on a table with both
  st = await scenario(TEXT, undefined, async () => {});
  ok(st.actions, 'the code action provider is registered');
  const doc = { getText: () => TEXT, offsetAt: (p) => TEXT.split('\n').slice(0, p.line).join('\n').length + (p.line ? 1 : 0) + p.character, positionAt: (o) => ({ offset: o }), uri: 'u' };
  const at = (line, ch) => ({ start: { line, character: ch } });
  const titles = (list) => list.map((a) => a.title);
  let acts = st.actions.provideCodeActions(doc, at(3, 5), { diagnostics: [] });
  ok(titles(acts).some((t) => /Перенести це об'єднання в параметри таблиці \(cell\{1\}\{1\}/.test(t)), titles(acts).join(' | '));
  const moved = acts.find((a) => /Перенести це/.test(a.title));
  ok(/cell\{1\}\{1\} = \{c=2\}\{c\}/.test(moved.edit.edits[0].text) && !/SetCell/.test(moved.edit.edits[0].text), moved.edit.edits[0].text);
  eq(st.actions.provideCodeActions(doc, at(4, 1), { diagnostics: [] }).filter((a) => /Перенести це/.test(a.title)).length, 0, 'not on a cell without a merge');

  // a cell merged twice: a quick fix both ways
  const ddoc = Object.assign({}, doc, { getText: () => DUP, offsetAt: (p) => DUP.split('\n').slice(0, p.line).join('\n').length + (p.line ? 1 : 0) + p.character });
  acts = st.actions.provideCodeActions(ddoc, at(4, 3), { diagnostics: [] });
  eq(titles(acts).filter((t) => /^Залишити/.test(t)).length, 2, titles(acts).join(' | '));
  // the warning in the editor for the cell merged twice, none for a clean table
  st = await scenario(DUP, undefined, async () => {});
  const dd = [...st.diags.values()][0] || [];
  eq(dd.map((d) => d.code), ['table-span-dup'], 'a warning for the cell merged twice');
  ok(/двічі/.test(dd[0].message));
  st = await scenario(TEXT, undefined, async () => {});
  eq([...st.diags.values()].flat().length, 0, 'a clean table: no warning');
  console.log('\n' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
