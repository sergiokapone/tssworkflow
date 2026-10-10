'use strict';
/* selectionPreview.js: the panel "Preview selection" (tssworkflow.previewSelection, Ctrl+Alt+R).
 * It shows the selected part of a .tex file drawn (text, lists, theorem-like blocks, formulas with the macros of the
 * project, tables like in the table editor); with nothing selected the paragraph around the caret
 * (selectionPreview.emptySelection). The panel opens beside the editor WITHOUT taking the focus and follows the selection
 * and the text while you keep typing in the editor. The command again hides it. The converter is selectionPreviewPure.js. */
const vscode = require('vscode');
const path = require('path');
const P = require('./selectionPreviewPure');
const TE = require('./tableEditor');
const { cfg, isTex } = require('./util');

let panel = null;
let ready = false;
let timer = null;
let seq = 0;

const nonce = () => { let t = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < 32; i++) t += c[Math.floor(Math.random() * c.length)]; return t; };

function html(webview, extUri) {
  const n = nonce();
  const asset = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', ...p)).toString();
  const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + n + "' " + webview.cspSource + '; font-src ' + webview.cspSource + '; img-src ' + webview.cspSource + ' data:;';
  return '<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="' + asset('katex', 'katex.min.css') + '"><link rel="stylesheet" href="' + asset('selectionPreview', 'webview.css') + '"></head><body>' +
    '<div id="bar"><span id="what"></span><span id="where"></span></div><div id="notes"></div><div id="wrap"><div id="out"></div></div>' +
    '<script nonce="' + n + '" src="' + asset('katex', 'katex.min.js') + '"></script><script nonce="' + n + '" src="' + asset('selectionPreview', 'webview.js') + '"></script></body></html>';
}

// what is drawn: the selections, else the paragraph at the caret
function fragment(ed) {
  const doc = ed.document;
  const sels = ed.selections.filter((s) => !s.isEmpty).sort((a, b) => a.start.compareTo(b.start));
  if (sels.length) {
    return { text: sels.map((s) => doc.getText(s)).join('\n\n'), what: 'Виділене', from: sels[0].start.line + 1, to: sels[sels.length - 1].end.line + 1 };
  }
  if (cfg().get('selectionPreview.emptySelection', 'paragraph') !== 'paragraph') return { text: '', what: 'Нічого не виділено', from: 0, to: 0 };
  const at = ed.selection.active.line;
  const blank = (i) => !doc.lineAt(i).text.trim();
  if (blank(at)) return { text: '', what: 'Порожній рядок', from: 0, to: 0 };
  let a = at;
  let b = at;
  while (a > 0 && !blank(a - 1)) a--;
  while (b < doc.lineCount - 1 && !blank(b + 1)) b++;
  const lines = [];
  for (let i = a; i <= b; i++) lines.push(doc.lineAt(i).text);
  return { text: lines.join('\n'), what: 'Абзац біля курсора', from: a + 1, to: b + 1 };
}

// draws the fragment now with what is known of the colours and macros; searches the rest in the background
async function update() {
  if (!panel || !ready) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) return; // the panel itself or another kind of file: what is shown stays
  const doc = ed.document;
  const mine = ++seq;
  const fr = fragment(ed);
  const where = path.basename(doc.uri.fsPath) + (fr.from ? ':' + fr.from + (fr.to !== fr.from ? '–' + fr.to : '') : '');
  const send = () => {
    if (!panel || mine !== seq) return;
    const r = P.render(fr.text, { colors: TE.colorsNow() });
    panel.webview.postMessage({ type: 'render', html: r.html, notes: r.notes, what: fr.what, where, macros: TE.macrosNow(doc) });
  };
  send();
  if (TE.colorsFresh() && TE.macrosFresh(doc)) return;
  try { await Promise.all([TE.projectColors(), TE.katexMacros(doc)]); } catch (e) { return; }
  send(); // the second picture: with the colours and macros of the project
}

function schedule(delay) {
  if (!panel) return;
  clearTimeout(timer);
  timer = setTimeout(() => { update().catch(() => {}); }, delay);
}

function open(context) {
  if (panel) {
    if (panel.visible) { panel.dispose(); return; } // the command again hides the panel
    panel.reveal(vscode.ViewColumn.Beside, true);
    schedule(0);
    return;
  }
  // preserveFocus: the caret stays in the editor, the panel only appears
  panel = vscode.window.createWebviewPanel('tssworkflow.selectionPreview', 'Перегляд виділеного', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
  ready = false;
  panel.webview.html = html(panel.webview, context.extensionUri);
  panel.webview.onDidReceiveMessage((m) => { if (m && m.type === 'ready') { ready = true; schedule(0); } }, null, context.subscriptions);
  panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) schedule(0); }, null, context.subscriptions);
  panel.onDidDispose(() => { clearTimeout(timer); panel = null; ready = false; seq++; }, null, context.subscriptions);
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.previewSelection', () => open(context)),
    // the panel follows the selection and the text of the active .tex editor (a moment after the last change)
    vscode.window.onDidChangeTextEditorSelection((e) => { if (panel && isTex(e.textEditor.document)) schedule(180); }),
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (panel && ed && isTex(ed.document)) schedule(100); }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (panel && ed && e.document === ed.document && isTex(e.document)) schedule(350);
    })
  );
}

exports.register = register;
