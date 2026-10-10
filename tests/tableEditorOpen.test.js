'use strict';
/* Tests of how the table editor opens: tables whose arguments stand after a %-comment (pure), and the order of the
 * messages to the grid (the grid first, the colours and macros of the project after, cached afterwards).
 * Run from the repository root: node tests/tableEditorOpen.test.js [extension] */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const X = require(path.join(EXT, 'tableEditorPure.js'));
const MP = require(path.join(EXT, 'macrosPure.js'));
const { makeVscode } = require('./vscodeStub');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- arguments after a %-comment ---- */
const parse = (text) => { const env = X.locateTables(text)[0]; return { env, res: X.parseTable(text, env) }; };
const spans = (text) => { const { env, res } = parse(text); return X.rowSpans(res.model, env.bodyStart + res.model.head.length).map((s) => text.slice(s.content, s.content + 5)); };

const USER = [
  '\\begin{table}',
  '    \\begin{tblr}%',
  '        {',
  '            colspec = {Q[l]Q[r]},',
  '            hlines, vlines,',
  '        }',
  '        a & b \\\\',
  '        c & d \\\\',
  '    \\end{tblr}',
  '\\end{table}'
].join('\n');
{
  const { env, res } = parse(USER);
  ok(!res.skip, 'the table with {…} after "%" is read: ' + res.skip);
  eq(res.model.rows.length, 2);
  eq(res.model.rows.map((r) => r.cells.map((c) => c.inner)), [['a', 'b'], ['c', 'd']]);
  eq(res.model.head, '%\n        {\n            colspec = {Q[l]Q[r]},\n            hlines, vlines,\n        }', 'the comment and the layout of the options stay as they are');
  eq(spans(USER), ['a & b', 'c & d']);
  const r = X.applyOp(res.model, { type: 'setCell', r: 1, c: 0, text: 'X' });
  const out = X.serialize(r.model, { align: true });
  ok(out.startsWith('\\begin{tblr}%\n        {\n            colspec = {Q[l]Q[r]},\n            hlines, vlines,\n        }'), 'the head is written back unchanged');
  ok(/X\s*& d/.test(out) && /a\s*& b/.test(out), 'the cell is changed');
  const again = USER.slice(0, env.start) + out + USER.slice(env.end);
  eq(parse(again).res.model.rows.length, 2, 'the result is read again');
}
// a comment with text, two comment lines, tabular, an optional argument first
eq(spans('\\begin{tabular}% a note\n  {ll}\n a & b \\\\\n\\end{tabular}'), ['a & b']);
eq(spans('\\begin{tblr}%\n%\n  {colspec={ll}}\n a & b \\\\\n\\end{tblr}'), ['a & b']);
eq(spans('\\begin{tabular}[t]%\n{ll}\n a & b \\\\\n\\end{tabular}'), ['a & b']);
eq(spans('\\begin{tabularx}{\\linewidth}%\n{lX}\n a & b \\\\\n\\end{tabularx}'), ['a & b']);
// the same table without the comment gives the same rows
eq(spans(USER.replace('%\n        {', '\n        {')), ['a & b', 'c & d']);
// a "%" inside the body is not an argument
eq(parse('\\begin{tblr}{colspec={l}}\n% c\n a \\\\\n\\end{tblr}').res.model.rows.length, 1);
// the required group never comes: not a table that can be edited (no crash)
ok(parse('\\begin{tblr}%\n a & b \\\\\n\\end{tblr}').res.skip, 'no options group: skipped');

/* ---- the order of the messages ---- */
async function scenario(act) {
  const TEXT = '\\begin{tblr}{colspec={ll}, cell{1}{1}={bg=brand}}\n a & b \\\\\n\\end{tblr}';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-open-'));
  const defs = path.join(dir, 'colors.tex');
  fs.writeFileSync(defs, '\\definecolor{brand}{RGB}{10,20,30}');
  const h = makeVscode(TEXT, [[1, 1, 1, 1]], {}, {});
  const { vs, ed, doc } = h;
  doc.languageId = 'latex';
  doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  ed.selection = ed.selections[0];
  ed.revealRange = () => {}; ed.setDecorations = () => {}; ed.viewColumn = 1;
  const st = { posted: [], macrosDone: false, logs: [], macrosCalls: 0, panels: 0 };
  let received = null;
  vs.ViewColumn = { One: 1, Two: 2, Beside: -2 };
  vs.ThemeColor = class { constructor(id) { this.id = id; } };
  vs.OverviewRulerLane = { Center: 2 };
  vs.TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
  vs.CodeLens = class { constructor(r, c) { this.range = r; this.command = c; } };
  vs.Uri = class Uri {
    constructor(p) { this.path = p; this.fsPath = p; }
    toString() { return this.path; }
    static file(f) { return new Uri(f); }
    static joinPath(u, ...p) { return new Uri([u.path || ''].concat(p).join('/')); }
  };
  vs.window.visibleTextEditors = [ed];
  vs.window.showInformationMessage = vs.window.showWarningMessage = vs.window.showErrorMessage = () => {};
  vs.window.showTextDocument = async () => ed;
  vs.window.createTextEditorDecorationType = () => ({});
  vs.window.createWebviewPanel = () => {
    st.panels++;
    return {
      title: '', viewColumn: 2, reveal() {},
      webview: { html: '', cspSource: 'x', postMessage: (m) => { st.posted.push({ m, macrosDone: st.macrosDone }); }, asWebviewUri: (u) => ({ toString: () => String(u) }), onDidReceiveMessage: (f) => { received = f; } },
      onDidChangeViewState() {}, onDidDispose() {}
    };
  };
  vs.workspace.openTextDocument = async () => doc;
  vs.workspace.textDocuments = [doc];
  vs.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
  let saved = null;
  vs.workspace.onDidSaveTextDocument = (f) => { saved = f; return { dispose() {} }; };
  vs.workspace.applyEdit = async () => true;
  vs.workspace.findFiles = async () => [{ fsPath: defs }, { fsPath: path.join(dir, 'missing.tex') }];
  vs.languages.registerCodeLensProvider = (sel, prov) => { st.lens = prov; return { dispose() {} }; };

  const macroEntries = MP.scanMacros('\\newcommand{\\vect}[1]{\\mathbf{#1}}').filter((e) => e.kind !== 'env');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vs;
    if (req === './macros') return { _allMacros: async () => { st.macrosCalls++; await sleep(120); st.macrosDone = true; return { cmds: new Map(macroEntries.map((e) => [e.name, e])), envs: new Map() }; } };
    return orig.call(this, req, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(EXT) && /\.js$/.test(key)) delete require.cache[key];
  try {
    require(path.join(EXT, 'tableEditor.js')).register({ subscriptions: [], extensionUri: new vs.Uri('/ext') }, { log: (m) => st.logs.push(m) });
    await act({ h, st, vs, doc, open: () => h.handlers['tssworkflow.editTable'](), message: (m) => received(m), save: (d) => saved(d), sleep });
  } finally { Module._load = orig; fs.rmSync(dir, { recursive: true, force: true }); }
  return st;
}

(async () => {
  // first open: the grid at once (macros not ready), then the picture with the colours and macros
  let st = await scenario(async ({ open, message }) => {
    await open();
    message({ type: 'ready' });
    await sleep(500);
  });
  const models = st.posted.filter((p) => p.m.type === 'model');
  eq(models.length, 2, 'two pictures on a cold start');
  eq(models[0].macrosDone, false, 'the first picture does not wait for the macros');
  eq(models[0].m.macros, {}, 'no macros yet');
  eq(models[0].m.view.rows[0].cells[0].style.unknownColor, 'brand', 'colour not known yet');
  ok(Object.keys(models[1].m.macros).length > 0, 'the second picture has the macros of the project');
  eq(models[1].m.view.rows[0].cells[0].style.bg, 'rgb(10,20,30)', 'and the colours');
  eq(st.panels, 1);
  ok(st.logs.some((l) => /сітка надіслана/.test(l)) && st.logs.some((l) => /кольори й макроси готові/.test(l)), 'timings are logged: ' + st.logs.join(' | '));

  // the caches are warm: a single picture, and the macros are not asked for again
  const warm = await scenario(async ({ st: s, open, message }) => {
    await open(); message({ type: 'ready' }); await sleep(400);
    const before = s.posted.filter((p) => p.m.type === 'model').length;
    message({ type: 'ready' }); await sleep(100);
    s.added = s.posted.filter((p) => p.m.type === 'model').length - before;
  });
  eq(warm.added, 1, 'warm: a single picture');
  eq(warm.macrosCalls, 1, 'the macros were asked for once');

  // a file with colour definitions was saved: the next picture is cold again (two pictures)
  const saved = await scenario(async ({ st: s, open, message, save }) => {
    await open(); message({ type: 'ready' }); await sleep(400);
    const before = s.posted.filter((p) => p.m.type === 'model').length;
    save({ uri: { fsPath: '/p/colors.tex' }, getText: () => '\\definecolor{x}{RGB}{1,2,3}' });
    message({ type: 'ready' }); await sleep(500);
    s.added = s.posted.filter((p) => p.m.type === 'model').length - before;
  });
  eq(saved.added, 2, 'after a save with definitions: the grid first, then the picture with the colours');

  // an unrelated save keeps the cache
  const other = await scenario(async ({ st: s, open, message, save }) => {
    await open(); message({ type: 'ready' }); await sleep(400);
    const before = s.posted.filter((p) => p.m.type === 'model').length;
    save({ uri: { fsPath: '/p/chapter.tex' }, getText: () => 'just text' });
    message({ type: 'ready' }); await sleep(100);
    s.added = s.posted.filter((p) => p.m.type === 'model').length - before;
  });
  eq(other.added, 1, 'a save without colour definitions keeps the cache');

  // opening again while the tab exists: the table is sent at once, the tab is reused
  const withTab = await scenario(async ({ st: s, open, message }) => {
    await open(); message({ type: 'ready' }); await sleep(400);
    const before = s.posted.length;
    await open();
    s.sentAtOnce = s.posted.slice(before).some((p) => p.m.type === 'model');
  });
  ok(withTab.sentAtOnce && withTab.panels === 1, 'the second open reuses the tab and sends the table at once');

  // the CodeLens prefetches the colours and macros
  st = await scenario(async ({ st: s, doc, sleep: sl }) => {
    const lenses = s.lens.provideCodeLenses(doc);
    s.lensCount = lenses.length;
    await sl(1900);
  });
  eq(st.lensCount, 1);
  ok(st.macrosCalls >= 1 && st.logs.some((l) => /кольори проєкту/.test(l)), 'warm-up ran after the lens was shown');

  console.log('tableEditorOpen: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
