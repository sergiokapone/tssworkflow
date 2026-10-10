'use strict';
/* Tests of the panel "Preview selection" (selectionPreview.js) against a stub of vscode: it opens without the focus,
 * follows the selection and the text, ignores other files, is switched off by the same command.
 * Run from the repository root: node tests/selectionPreviewPanel.test.js [extension] */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const MP = require(path.join(EXT, 'macrosPure.js'));
const { makeVscode, Selection } = require('./vscodeStub');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(text, selections, cfgValues, act) {
  const h = makeVscode(text, selections, {}, cfgValues || {});
  const { vs, ed, doc } = h;
  doc.languageId = 'latex';
  doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  const st = { created: [], posted: [], revealed: [], disposed: 0, selectionChangedBy: 0, macrosDone: false };
  const listeners = { selection: [], editor: [], text: [] };
  vs.ViewColumn = { One: 1, Two: 2, Beside: -2 };
  vs.Uri = class Uri {
    constructor(p) { this.path = p; this.fsPath = p; }
    toString() { return this.path; }
    static file(f) { return new Uri(f); }
    static joinPath(u, ...p) { return new Uri([u.path || ''].concat(p).join('/')); }
  };
  let visible = true;
  let onMsg = null;
  let onView = null;
  let onDispose = null;
  vs.window.createWebviewPanel = (type, title, show, opts) => {
    st.created.push({ type, title, show, opts });
    const panel = {
      get visible() { return visible; },
      reveal: (col, preserve) => { st.revealed.push([col, preserve]); },
      dispose: () => { st.disposed++; if (onDispose) onDispose(); },
      webview: { html: '', cspSource: 'x', postMessage: (m) => { st.posted.push(m); }, asWebviewUri: (u) => ({ toString: () => String(u) }), onDidReceiveMessage: (f) => { onMsg = f; } },
      onDidChangeViewState: (f) => { onView = f; },
      onDidDispose: (f) => { onDispose = f; }
    };
    st.panel = panel;
    return panel;
  };
  vs.window.onDidChangeTextEditorSelection = (f) => { listeners.selection.push(f); return { dispose() {} }; };
  vs.window.onDidChangeActiveTextEditor = (f) => { listeners.editor.push(f); return { dispose() {} }; };
  vs.workspace.onDidChangeTextDocument = (f) => { listeners.text.push(f); return { dispose() {} }; };
  vs.workspace.onDidSaveTextDocument = () => ({ dispose() {} });
  vs.workspace.findFiles = async () => [];
  vs.workspace.textDocuments = [doc];
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  vs.window.createTextEditorDecorationType = () => ({});
  vs.ThemeColor = class {};
  vs.OverviewRulerLane = { Center: 2 };
  vs.TextEditorRevealType = {};
  vs.CodeLens = class {};
  vs.languages.registerCodeLensProvider = () => ({ dispose() {} });

  const macroEntries = MP.scanMacros('\\newcommand{\\vect}[1]{\\mathbf{#1}}').filter((e) => e.kind !== 'env');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vs;
    if (req === './macros') return { _allMacros: async () => { await sleep(100); st.macrosDone = true; return { cmds: new Map(macroEntries.map((e) => [e.name, e])), envs: new Map() }; } };
    return orig.call(this, req, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(EXT) && /\.js$/.test(key)) delete require.cache[key];
  try {
    const context = { subscriptions: [], extensionUri: new vs.Uri('/ext') };
    require(path.join(EXT, 'selectionPreview.js')).register(context);
    const api = {
      command: () => h.handlers['tssworkflow.previewSelection'](),
      message: (m) => onMsg(m),
      select: (l1, c1, l2, c2) => { ed.selections = [new Selection(l1, c1, l2, c2)]; listeners.selection.forEach((f) => f({ textEditor: ed })); },
      typed: () => listeners.text.forEach((f) => f({ document: doc })),
      activate: (e) => listeners.editor.forEach((f) => f(e)),
      setVisible: (v) => { visible = v; if (onView) onView({ webviewPanel: { visible: v } }); },
      renders: () => st.posted.filter((m) => m.type === 'render'),
      sleep, h, st, ed, doc, vs
    };
    await act(api);
  } finally { Module._load = orig; }
  return st;
}

(async () => {
  const TEXT = 'Звичайний \\textbf{жирний} текст і $x^2$.\nДругий рядок абзацу.\n\nІнший абзац з \\vect{j}.';

  // opening: beside, without taking the focus
  let st = await scenario(TEXT, [[0, 0, 0, 40]], {}, async (a) => {
    await a.command();
    eq(a.st.created.length, 1);
    eq(a.st.created[0].show, { viewColumn: -2, preserveFocus: true }, 'beside the editor, the focus stays where it was');
    ok(a.st.created[0].opts.retainContextWhenHidden && a.st.created[0].opts.enableScripts, 'options');
    eq(a.renders().length, 0, 'nothing is sent before the page is ready');
    a.message({ type: 'ready' });
    await a.sleep(60);
    eq(a.renders().length, 1, 'the first picture right after ready');
    const r = a.renders()[0];
    ok(r.html.includes('<b>жирний</b>') && r.html.includes('data-tex="x^2"'), r.html);
    eq(r.what, 'Виділене');
    eq(r.where, 'a.tex:1');
    eq(r.macros, {}, 'the macros of the project are not known yet');
    await a.sleep(300);
    const all = a.renders();
    eq(all.length, 2, 'then the second picture with the macros of the project');
    ok(Object.keys(all[1].macros).length > 0, 'macros arrived');
    eq(all[1].html, all[0].html);
  });
  eq(st.revealed, [], 'the panel is never revealed with the focus');

  // follows the selection (one picture after a burst), and the text
  await scenario(TEXT, [[0, 0, 0, 5]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(400);
    const before = a.renders().length;
    a.select(0, 0, 0, 3); a.select(0, 0, 0, 8); a.select(3, 0, 3, 20);
    await a.sleep(120);
    eq(a.renders().length, before, 'not yet: the selection may still be changing');
    await a.sleep(200);
    eq(a.renders().length, before + 1, 'one picture after a burst of selection changes');
    const r = a.renders().pop();
    ok(r.html.includes('Інший абзац'), r.html);
    eq(r.where, 'a.tex:4');
    ok(r.html.includes('data-tex') === false && r.html.includes('class="unk"'), 'the macro of the project in text is shown with its argument');
    // typing in the editor redraws
    a.doc.lines[3] = 'Змінений \\emph{абзац}.';
    a.ed.selections = [new Selection(3, 0, 3, a.doc.lines[3].length)];
    a.typed();
    await a.sleep(500);
    ok(a.renders().pop().html.includes('<em>абзац</em>'), 'redrawn after typing');
  });

  // nothing selected: the paragraph around the caret, or nothing
  await scenario(TEXT, [[1, 3, 1, 3]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(400);
    const r = a.renders()[0];
    eq(r.what, 'Абзац біля курсора');
    ok(r.html.includes('Звичайний') && r.html.includes('Другий рядок'), 'both lines of the paragraph: ' + r.html);
    ok(!r.html.includes('Інший абзац'), 'only that paragraph');
    eq(r.where, 'a.tex:1–2');
    a.select(2, 0, 2, 0);
    await a.sleep(300);
    const e = a.renders().pop();
    eq([e.what, e.html], ['Порожній рядок', ''], 'a blank line: nothing');
  });
  await scenario(TEXT, [[0, 3, 0, 3]], { 'selectionPreview.emptySelection': 'none' }, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(300);
    eq([a.renders()[0].what, a.renders()[0].html], ['Нічого не виділено', ''], 'emptySelection = none');
  });

  // the panel is not an editor of a .tex file: what is shown stays
  await scenario(TEXT, [[0, 0, 0, 5]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(400);
    const before = a.renders().length;
    a.vs.window.activeTextEditor = undefined;
    a.activate(undefined);
    a.select(0, 0, 0, 9);
    await a.sleep(400);
    eq(a.renders().length, before, 'no text editor is active (the panel itself is): what is shown stays');
    a.vs.window.activeTextEditor = a.ed;
    a.select(0, 0, 0, 9);
    await a.sleep(300);
    eq(a.renders().length, before + 1, 'back in the editor: redrawn');
    const other = { document: { languageId: 'plaintext', uri: { fsPath: '/p/x.txt' } } };
    a.vs.window.activeTextEditor = other;
    const mid = a.renders().length;
    a.activate(other);
    await a.sleep(300);
    eq(a.renders().length, mid, 'another kind of file: nothing is redrawn');
  });

  // the command again hides the panel, a hidden one is shown again (without the focus)
  st = await scenario(TEXT, [[0, 0, 0, 5]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(300);
    a.setVisible(false);
    await a.command();
    eq(a.st.created.length, 1, 'the hidden panel is reused');
    eq(a.st.revealed, [[-2, true]], 'revealed beside, preserveFocus = true');
    eq(a.st.disposed, 0);
    a.setVisible(true);
    await a.command();
    eq(a.st.disposed, 1, 'a visible panel is closed by the command');
    await a.command();
    eq(a.st.created.length, 2, 'and opened again afterwards');
    const before = a.renders().length;
    a.select(0, 0, 0, 3);
    await a.sleep(300);
    eq(a.renders().length, before, 'the new page is not ready yet: nothing is sent into it');
  });

  // the selection is not touched: the editor keeps its selection and the caret
  await scenario(TEXT, [[0, 2, 0, 12]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(400);
    eq([a.ed.selection.start.character, a.ed.selection.end.character], [2, 12], 'the selection of the editor is untouched');
    eq(a.h.vs.executed.length, 0, 'no commands that could move the focus were executed');
  });

  console.log('selectionPreviewPanel: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
