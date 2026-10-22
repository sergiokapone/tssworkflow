'use strict';
/* macroGallery.js: the panel "Macro gallery" (tssworkflow.macroGallery). Every command and environment of the project classes and
 * packages (.cls/.sty/preamble files, the same index as the hover) as a card: the signature, the comment above the definition,
 * the call with the placeholders x, y, z, the call drawn (KaTeX with the macros of the project, a text command by the text
 * converter of the panel "Preview selection"), the definition, and flags: not drawn by KaTeX, not in mathjax-macros.tex, differs
 * from what the generator would write, MathJax cannot say it. A click on the file name opens the definition.
 * The data are in macroGalleryPure.js, the page in media/macroGallery/. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const MP = require('./macrosPure');
const MJ = require('./mathjaxFile');
const G = require('./macroGalleryPure');
const P = require('./selectionPreviewPure');
const K = require('./webviewKit');
const { tr } = require('./i18n');
const { esc } = require('./webviewI18n');
const M = require('./macros');

let items = [];

const SRC_RE = /\.(cls|sty|ltx)$/i;

function body() {
  return '<div id="top"><h1>' + esc(tr('Галерея макросів')) + '</h1><span id="stat"></span><button id="refresh" title="' + esc(tr('Перечитати .cls/.sty і файл макросів')) + '">' + esc(tr('Оновити')) + '</button></div>' +
    '<div id="bar"><input id="q" type="search" placeholder="' + esc(tr('Пошук за назвою, коментарем, означенням')) + '" autocomplete="off">' +
    '<label><input type="checkbox" id="fK"> ' + esc(tr('не відтворюється в KaTeX')) + '</label>' +
    '<label><input type="checkbox" id="fM"> ' + esc(tr('немає або інше у mathjax-macros.tex')) + '</label>' +
    '<select id="fT"><option value="">' + esc(tr('усе')) + '</option><option value="cmd">' + esc(tr('команди')) + '</option><option value="env">' + esc(tr('середовища')) + '</option></select></div>' +
    '<div id="list"></div>';
}

function currentDoc() {
  const ed = vscode.window.activeTextEditor;
  return ed && ed.document && ed.document.uri.scheme === 'file' ? ed.document : null;
}

async function collect() {
  const doc = currentDoc();
  const all = await M._allMacros(doc);
  const files = await M._getSourceFiles();
  const cmds = [...all.cmds.values()];
  // the macros of the formula preview file: what its definitions say about the same commands (they win in the panels)
  let texts = [];
  try { texts = MJ.files(doc).map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }); } catch (e) { texts = []; }
  const mj = G.mathjaxInfo(texts, cmds);
  let katex = {};
  try { katex = Object.assign({}, MP.toKatexMacros(cmds), MP.toKatexOptMacros(cmds), MJ.macros(doc), MJ.optMacros(doc)); } catch (e) { katex = {}; }
  const textCmds = new Map(all.cmds);
  try { for (const [k, v] of MJ.textMacros(doc)) textCmds.set(k, v); } catch (e) { /* none */ }
  const render = (src) => P.render(src, { macros: textCmds }).html;
  const list = G.buildItems(all, files, mj, render);
  const root = (vscode.workspace.workspaceFolders || [])[0];
  const rel = (f) => (root ? path.relative(root.uri.fsPath, f).split(path.sep).join('/') : path.basename(f));
  list.forEach((it) => { it.fileName = rel(it.file); });
  return { list, katex, mjFile: texts.length > 0 };
}

async function goto(m) {
  const it = m && Number.isInteger(m.i) ? items[m.i] : null; // the file comes from the list the extension made, not from the page
  if (!it) return;
  const pos = new vscode.Position(Math.max(0, it.line - 1), 0);
  await vscode.window.showTextDocument(vscode.Uri.file(it.file), { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One, preserveFocus: false });
}

// the frame of the panel (panel, ready, seq, deferred update, 'ready' / 'copy', panelScope) is webviewKit.createPanelController
const ctl = K.createPanelController({
  id: 'macroGallery',
  get title() { return tr('Галерея макросів'); }, // read when the panel is opened
  html: (webview, extUri) => K.shell(webview, extUri, { body: body(), css: ['macroGallery/webview.css'], js: ['macroGallery/webview.js'] }),
  collect,
  render: (r, c) => {
    items = r.list;
    c.post({ type: 'items', items: r.list.map((it) => ({ i: it.i, kind: it.kind, name: it.name, sig: it.sig, doc: it.doc, src: it.src, fileName: it.fileName, line: it.line, op: it.op, alias: it.alias, theorem: it.theorem, examples: it.examples, mj: it.mj, mjNote: it.mjNote })), macros: r.katex, mjFile: r.mjFile });
  },
  onRefresh: (c) => { M._invalidate(); c.schedule(0); },
  onMessage: (m) => { if (m.type === 'goto') goto(m).catch(() => {}); },
  onReset: () => { items = []; }
});

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.macroGallery', () => ctl.open(context)),
    // the class or a package changed: the cards are made again a moment after the save
    vscode.workspace.onDidSaveTextDocument((d) => { if (ctl.isOpen() && (SRC_RE.test(d.fileName) || /mathjax-macros|newcommand/i.test(path.basename(d.fileName)))) ctl.schedule(600); })
  );
}

exports.register = register;
exports.isOpen = () => ctl.isOpen(); // for the state report (debugState.js)
exports._t = { collect, body }; // body: the HTML of the page (tests/webviewPanels.vscode-stub.test.js)
