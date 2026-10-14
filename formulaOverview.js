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
const { cancelTimer, debounce, isTex, panelScope } = require('./util');

let panel = null;
let ready = false;
let files = []; // [{ abs }] in the order of the page; a click on the page names a file by its number here
let seq = 0;

function body() {
  return '<div id="top"><h1>Формули проєкту</h1><span id="stat"></span><button id="refresh" title="Перечитати файли проєкту">Оновити</button></div>' +
    '<div id="bar"><input id="q" type="search" placeholder="Пошук: мітка, номер 2.3, фрагмент коду, файл" autocomplete="off">' +
    '<label><input type="checkbox" id="fU"> не використовуються</label><label><input type="checkbox" id="fL"> без мітки</label>' +
    '<label><input type="checkbox" id="fN"> показати й формули без номера</label></div><div id="list"></div>';
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

async function update() {
  if (!panel || !ready) return;
  const mine = ++seq;
  let r;
  try { r = await collect(); } catch (e) { return; }
  if (!panel || mine !== seq) return;
  if (!r) { panel.webview.postMessage({ type: 'data', files: [], entries: [], macros: {} }); return; }
  files = r.fl.map((f) => ({ abs: f.abs }));
  panel.webview.postMessage({ type: 'data', files: r.fl.map((f) => f.path), entries: r.entries, macros: r.macros });
}

function schedule(delay) { if (!panel) return; debounce('formulaOverview.update', delay, () => { update().catch(() => {}); }); }

async function goto(m) {
  const f = m && Number.isInteger(m.f) ? files[m.f] : null;
  if (!f || !Number.isInteger(m.line) || m.line < 1) return;
  const a = new vscode.Position(m.line - 1, 0);
  const b = new vscode.Position(Math.max(m.line - 1, Number.isInteger(m.endLine) ? m.endLine - 1 : m.line - 1), 0);
  await vscode.window.showTextDocument(vscode.Uri.file(f.abs), { selection: new vscode.Range(a, b), viewColumn: vscode.ViewColumn.One, preserveFocus: false });
}

function open(context) {
  if (panel) { panel.reveal(undefined, false); schedule(0); return; }
  const extUri = context.extensionUri;
  panel = vscode.window.createWebviewPanel('tssworkflow.formulaOverview', 'Формули проєкту', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')] });
  ready = false;
  panel.webview.html = K.shell(panel.webview, extUri, { body: body(), css: ['formulaOverview/webview.css'], js: ['formulaOverview/webview.js'] });
  const subs = panelScope(panel, () => { cancelTimer('formulaOverview.update'); panel = null; ready = false; seq++; files = []; });
  panel.webview.onDidReceiveMessage((m) => {
    if (!m) return;
    if (m.type === 'ready') { ready = true; schedule(0); } else if (m.type === 'refresh') schedule(0); else if (m.type === 'goto') goto(m).catch(() => {}); else if (m.type === 'copy') K.copyText(panel, m);
  }, null, subs);
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.formulaOverview', () => open(context)),
    // the files changed: the list is made again a moment after the save (a project of hundreds of formulas is read in a blink)
    vscode.workspace.onDidSaveTextDocument((d) => { if (panel && /\.(tex|tikz)$/i.test(path.basename(d.fileName))) schedule(900); })
  );
}

exports.register = register;
