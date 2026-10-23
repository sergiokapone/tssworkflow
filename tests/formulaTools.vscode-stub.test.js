'use strict';
/* Tests of the commands and panels of 0.18.0 against a stub of vscode: "Copy formula as MathML" (formulaCopy.js), the panels
 * "Macro gallery" (macroGallery.js) and "Formulas of the project" (formulaOverview.js): what goes into the clipboard, which file
 * a click opens (the extension takes it from its own list, never from the page), what the page receives.
 * Run from the repository root: node tests/formulaTools.vscode-stub.test.js [extension] */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const MP = require(path.join(EXT, 'macrosPure.js'));
const { makeVscode } = require('./vscodeStub');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(text, selections, cfgValues, stubs) {
  const h = makeVscode(text, selections, {}, cfgValues || {});
  const { vs, doc } = h;
  doc.languageId = 'latex';
  doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  vs.ViewColumn = { One: 1, Two: 2, Beside: -2 };
  vs.Uri = class Uri { constructor(p) { this.path = p; this.fsPath = p; } toString() { return this.path; } static file(f) { return new Uri(f); } static joinPath(u, ...p) { return new Uri([u.path || ''].concat(p).join('/')); } };
  vs.workspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
  vs.workspace.getWorkspaceFolder = () => vs.workspace.workspaceFolders[0];
  vs.env = { clipboard: { written: [], async writeText(t) { this.written.push(t); } } };
  vs.infos = [];
  vs.window.showInformationMessage = (m) => { vs.infos.push(m); };
  vs.window.showWarningMessage = (m) => { vs.warned = m; };
  vs.shown = [];
  vs.window.showTextDocument = async (uri, opts) => { vs.shown.push({ file: uri.fsPath, line: opts && opts.selection ? opts.selection.start.line : null }); };
  vs.window.onDidChangeActiveTextEditor = () => ({ dispose() {} });
  const st = { posted: [], panels: 0 };
  let onMsg = null;
  vs.window.createWebviewPanel = () => {
    st.panels++;
    return {
      reveal() {}, dispose() {}, onDidDispose() {},
      webview: { html: '', cspSource: 'csp', asWebviewUri: (u) => u, postMessage: (m) => { st.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { onMsg = f; } }
    };
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vs;
    if (stubs && Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
    return orig.call(this, req, ...rest);
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && /\.js$/.test(k)) delete require.cache[k];
  const ctx = { subscriptions: [], extensionPath: EXT, extensionUri: { path: EXT, fsPath: EXT } };
  return { h, vs, doc, st, ctx, send: (m) => onMsg(m), done: () => { Module._load = orig; } };
}

const TE = { katexMacros: async () => ({ '\\vect': '\\mathbf{#1}' }) };

(async () => {
  /* ------------------------------ copyFormula ------------------------------ */
  const text = 'Поле $\\vect{E}+\\frac{a}{b}$ тут і\n\\[ x^2 \\]\nпросто текст.';
  const run = async (sel, cfg) => {
    const e = env(text, [sel], cfg, { './tableEditor': TE });
    try { require(path.join(EXT, 'formulaCopy.js')).register(e.ctx); await e.h.handlers['tssworkflow.copyFormula'](); } finally { e.done(); }
    return e;
  };
  let e = await run([0, 12, 0, 12]);
  ok(e.vs.env.clipboard.written.length === 1 && /^<math[\s\S]*<\/math>$/.test(e.vs.env.clipboard.written[0]), 'caret in $..$: MathML is copied');
  ok(/mathvariant="bold"/.test(e.vs.env.clipboard.written[0]) && /<mfrac>/.test(e.vs.env.clipboard.written[0]), 'the macro \\vect of the project is expanded, the fraction is a real <mfrac>');
  ok(!/display="block"/.test(e.vs.env.clipboard.written[0]), 'an inline formula is not a block');
  ok(e.vs.infos.length === 1 && /MathML/.test(e.vs.infos[0]), 'a notice');

  e = await run([1, 5, 1, 5]);
  ok(/display="block"/.test(e.vs.env.clipboard.written[0]) && /<msup>/.test(e.vs.env.clipboard.written[0]), 'caret in \\[..\\]: a block formula with a superscript');

  e = await run([2, 3, 2, 3]);
  eq(e.vs.env.clipboard.written, [], 'caret outside of a formula: nothing is copied');
  ok(e.vs.infos.length === 1 && /не у формулі/.test(e.vs.infos[0]), 'and the notice says why');

  e = await run([0, 15, 0, 26]);
  ok(e.vs.env.clipboard.written.length === 1 && /<mfrac>/.test(e.vs.env.clipboard.written[0]) && !/mathvariant="bold"/.test(e.vs.env.clipboard.written[0]), 'a selection inside a formula: the selected part only');

  e = await run([0, 12, 0, 12], { 'copyFormula.format': 'latex' });
  eq(e.vs.env.clipboard.written, ['\\vect{E}+\\frac{a}{b}'], 'format latex: the TeX of the formula');

  const bad = env('$\\undefinedmacro{x}$', [[0, 3, 0, 3]], {}, { './tableEditor': TE });
  try { require(path.join(EXT, 'formulaCopy.js')).register(bad.ctx); await bad.h.handlers['tssworkflow.copyFormula'](); } finally { bad.done(); }
  ok(bad.vs.env.clipboard.written.length === 0 && /KaTeX/.test(String(bad.vs.warned)), 'a formula KaTeX cannot read: a warning, no clipboard');

  const chem = env('$\\ce{H2O}$', [[0, 3, 0, 3]], {}, { './tableEditor': TE });
  try { require(path.join(EXT, 'formulaCopy.js')).register(chem.ctx); await chem.h.handlers['tssworkflow.copyFormula'](); } finally { chem.done(); }
  ok(chem.vs.env.clipboard.written.length === 1 && /<math/.test(chem.vs.env.clipboard.written[0]), '\\ce is read through mhchem');

  /* ------------------------------ macro gallery ------------------------------ */
  const macros = MP.scanMacros('% напруженість\n\\newcommand{\\vect}[1]{\\mathbf{#1}}\n\\newcommand{\\emphx}[1]{\\textbf{#1}}\n\\newtheorem{law}{Закон}\n').map((x) => Object.assign(x, { file: '/p/cls/my.cls' }));
  const all = { cmds: new Map(macros.filter((x) => x.kind === 'cmd').map((x) => [x.name, x])), envs: new Map(macros.filter((x) => x.kind === 'env').map((x) => [x.name, x])) };
  const M = { register() {}, _allMacros: async () => all, _getSourceFiles: async () => ['/p/cls/my.cls'], _invalidate() {}, _version: () => 1 };
  e = env('', [[0, 0, 0, 0]], {}, { './macros': M });
  try {
    require(path.join(EXT, 'macroGallery.js')).register(e.ctx);
    await e.h.handlers['tssworkflow.macroGallery']();
    eq(e.st.panels, 1, 'the panel is created');
    e.send({ type: 'ready' });
    await sleep(80);
    const msg = e.st.posted.find((m) => m.type === 'items');
    ok(msg && msg.items.length === 3, 'the page receives the cards: ' + JSON.stringify(e.st.posted.map((m) => m.type)));
    const vect = msg.items.find((i) => i.name === 'vect');
    ok(vect && vect.examples[0].call === '\\vect{x}' && vect.doc === 'напруженість' && vect.mj === 'nofile', 'a card: call, comment above the definition, no macros file yet');
    ok(msg.macros['\\vect'] === '\\mathbf{#1}', 'the KaTeX macros of the project go with the cards');
    ok(!('file' in vect), 'the path of the file is not given to the page (only the name to show)');
    e.send({ type: 'goto', i: vect.i, file: '/etc/passwd' });
    await sleep(20);
    eq(e.vs.shown, [{ file: '/p/cls/my.cls', line: vect.line - 1 }], 'a click opens the file of the extension list, not the one the page names');
    e.send({ type: 'goto', i: 99 });
    e.send({ type: 'goto', i: 'x' });
    e.send({ type: 'copy', text: 'T', what: 'x' });
    await sleep(20);
    eq(e.vs.shown.length, 1, 'a wrong index opens nothing');
    eq(e.vs.env.clipboard.written, ['T'], 'the clipboard fallback of the page');
    ok(e.st.posted.some((m) => m.type === 'copied'), 'and the page is told');
  } finally { e.done(); }

  /* ------------------------------ formulas of the project ------------------------------ */
  const files = [{ path: 'a/a.tex', abs: '/p/a/a.tex', text: 'Див. \\eqref{e:one}.\n\\begin{equation}\\label{e:one} a=b \\end{equation}\n\\begin{equation}\\label{e:two} c=d \\end{equation}\n' }];
  const FL = { projectFiles: async () => files, chapterOrder: () => [], byChapter: () => () => 0 };
  e = env('', [[0, 0, 0, 0]], {}, { './filesAndLabels': FL, './tableEditor': TE, './projectInfo': { auxInfo: (uri, name) => (name === 'e:one' ? { num: '1.1' } : null) } });
  try {
    require(path.join(EXT, 'formulaOverview.js')).register(e.ctx);
    await e.h.handlers['tssworkflow.formulaOverview']();
    e.send({ type: 'ready' });
    await sleep(80);
    const msg = e.st.posted.find((m) => m.type === 'data');
    ok(msg && msg.entries.length === 2 && msg.files[0] === 'a/a.tex', 'the page receives the formulas');
    eq(msg.entries.map((x) => x.unused), [false, true], 'the formula nobody refers to is marked');
    eq(msg.entries[0].num, '1.1', 'the number comes from the aux file');
    ok(msg.macros['\\vect'], 'with the macros of the project');
    ok(!JSON.stringify(msg).includes('/p/a/a.tex'), 'no absolute path goes to the page');
    e.send({ type: 'goto', f: 0, line: 3, endLine: 3, file: '/etc/passwd' });
    e.send({ type: 'goto', f: 5, line: 3 });
    e.send({ type: 'goto', f: 0, line: -1 });
    await sleep(20);
    eq(e.vs.shown, [{ file: '/p/a/a.tex', line: 2 }], 'a click goes to the file by its number in the list of the extension; wrong numbers do nothing');
  } finally { e.done(); }

  console.log('formulaTools (stub): ' + n + ' checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
