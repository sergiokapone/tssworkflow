'use strict';
/* Tests of the panel "Preview selection" (selectionPreview.js) against a stub of vscode: it opens without the focus,
 * follows the selection and the text, ignores other files, is switched off by the same command.
 * Run from the repository root: node tests/selectionPreviewPanel.test.js [extension] */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const MP = require(path.join(EXT, 'macrosPure.js'));
const { makeVscode, Selection } = require('./vscodeStub');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(text, selections, cfgValues, act, extra) {
  const dir = (extra && extra.dir) || '/p';
  const h = makeVscode(text, selections, {}, cfgValues || {});
  const { vs, ed, doc } = h;
  doc.languageId = 'latex';
  const rel = (extra && extra.file) || 'a.tex';
  doc.uri = { fsPath: dir + '/' + rel, toString: () => 'file://' + dir + '/' + rel, path: dir + '/' + rel };
  if (extra && extra.folders) vs.workspace.workspaceFolders = extra.folders.map((f) => ({ uri: { fsPath: f } }));
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
      webview: { html: '', cspSource: 'x', postMessage: (m) => { st.posted.push(m); }, asWebviewUri: (u) => ({ toString: () => 'https://webview.test' + String(u) }), onDidReceiveMessage: (f) => { onMsg = f; }, options: opts },
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

  // the macros file of the formula preview (mathjax-macros.tex) is read: its commands are known to KaTeX, and win over the class
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-prev-'));
  const macroFile = path.join(tmp, 'mathjax-macros.tex');
  fs.writeFileSync(macroFile, '% generated\n\\newcommand{\\grad}{\\nabla}\n\\newcommand{\\vect}[1]{\\boldsymbol{#1}}\n\\DeclareMathOperator{\\rot}{rot}\n');
  await scenario('Поле $\\grad f$ і $\\vect{j}$.', [[0, 0, 0, 30]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    const last = a.renders().pop();
    eq(last.macros['\\grad'], '\\nabla', 'a macro that only the file has');
    eq(last.macros['\\rot'], '\\operatorname{rot}', 'an operator of the file');
    eq(last.macros['\\vect'], '\\boldsymbol{#1}', 'the file wins over the class');
  }, { dir: tmp, folders: [tmp] });
  // the file changes: the cache notices it (no waiting for the minute), the picture is redrawn with the new macros
  await scenario('Поле $\\grad f$.', [[0, 0, 0, 12]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    ok(a.renders().pop().macros['\\grad'] === '\\nabla', 'first version');
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(macroFile, '\\newcommand{\\grad}{\\operatorname{grad}}\n');
    fs.utimesSync(macroFile, later, later);
    a.select(0, 0, 0, 10);
    await a.sleep(600);
    eq(a.renders().pop().macros['\\grad'], '\\operatorname{grad}', 'the new definition after the file was saved');
  }, { dir: tmp, folders: [tmp] });
  // the file named in the LaTeX Workshop setting is read too
  const lwFile = path.join(tmp, 'sub', 'lw.tex');
  fs.mkdirSync(path.dirname(lwFile), { recursive: true });
  fs.writeFileSync(lwFile, '\\newcommand{\\lwonly}{\\alpha}\n');
  await scenario('$\\lwonly$', [[0, 0, 0, 9]], { 'hover.preview.newcommand.newcommandFile': 'sub/lw.tex' }, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    eq(a.renders().pop().macros['\\lwonly'], '\\alpha', 'newcommandFile of latex-workshop');
  }, { dir: tmp, folders: [tmp] });
  // no file: the macros are only the class ones (as before)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-prev-empty-'));
  await scenario('$\\vect{j}$', [[0, 0, 0, 10]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    eq(Object.keys(a.renders().pop().macros), ['\\vect'], 'no macros file: only the macros of the class');
  }, { dir: empty, folders: [empty] });

  // pictures: found next to the file, in Pictures/ (\graphicspath), by name without the extension; PDF and missing ones stay frames
  const pics = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-prev-pics-'));
  fs.mkdirSync(path.join(pics, 'Pictures'));
  fs.writeFileSync(path.join(pics, 'Pictures', 'field.png'), 'png');
  fs.writeFileSync(path.join(pics, 'plot.svg'), '<svg/>');
  fs.writeFileSync(path.join(pics, 'vec.pdf'), 'pdf');
  fs.writeFileSync(path.join(pics, 'main.tex'), '\\graphicspath{{Pictures/}}\n');
  const PICS = '\\begin{figure}\n\\includegraphics[width=0.5\\linewidth]{field}\n\\caption{Поле}\n\\end{figure}\n\n\\includegraphics{plot.svg} \\includegraphics{vec} \\includegraphics{none.png} \\includegraphics{Pictures/\\name}';
  await scenario(PICS, [[0, 0, 5, 150]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    const h = a.renders().pop().html;
    ok(h.includes('<img src="https://webview.test' + path.join(pics, 'Pictures', 'field.png') + '?t='), 'a picture from \\graphicspath without the extension: ' + h);
    ok(h.includes('style="width:50%"'), 'width=0.5\\linewidth is kept: ' + h);
    ok(h.includes('<div class="cap">Поле</div>'), 'the caption stays');
    ok(h.includes('plot.svg?t='), 'svg is a picture');
    ok(h.includes('vec.pdf</') === false && h.includes('🖼 vec (PDF і EPS у перегляді не показуються)'), 'PDF is a frame with the reason: ' + h);
    ok(h.includes('🖼 none.png (файл не знайдено)'), 'a missing file is a frame with the reason');
    ok(h.includes('(файл не знайдено)') && h.split('(файл не знайдено)').length === 3, 'a name made by a macro is a frame too');
    eq(a.st.created[0].opts.localResourceRoots.length, 2, 'the page may read media/ and the folder of the project');
  }, { dir: pics, folders: [pics] });
  // a picture outside the folders of the project: its folder is added to what the page may read (once)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-prev-out-'));
  fs.writeFileSync(path.join(outside, 'far.jpg'), 'jpg');
  await scenario('\\includegraphics{' + outside.replace(/\\/g, '/') + '/far.jpg}', [[0, 0, 0, 80]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    ok(a.renders().pop().html.includes('far.jpg?t='), 'the absolute path is found');
    const roots = a.st.panel.webview.options.localResourceRoots.map((u) => u.fsPath || u.path);
    ok(roots.some((r) => r === outside), 'the folder of the picture is allowed: ' + roots.join(' | '));
    a.select(0, 0, 0, 70);
    await a.sleep(500);
    eq(a.st.panel.webview.options.localResourceRoots.length, roots.length, 'not added twice');
  }, { dir: empty, folders: [empty] });
  // 0.15.2: \graphicspath{{\currfilebase/Pictures}}: the macro is the name of the file (a chapter X/X.tex), else the name of its folder
  const book = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-prev-book-'));
  fs.mkdirSync(path.join(book, 'Chap', 'Pictures'), { recursive: true });
  fs.writeFileSync(path.join(book, 'Chap', 'Pictures', 'Discharges.jpg'), 'jpg');
  fs.writeFileSync(path.join(book, 'main.tex'), '\\documentclass{book}\n');
  const CB = '\\graphicspath{{\\currfilebase/Pictures}}\n\\includegraphics[width=0.8\\linewidth]{Discharges}';
  for (const file of ['Chap/Chap.tex', 'Chap/part.tex']) {
    await scenario(CB, [[0, 0, 1, 60]], {}, async (a) => {
      await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
      const h = a.renders().pop().html;
      ok(h.includes('<img src="https://webview.test' + path.join(book, 'Chap', 'Pictures', 'Discharges.jpg') + '?t='), file + ': \\currfilebase in \\graphicspath is expanded: ' + h);
      ok(!h.includes('(файл не знайдено)'), file + ': no "file not found" frame');
    }, { dir: book, folders: [book], file });
  }
  // 0.15.3: the code of tikz is a frame (a .tikz file, or the caret inside \begin{tikzpicture}); a click on the frame of \localinput opens the file
  const tk = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-prev-tikz-'));
  fs.mkdirSync(path.join(tk, 'Chap', 'tikz'), { recursive: true });
  fs.writeFileSync(path.join(tk, 'Chap', 'tikz', 'tribo.tikz'), '\\begin{tikzpicture}\\end{tikzpicture}');
  fs.writeFileSync(path.join(tk, 'secret.tikz'), 'x');
  fs.writeFileSync(path.join(tk, 'main.tex'), '\\documentclass{book}\n');
  const FIGT = '\\begin{figure}[h!]\\centering\n\\localinput{tribo.tikz}\n\\caption{Ряд}\n\\end{figure}';
  await scenario(FIGT, [[0, 0, 3, 12]], {}, async (a) => {
    const opened = [];
    a.vs.window.showTextDocument = async (uri, o) => { opened.push([uri.fsPath, o]); };
    a.vs.window.showWarningMessage = (m) => { opened.push(['warn', m]); };
    a.ed.viewColumn = 1;
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    const h = a.renders().pop().html;
    ok(h.includes('<a class="tikzf" href="#" data-open="tribo.tikz" data-via="localinput"'), 'the frame of the tikz file: ' + h);
    a.message({ type: 'open', name: 'tribo.tikz', via: 'localinput' }); await a.sleep(100);
    eq(opened.length, 1, 'a click opens one file');
    eq(opened[0][0], path.join(tk, 'Chap', 'tikz', 'tribo.tikz'), 'tikz/ next to the open file: ' + opened[0][0]);
    eq(opened[0][1].viewColumn, 1, 'in the column of the .tex editor');
    a.message({ type: 'open', name: '../../secret.tikz', via: 'input' }); await a.sleep(100);
    ok(opened[1] && opened[1][0] === 'warn' || opened[1][0] === path.join(tk, 'secret.tikz'), 'a path inside the project is allowed, a missing file warns');
    a.message({ type: 'open', name: '\\x{y}', via: 'input' }); await a.sleep(100);
    eq(opened[opened.length - 1][0], 'warn', 'a name with a macro is not opened');
    a.message({ type: 'open', name: '/etc/passwd', via: 'input' }); await a.sleep(100);
    eq(opened[opened.length - 1][0], 'warn', 'a file outside the project is not opened');
  }, { dir: path.join(tk, 'Chap'), folders: [tk], file: 'Chap.tex' });
  // the caret in the middle of a picture: a frame, not the code
  const INPIC = '\\begin{tikzpicture}[scale=1]\n\n\\draw (0,0) -- (1,1);\n\\node at (0,0) {$x$};\n\n\\end{tikzpicture}';
  await scenario(INPIC, [[2, 0, 3, 5]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    const h = a.renders().pop().html;
    ok(h.includes('tikzpicture: рисунок буде лише в PDF') && !h.includes('\\draw') && !h.includes('data-tex'), 'inside \\begin{tikzpicture}: a frame: ' + h);
  });
  await scenario('\\draw (0,0) -- (1,1);\n\\node {a};', [[0, 0, 1, 8]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    ok(a.renders().pop().html.includes('tikzpicture: рисунок буде лише в PDF'), 'a .tikz file is always a frame');
  }, { dir: tk, folders: [tk], file: 'figure.tikz' });
  await scenario('Текст\n\n\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\n\nПісля $x$', [[4, 0, 4, 10]], {}, async (a) => {
    await a.command(); a.message({ type: 'ready' }); await a.sleep(500);
    ok(a.renders().pop().html.includes('data-tex="x"'), 'after a closed picture the text is drawn as usual');
  });
  fs.rmSync(tk, { recursive: true, force: true });
  fs.rmSync(book, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('selectionPreviewPanel: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
