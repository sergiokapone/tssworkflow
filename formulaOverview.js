'use strict';
/* formulaOverview.js: the panel "Formulas of the project" (tssworkflow.formulaOverview). Every formula of every .tex/.tikz file of
 * the project drawn (KaTeX with the macros of the project), grouped by chapter in the order of main.tex, with the number from the
 * last compilation, the labels, a mark "not used" (nobody refers to the labels) and "no label", a search over labels, numbers,
 * code and file names. A click goes to the formula in the code; a formula is copied as MathML or TeX, the label as \eqref.
 * The data are in formulaOverviewPure.js, the page in media/formulaOverview/. */
const vscode = require('vscode');
const path = require('path');
const FL = require('./filesAndLabels');
const O = require('./formulaOverviewPure');
const P = require('./selectionPreviewPure');
const TE = require('./tableEditor');
const K = require('./webviewKit');
const { tr } = require('./i18n');
const { esc } = require('./webviewI18n');
const { isTex } = require('./util');

let files = []; // [{ abs }] in the order of the page; a click on the page names a file by its number here

function body() {
  return '<div id="top"><h1>' + esc(tr('Формули проєкту')) + '</h1><span id="stat"></span><button id="refresh" title="' + esc(tr('Перечитати файли проєкту')) + '">' + esc(tr('Оновити')) + '</button></div>' +
    '<div id="bar"><input id="q" type="search" placeholder="' + esc(tr('Пошук: мітка, номер 2.3, фрагмент коду, файл')) + '" autocomplete="off">' +
    '<label><input type="checkbox" id="fU"> ' + esc(tr('не використовуються')) + '</label><label><input type="checkbox" id="fL"> ' + esc(tr('без мітки')) + '</label>' +
    '<label><input type="checkbox" id="fN"> ' + esc(tr('показати й формули без номера')) + '</label></div><div id="list"></div>';
}

async function collect() {
  const root = (vscode.workspace.workspaceFolders || [])[0];
  if (!root) return null;
  const fl = (await FL.projectFiles(['.tex', '.tikz'], root.uri.fsPath)).sort(FL.byChapter(FL.chapterOrder()));
  let aux = null;
  try { aux = require('./projectInfo').auxInfo; } catch (e) { aux = null; }
  const used = new Set();
  for (const f of fl) O.refsOf(f.text).forEach((l) => used.add(l));
  const entries = O.buildEntries(fl, { aux: (abs, name) => { try { const a = aux && aux(vscode.Uri.file(abs), name); return a && a.num ? a.num : null; } catch (e) { return null; } }, used, render: (src) => P.render(src, {}).html });
  // the macros of the project: for the active .tex file, else for the first file of the project
  const ed = vscode.window.activeTextEditor;
  let doc = ed && isTex(ed.document) ? ed.document : null;
  if (!doc && fl.length) { try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fl[0].abs)); } catch (e) { doc = null; } }
  let macros = {};
  if (doc) { try { macros = await TE.katexMacros(doc); } catch (e) { macros = {}; } }
  return { fl, entries, macros };
}

async function goto(m) {
  const f = m && Number.isInteger(m.f) ? files[m.f] : null;
  if (!f || !Number.isInteger(m.line) || m.line < 1) return;
  const a = new vscode.Position(m.line - 1, 0);
  const b = new vscode.Position(Math.max(m.line - 1, Number.isInteger(m.endLine) ? m.endLine - 1 : m.line - 1), 0);
  await vscode.window.showTextDocument(vscode.Uri.file(f.abs), { selection: new vscode.Range(a, b), viewColumn: vscode.ViewColumn.One, preserveFocus: false });
}

// the frame of the panel (panel, ready, seq, deferred update, 'ready' / 'copy', panelScope) is webviewKit.createPanelController
const ctl = K.createPanelController({
  id: 'formulaOverview',
  get title() { return tr('Формули проєкту'); }, // read when the panel is opened
  html: (webview, extUri) => K.shell(webview, extUri, { body: body(), css: ['formulaOverview/webview.css'], js: ['formulaOverview/webview.js'] }),
  collect,
  render: (r, c) => {
    if (!r) { c.post({ type: 'data', files: [], entries: [], macros: {} }); return; }
    files = r.fl.map((f) => ({ abs: f.abs }));
    c.post({ type: 'data', files: r.fl.map((f) => f.path), entries: r.entries, macros: r.macros });
  },
  onRefresh: (c) => c.schedule(0),
  onMessage: (m) => { if (m.type === 'goto') goto(m).catch(() => {}); },
  onReset: () => { files = []; }
});

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.formulaOverview', () => ctl.open(context)),
    // the files changed: the list is made again a moment after the save (a project of hundreds of formulas is read in a blink)
    vscode.workspace.onDidSaveTextDocument((d) => { if (ctl.isOpen() && /\.(tex|tikz)$/i.test(path.basename(d.fileName))) ctl.schedule(900); })
  );
}

exports.register = register;
exports.isOpen = () => ctl.isOpen(); // for the state report (debugState.js)
exports._t = { body }; // the HTML of the page (tests/webviewPanels.vscode-stub.test.js)
