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
const M = require('./macros');

let panel = null;
let ready = false;
let items = [];
let timer = null;
let seq = 0;

const SRC_RE = /\.(cls|sty|ltx)$/i;

function body() {
  return '<div id="top"><h1>Галерея макросів</h1><span id="stat"></span><button id="refresh" title="Перечитати .cls/.sty і файл макросів">Оновити</button></div>' +
    '<div id="bar"><input id="q" type="search" placeholder="Пошук за назвою, коментарем, означенням" autocomplete="off">' +
    '<label><input type="checkbox" id="fK"> не відтворюється в KaTeX</label>' +
    '<label><input type="checkbox" id="fM"> немає або інше у mathjax-macros.tex</label>' +
    '<select id="fT"><option value="">усе</option><option value="cmd">команди</option><option value="env">середовища</option></select></div>' +
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

async function update() {
  if (!panel || !ready) return;
  const mine = ++seq;
  let r;
  try { r = await collect(); } catch (e) { return; }
  if (!panel || mine !== seq) return;
  items = r.list;
  panel.webview.postMessage({ type: 'items', items: r.list.map((it) => ({ i: it.i, kind: it.kind, name: it.name, sig: it.sig, doc: it.doc, src: it.src, fileName: it.fileName, line: it.line, op: it.op, alias: it.alias, theorem: it.theorem, examples: it.examples, mj: it.mj, mjNote: it.mjNote })), macros: r.katex, mjFile: r.mjFile });
}

function schedule(delay) { if (!panel) return; clearTimeout(timer); timer = setTimeout(() => { update().catch(() => {}); }, delay); }

async function goto(m) {
  const it = m && Number.isInteger(m.i) ? items[m.i] : null; // the file comes from the list the extension made, not from the page
  if (!it) return;
  const pos = new vscode.Position(Math.max(0, it.line - 1), 0);
  await vscode.window.showTextDocument(vscode.Uri.file(it.file), { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One, preserveFocus: false });
}

function open(context) {
  if (panel) { panel.reveal(undefined, false); schedule(0); return; }
  const extUri = context.extensionUri;
  panel = vscode.window.createWebviewPanel('tssworkflow.macroGallery', 'Галерея макросів', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')] });
  ready = false;
  panel.webview.html = K.shell(panel.webview, extUri, { body: body(), css: ['macroGallery/webview.css'], js: ['macroGallery/webview.js'] });
  panel.webview.onDidReceiveMessage((m) => {
    if (!m) return;
    if (m.type === 'ready') { ready = true; schedule(0); } else if (m.type === 'refresh') { M._invalidate(); schedule(0); } else if (m.type === 'goto') goto(m).catch(() => {}); else if (m.type === 'copy') K.copyText(panel, m);
  }, null, context.subscriptions);
  panel.onDidDispose(() => { clearTimeout(timer); panel = null; ready = false; seq++; items = []; }, null, context.subscriptions);
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.macroGallery', () => open(context)),
    // the class or a package changed: the cards are made again a moment after the save
    vscode.workspace.onDidSaveTextDocument((d) => { if (panel && (SRC_RE.test(d.fileName) || /mathjax-macros|newcommand/i.test(path.basename(d.fileName)))) schedule(600); })
  );
}

exports.register = register;
exports._t = { collect };
