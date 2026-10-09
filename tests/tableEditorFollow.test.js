'use strict';
/* Tests of "the file follows the grid" of the table editor: rowSpans (pure) and tableEditor.js with a stub of vscode
 * (a webview panel that records what it is sent, an editor that records revealRange / decorations).
 * Run from the repository root: node tests/tableEditorFollow.test.js [extension] */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const X = require(path.join(EXT, 'tableEditorPure.js'));
const { makeVscode, Position, Range, Selection } = require('./vscodeStub');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEXT = ['intro', '\\begin{tblr}{colspec={ll}}', '  \\hline', '  a & b \\\\', '  % comment', '  c & d \\\\ \\hline', '  e & f', '\\end{tblr}', 'after'].join('\n');

// rowSpans: where the first cell of every row stands, and the rows are contiguous
(() => {
  const env = X.locateTables(TEXT)[0];
  const model = X.parseTable(TEXT, env).model;
  const spans = X.rowSpans(model, env.bodyStart + model.head.length);
  eq(spans.length, 3);
  eq(spans.map((s) => TEXT.slice(s.content, s.content + 5)), ['a & b', 'c & d', 'e & f']);
  eq(spans[1].start, spans[0].end, 'contiguous');
  eq(spans[2].end, env.bodyEnd, 'the last row ends at the end of the body');
  const crlf = TEXT.replace(/\n/g, '\r\n');
  const e2 = X.locateTables(crlf)[0];
  const m2 = X.parseTable(crlf, e2).model;
  eq(X.rowSpans(m2, e2.bodyStart + m2.head.length).map((s) => crlf.slice(s.content, s.content + 5)), ['a & b', 'c & d', 'e & f'], 'CRLF');
})();

/* ---- tableEditor.js against a stub ---- */
async function scenario(mode, visible, act) {
  const h = makeVscode(TEXT, [[3, 4, 3, 4]], {}, mode ? { 'tableEditor.followEditor': mode } : {});
  const { vs, ed, doc } = h;
  doc.languageId = 'latex';
  doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  ed.selection = ed.selections[0];
  const rec = { reveals: [], decos: [], shown: 0, posted: [] };
  ed.revealRange = (r, t) => rec.reveals.push([r.start.line, r.start.character, r.end.line, r.end.character, t]);
  ed.setDecorations = (type, rs) => rec.decos.push([type.name, rs.map((r) => [r.start.line, r.end.line])]);
  ed.viewColumn = 1;
  let received = null;
  let viewState = null;
  vs.ViewColumn = { One: 1, Two: 2, Beside: -2 };
  vs.ThemeColor = class { constructor(id) { this.id = id; } };
  vs.OverviewRulerLane = { Center: 2 };
  vs.TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
  vs.CodeLens = class {};
  vs.Uri = class Uri {
    constructor(p) { this.path = p; this.fsPath = p; }
    toString() { return this.path; }
    static file(f) { return new Uri(f); }
    static joinPath(u, ...p) { return new Uri([u.path || ''].concat(p).join('/')); }
  };
  vs.window.visibleTextEditors = visible ? [ed] : [];
  vs.window.showInformationMessage = vs.window.showWarningMessage = vs.window.showErrorMessage = (m) => { rec.msg = m; };
  vs.window.showTextDocument = async () => { rec.shown++; vs.window.visibleTextEditors = [ed]; return ed; };
  let k = 0;
  vs.window.createTextEditorDecorationType = (o) => ({ name: ['table', 'row'][k++] || 'other', o });
  vs.window.createWebviewPanel = () => ({
    title: '', viewColumn: 2, reveal() {},
    webview: { html: '', cspSource: 'x', postMessage: (m) => { rec.posted.push(m); }, asWebviewUri: (u) => ({ toString: () => String(u) }), onDidReceiveMessage: (f) => { received = f; } },
    onDidChangeViewState: (f) => { viewState = f; }, onDidDispose() {}
  });
  vs.workspace.openTextDocument = async () => doc;
  vs.workspace.textDocuments = [doc];
  vs.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
  vs.workspace.applyEdit = async () => true;
  vs.languages.registerCodeLensProvider = () => ({ dispose() {} });

  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vs;
    if (req === './macros') return { _allMacros: async () => ({ cmds: new Map(), envs: new Map() }) };
    return orig.call(this, req, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(EXT) && /\.js$/.test(key)) delete require.cache[key];
  try {
    require(path.join(EXT, 'tableEditor.js')).register({ subscriptions: [], extensionUri: { path: '/ext', toString: () => '/ext' } });
    await h.handlers['tssworkflow.editTable']();
    await sleep(150);
    rec.afterOpen = { reveals: rec.reveals.slice(), decos: rec.decos.slice() };
    rec.reveals.length = 0; rec.decos.length = 0;
    await act({ received, viewState, rec, ed, vs });
  } finally { Module._load = orig; }
  return rec;
}

(async () => {
  // opening the table shows it in the file (start of the table), highlighted
  let r = await scenario(null, true, async () => {});
  eq(r.afterOpen.reveals.map((x) => x.slice(0, 4)), [[1, 0, 1, 0]], 'opening reveals the start of the table');
  eq(r.afterOpen.decos.filter((d) => d[1].length).map((d) => d[0]), ['table'], 'the table is highlighted, no row yet');

  // a click on row 1 of the grid: the file scrolls to it and highlights it; the focus is not taken
  r = await scenario(null, true, async ({ received, rec }) => {
    received({ type: 'follow', r: 1 });
    await sleep(200);
  });
  eq(r.reveals.map((x) => x.slice(0, 2)), [[5, 2]], 'the row of "c & d"');
  eq(r.decos.filter((d) => d[1].length), [['table', [[1, 7]]], ['row', [[5, 5]]]], 'table and row highlighted');
  eq(r.shown, 0, 'the editor is already visible: nothing is opened');

  // several moves in a burst are one reveal, the last one
  r = await scenario('highlight', true, async ({ received }) => {
    received({ type: 'follow', r: 0 }); received({ type: 'follow', r: 1 }); received({ type: 'follow', r: 2 });
    await sleep(250);
  });
  eq(r.reveals.map((x) => x.slice(0, 2)), [[6, 2]], 'a burst of messages gives one reveal');

  // the whole table (no row), the last row (a row number past the end is clamped)
  r = await scenario('highlight', true, async ({ received }) => { received({ type: 'follow', r: null }); await sleep(200); received({ type: 'follow', r: 99 }); await sleep(200); });
  eq(r.reveals.map((x) => x.slice(0, 2)), [[1, 0], [6, 2]]);

  // modes
  r = await scenario('reveal', true, async ({ received }) => { received({ type: 'follow', r: 1 }); await sleep(200); });
  eq(r.reveals.length, 1);
  eq(r.decos.filter((d) => d[1].length), [], 'reveal: no highlight');
  r = await scenario('off', true, async ({ received }) => { received({ type: 'follow', r: 1 }); await sleep(200); });
  eq(r.reveals, [], 'off: the file stays where it is');
  r = await scenario('cursor', true, async ({ received, ed }) => {
    received({ type: 'follow', r: 2 }); await sleep(200);
    ok(ed.selection.start.line === 6 && ed.selection.start.character === 2, 'cursor: the caret is at the row');
  });
  eq(r.reveals.length, 1);

  // the file is not visible (closed tab): it is opened without taking the focus
  r = await scenario(null, false, async ({ received }) => { received({ type: 'follow', r: 1 }); await sleep(200); });
  eq(r.shown, 1, 'a closed tab is opened once, without the focus');
  eq(r.afterOpen.reveals.length, 1, 'and the table is revealed in it');
  eq(r.reveals.length, 1, 'the next move reveals in the tab that is open now');

  // coming back to the panel returns the file to the last row
  r = await scenario(null, true, async ({ received, viewState }) => {
    received({ type: 'follow', r: 2 }); await sleep(200);
    viewState({ webviewPanel: { visible: true, active: true } }); await sleep(200);
  });
  eq(r.reveals.map((x) => x.slice(0, 2)), [[6, 2], [6, 2]], 'the panel becoming active repeats the last reveal');

  console.log('tableEditorFollow: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
