'use strict';
/* TSS Workflow 0.8.0: "Edit table visually".
 * A tab next to the editor shows tblr / longtblr / talltblr / tabular / tabularx / array / longtable as a grid:
 * type in cells, add / delete / move rows and columns, change column alignment, paste a range from Excel.
 * Every change replaces only the text of that one environment (one undo step), and the grid follows manual edits of the file.
 * The model is in tableEditorPure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const X = require('./tableEditorPure');
const M = require('./macros');
const MP = require('./macrosPure');
const { cfg, isTex } = require('./util');

const SEL = [{ language: 'latex' }, { language: 'tex' }];

let panel = null;
let target = null; // { uri, start, name }
let selfEdit = 0;
let refreshTimer = null;

const nonce = () => { let s = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < 24; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };

/* ------------------------------ colours of the project ------------------------------ */
let defsCache = { at: 0, defs: new Map() };
async function projectColors() {
  if (Date.now() - defsCache.at < 20000) return defsCache.defs;
  const texts = [];
  try {
    const files = await vscode.workspace.findFiles('**/*.{tex,cls,sty}', '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**,**/pdf-versions/**}', 3000);
    for (const u of files) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === u.fsPath);
      let t = null;
      try { t = open ? open.getText() : fs.readFileSync(u.fsPath, 'utf8'); } catch (e) { /* skip */ }
      if (t && /\\(?:definecolor|colorlet|providecolor)/.test(t)) texts.push(t);
    }
  } catch (e) { /* no workspace */ }
  defsCache = { at: Date.now(), defs: X.colorDefs(texts) };
  return defsCache.defs;
}

/* ------------------------------ document side ------------------------------ */
async function current() {
  if (!target) return null;
  let doc;
  try { doc = await vscode.workspace.openTextDocument(target.uri); } catch (e) { return { skip: 'файл недоступний' }; }
  const text = doc.getText();
  const envs = X.locateTables(text);
  if (!envs.length) return { skip: 'У файлі більше немає таблиць, які можна редагувати.', doc };
  const same = envs.filter((e) => e.name === target.name);
  const pool = same.length ? same : envs;
  const env = pool.sort((a, b) => Math.abs(a.start - target.start) - Math.abs(b.start - target.start))[0];
  const res = X.parseTable(text, env);
  if (res.skip) return { skip: res.skip, doc, env };
  target.start = env.start;
  target.name = env.name;
  return { model: res.model, doc, env, text };
}

function lineOf(doc, env) { return doc.positionAt(env.start).line + 1; }

// the macros of the project's classes / packages for KaTeX in the grid
async function katexMacros(doc) {
  try { return MP.toKatexMacros([...(await M._allMacros(doc)).cmds.values()]); } catch (e) { return {}; }
}

async function push(extra) {
  if (!panel) return;
  const cur = await current();
  if (!cur) return;
  if (cur.skip) { panel.webview.postMessage({ type: 'skip', reason: cur.skip }); return; }
  panel.title = 'Таблиця: ' + path.basename(cur.doc.uri.fsPath) + ':' + lineOf(cur.doc, cur.env);
  panel.webview.postMessage(Object.assign({ type: 'model', view: X.toView(cur.model, await projectColors()), macros: await katexMacros(cur.doc), where: path.basename(cur.doc.uri.fsPath) + ':' + lineOf(cur.doc, cur.env) }, extra || {}));
}

async function onOp(op) {
  const cur = await current();
  if (!cur || cur.skip) { push(); return; }
  const res = X.applyOp(cur.model, op);
  if (res.error) { panel.webview.postMessage({ type: 'error', message: res.error }); push(); return; }
  if (res.same) return;
  const align = cfg().get('tableEditor.alignAfterEdit', true) !== false;
  let out = X.serialize(res.model, { align });
  // a tblr table written in the "Format tblr" style stays in it
  if (align && res.model.isTblr && !res.model.spread) {
    try { out = X.restyleTblr(cur.text, cur.env, out, tblrOptions(cur.doc)); } catch (e) { /* keep the plain result */ }
  }
  if (out === cur.text.slice(cur.env.start, cur.env.end)) { push(); return; }
  const we = new vscode.WorkspaceEdit();
  we.replace(cur.doc.uri, new vscode.Range(cur.doc.positionAt(cur.env.start), cur.doc.positionAt(cur.env.end)), out);
  selfEdit++;
  try { await vscode.workspace.applyEdit(we); } finally { selfEdit--; }
  await push({ focus: op.focus || null });
}

// same options as the Format tblr command
function tblrOptions(doc) {
  const c = cfg();
  const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString());
  const o = (ed && ed.options) || {};
  const tabSize = typeof o.tabSize === 'number' ? o.tabSize : 2;
  return { maxWidth: Math.max(40, Number(c.get('tblr.maxWidth', 100)) || 100), sort: c.get('tblr.sortOptions', true) !== false, unit: o.insertSpaces === false ? '\t' : ' '.repeat(tabSize), tabSize };
}

// Ctrl+Z / Ctrl+Y in the grid: the change of the file is undone, not the typing in a cell
async function history(cmd) {
  const cur = await current();
  if (!cur || !cur.doc) return;
  const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === cur.doc.uri.toString());
  try {
    await vscode.window.showTextDocument(cur.doc, { viewColumn: ed ? ed.viewColumn : vscode.ViewColumn.One, preserveFocus: false });
    await vscode.commands.executeCommand(cmd);
  } finally {
    if (panel) panel.reveal(panel.viewColumn, false);
  }
}

// the changes go one after another: each one starts from the text the previous one left
let chain = Promise.resolve();
const enqueue = (fn) => { chain = chain.then(fn, fn); return chain; };

/* -------------------------------- the panel -------------------------------- */
function html(webview, extUri) {
  const n = nonce();
  const asset = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', ...p)).toString();
  const kx = (f) => asset('katex', f);
  const own = (f) => asset('tableEditor', f);
  const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + n + "' " + webview.cspSource + '; font-src ' + webview.cspSource + '; img-src ' + webview.cspSource + ' data:;';
  return '<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="' + kx('katex.min.css') + '"><link rel="stylesheet" href="' + own('webview.css') + '"></head><body>' +
    '<div id="bar"><span id="what"></span><span id="size"></span></div><div id="warn"></div><div id="info"></div><div id="toast"></div>' +
    '<div id="wrap" tabindex="0"><table id="t"></table></div><div id="hint">Enter/Tab/стрілки: рух · Shift+клік чи перетягування: виділення · Delete: очистити · Ctrl+C/X/V: копіювати, вирізати, вставити (в тому числі з Excel) · Ctrl+D: дублювати рядок · Ctrl+Enter: рядок нижче · Alt+стрілки: перемістити · Ctrl+Z: скасувати зміну у файлі</div>' +
    '<script nonce="' + n + '" src="' + kx('katex.min.js') + '"></script><script nonce="' + n + '" src="' + own('webview.js') + '"></script></body></html>';
}

function ensurePanel(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside, true); return panel; }
  panel = vscode.window.createWebviewPanel('tssworkflow.tableEditor', 'Таблиця', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
  panel.webview.html = html(panel.webview, context.extensionUri);
  panel.webview.onDidReceiveMessage((m) => {
    if (m.type === 'ready') enqueue(() => push());
    else if (m.type === 'op') enqueue(() => onOp(m.op)).catch((e) => panel && panel.webview.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) }));
    else if (m.type === 'undo' || m.type === 'redo') enqueue(() => history(m.type)).catch(() => {});
  }, null, context.subscriptions);
  panel.onDidDispose(() => { panel = null; target = null; }, null, context.subscriptions);
  return panel;
}

async function openTable(context, uri, start) {
  let doc;
  let env;
  if (uri) {
    doc = await vscode.workspace.openTextDocument(uri);
    env = X.locateTables(doc.getText()).find((e) => e.start === start);
  } else {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isTex(ed.document)) { vscode.window.showInformationMessage('Постав курсор усередину таблиці в .tex-файлі.'); return; }
    doc = ed.document;
    const text = doc.getText();
    env = X.tableAt(text, doc.offsetAt(ed.selection.active));
    if (!env) {
      const all = X.locateTables(text);
      if (!all.length) { vscode.window.showInformationMessage('У файлі немає таблиць tblr, longtblr, talltblr, tabular, tabularx, array, longtable.'); return; }
      if (all.length === 1) env = all[0];
      else {
        const items = all.map((e) => ({ label: '$(table) ' + e.name, description: 'рядок ' + (doc.positionAt(e.start).line + 1), detail: text.slice(e.bodyStart, e.bodyEnd).trim().split('\n').slice(0, 2).join(' ').slice(0, 90), e }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Яку таблицю редагувати?' });
        if (!pick) return;
        env = pick.e;
      }
    }
  }
  if (!env) { vscode.window.showWarningMessage('Таблицю не знайдено (файл змінився?).'); return; }
  target = { uri: doc.uri, start: env.start, name: env.name };
  ensurePanel(context);
  await push();
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.editTable', (uri, start) => openTable(context, uri instanceof vscode.Uri ? uri : null, start).catch((e) => vscode.window.showErrorMessage('Редактор таблиць: ' + (e && e.message ? e.message : e)))),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!panel || !target || selfEdit || e.document.uri.toString() !== target.uri.toString()) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => push(), 250);
    }),
    vscode.languages.registerCodeLensProvider(SEL, {
      provideCodeLenses(doc) {
        if (!cfg().get('tableEditor.codeLens', true)) return [];
        const out = [];
        for (const e of X.locateTables(doc.getText())) {
          const p = doc.positionAt(e.start);
          out.push(new vscode.CodeLens(new vscode.Range(p, p), { title: '$(table) Редагувати таблицю', command: 'tssworkflow.editTable', arguments: [doc.uri, e.start] }));
        }
        return out;
      }
    })
  );
}

exports.register = register;
