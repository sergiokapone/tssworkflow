'use strict';
/* selectionPreview.js: the panel "Preview selection" (tssworkflow.previewSelection, Ctrl+Alt+R).
 * It shows the selected part of a .tex file drawn (text, lists, theorem-like blocks, formulas with the macros of the
 * project, tables like in the table editor); with nothing selected the paragraph around the caret
 * (selectionPreview.emptySelection). \includegraphics shows the picture itself (png, jpg, gif, webp, svg) when the file is found. The panel opens beside the editor WITHOUT taking the focus and follows the selection
 * and the text while you keep typing in the editor. The command again hides it. The converter is selectionPreviewPure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./selectionPreviewPure');
const TE = require('./tableEditor');
const { cfg, isTex } = require('./util');

let panel = null;
let ready = false;
let extUri = null;
let roots = []; // folders (besides media/) the page may read pictures from
let timer = null;
let seq = 0;
let last = null; // { doc, column } of the last .tex editor: where a file opened from the panel goes

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

/* ------------------------------ pictures ------------------------------ */
const RASTER = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
const NOT_SHOWN = ['.pdf', '.eps', '.ps'];
const inside = (dir, root) => { const r = path.relative(root, dir); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };

// \graphicspath{{a/}{b/}} of the document and of the main file
function graphicsPaths(doc) {
  const out = [];
  const texts = [doc.getText()];
  try {
    const ws = vscode.workspace;
    const folder = (ws.getWorkspaceFolder && ws.getWorkspaceFolder(doc.uri)) || (ws.workspaceFolders || [])[0];
    if (folder) texts.push(fs.readFileSync(path.resolve(folder.uri.fsPath, String(cfg().get('mainFile', 'main.tex') || 'main.tex')), 'utf8'));
  } catch (e) { /* no main file */ }
  for (const t of texts) {
    const m = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})+)\s*\}/.exec(t.replace(/(^|[^\\])%.*$/gm, '$1'));
    if (m) for (const g of m[1].match(/\{([^{}]*)\}/g) || []) for (const x of expandCurrFile(g.slice(1, -1), doc)) if (!out.includes(x)) out.push(x);
  }
  return out;
}

// \graphicspath{{\currfilebase/Pictures}}: the macro is the base name of the file (without the extension), as in the project class;
// when the folder of the file has another name (a part of the chapter), the name of the folder is tried too
function expandCurrFile(g, doc) {
  if (!/\\currfilebase/.test(g)) return [g];
  const file = doc.uri.fsPath;
  const bases = [path.basename(file, path.extname(file)), path.basename(path.dirname(file))];
  const out = [];
  for (const b of bases) { const x = g.replace(/\\currfilebase\s?/g, () => b); if (b && !out.includes(x)) out.push(x); }
  return out;
}

// the file of \includegraphics{name}: { file } | { skip: 'pdf' } | { skip: 'missing' }
function findPicture(name, doc, gpaths) {
  if (/[\\{}$]/.test(name)) return { skip: 'missing' }; // the name is built by a macro: only the PDF knows it
  const bases = [];
  const add = (d) => { if (d && !bases.includes(d)) bases.push(d); };
  add(path.dirname(doc.uri.fsPath));
  try {
    const ws = vscode.workspace;
    const folder = (ws.getWorkspaceFolder && ws.getWorkspaceFolder(doc.uri)) || (ws.workspaceFolders || [])[0];
    if (folder) { add(path.dirname(path.resolve(folder.uri.fsPath, String(cfg().get('mainFile', 'main.tex') || 'main.tex')))); add(folder.uri.fsPath); }
  } catch (e) { /* none */ }
  const dirs = [];
  for (const b of bases) { dirs.push(b); for (const g of gpaths) dirs.push(path.resolve(b, g)); }
  const ext = path.extname(name).toLowerCase();
  const names = RASTER.includes(ext) || NOT_SHOWN.includes(ext) ? [name] : RASTER.map((e) => name + e).concat(NOT_SHOWN.map((e) => name + e));
  let pdf = false;
  for (const d of dirs) {
    for (const n of names) {
      const f = path.resolve(d, n);
      if (!isFile(f)) continue;
      if (RASTER.includes(path.extname(f).toLowerCase())) return { file: f };
      pdf = true;
    }
  }
  return { skip: pdf ? 'pdf' : 'missing' };
}

// the page may read pictures only from the folders the panel was given: add the folder of a picture outside of them
function allowFolder(dir) {
  if (!panel || roots.some((r) => inside(dir, r))) return;
  roots.push(dir);
  panel.webview.options = Object.assign({}, panel.webview.options, { localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')].concat(roots.map((r) => vscode.Uri.file(r))) });
}

// the resolver for P.render: what \includegraphics{name} shows
function pictureResolver(doc) {
  let gpaths = null;
  return (name) => {
    if (!panel) return null;
    if (!gpaths) gpaths = graphicsPaths(doc);
    const r = findPicture(name, doc, gpaths);
    if (!r.file) return { skip: r.skip };
    allowFolder(path.dirname(r.file));
    let t = 0;
    try { t = Math.floor(fs.statSync(r.file).mtimeMs); } catch (e) { /* none */ }
    // ?t= : a picture exported again is not taken from the cache of the page
    return { src: panel.webview.asWebviewUri(vscode.Uri.file(r.file)).toString() + '?t=' + t };
  };
}

/* ------------------------------ tikz ------------------------------ */
// the file of \localinput{name} / \input{name} in a frame of the panel; only inside the project or next to the open file
function resolveTikz(name, doc) {
  const f0 = String(name || '').trim();
  if (!f0 || /[\\{}$\0]/.test(f0)) return null;
  const dir = path.dirname(doc.uri.fsPath);
  const bases = [];
  const add = (d) => { if (d && !bases.includes(d)) bases.push(d); };
  let sub = 'tikz';
  try { sub = require('./filesAndLabels').legacySub('\\localinput', 'tikz') || 'tikz'; } catch (e) { /* the default */ }
  add(path.join(dir, sub));
  add(dir);
  const allowed = [dir];
  try {
    const ws = vscode.workspace;
    const folder = (ws.getWorkspaceFolder && ws.getWorkspaceFolder(doc.uri)) || (ws.workspaceFolders || [])[0];
    if (folder) {
      const mainDir = path.dirname(path.resolve(folder.uri.fsPath, String(cfg().get('mainFile', 'main.tex') || 'main.tex')));
      add(mainDir); add(folder.uri.fsPath); allowed.push(folder.uri.fsPath);
    }
  } catch (e) { /* none */ }
  for (const r of roots) allowed.push(r);
  const names = path.extname(f0) ? [f0] : [f0, f0 + '.tikz', f0 + '.tex'];
  for (const b of bases) {
    for (const n of names) {
      const f = path.resolve(b, n);
      if (isFile(f) && allowed.some((r) => inside(f, r))) return f;
    }
  }
  return null;
}

async function openTikz(m) {
  const doc = last && last.doc;
  if (!doc || !m || typeof m.name !== 'string') return;
  const f = resolveTikz(m.name, doc);
  if (!f) { vscode.window.showWarningMessage('Файл не знайдено: ' + String(m.name).slice(0, 200)); return; }
  // into the column of the .tex editor (the panel stands beside it), as a click on the name in the editor does
  await vscode.window.showTextDocument(vscode.Uri.file(f), { viewColumn: (last && last.column) || vscode.ViewColumn.One, preserveFocus: false });
}

// is the start of the fragment inside \begin{tikzpicture} ... \end{tikzpicture}? -> the name of the environment, else ''
// (a .tikz file is the code of one picture). The code of a picture is not drawn: it is a frame.
function pictureAround(doc, startLine) {
  if (/\.tikz$/i.test(doc.uri.fsPath || '')) return 'tikzpicture';
  let before = '';
  try { before = doc.getText(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(startLine, 0))); } catch (e) { return ''; }
  before = P.stripComments(before);
  const stack = [];
  const re = /\\(begin|end)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(before))) {
    if (!P.PICTURE_ENVS.has(m[2])) continue;
    if (m[1] === 'begin') stack.push(m[2]);
    else { const k = stack.lastIndexOf(m[2]); if (k >= 0) stack.length = k; }
  }
  return stack.length ? stack[stack.length - 1] : '';
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
  last = { doc, column: ed.viewColumn };
  const fr = fragment(ed);
  const pic = fr.text ? pictureAround(doc, Math.max(0, fr.from - 1)) : '';
  if (pic) fr.text = '\\begin{' + pic + '}\\end{' + pic + '}'; // the code of a picture: a frame, not the code
  const where = path.basename(doc.uri.fsPath) + (fr.from ? ':' + fr.from + (fr.to !== fr.from ? '–' + fr.to : '') : '');
  const send = () => {
    if (!panel || mine !== seq) return;
    const r = P.render(fr.text, { colors: TE.colorsNow(), image: pictureResolver(doc) });
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
  extUri = context.extensionUri;
  roots = ((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath));
  panel = vscode.window.createWebviewPanel('tssworkflow.selectionPreview', 'Перегляд виділеного', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')].concat(roots.map((r) => vscode.Uri.file(r))) });
  ready = false;
  panel.webview.html = html(panel.webview, context.extensionUri);
  panel.webview.onDidReceiveMessage((m) => { if (m && m.type === 'ready') { ready = true; schedule(0); } else if (m && m.type === 'open') openTikz(m).catch(() => {}); }, null, context.subscriptions);
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
exports._t = { resolveTikz, pictureAround };
