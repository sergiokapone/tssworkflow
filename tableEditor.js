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
const MJ = require('./mathjaxFile');
const { cfg, isTex } = require('./util');

const SEL = [{ language: 'latex' }, { language: 'tex' }];

let panel = null;
let deco = null; // decoration types of the table / row shown in the file
let followTimer = null;
let followRow = null;
let target = null; // { uri, start, name }
let selfEdit = 0;
let refreshTimer = null;
let log = () => {};
let openedAt = 0; // when the tab was created: the time to the first picture is logged on 'ready'
const ms = (t0) => Date.now() - t0;

const nonce = () => { let s = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < 24; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };

/* ------------------------------ colours of the project ------------------------------ */
// The definitions are looked for in all files of the project: that takes long on a big project, so the result is kept
// until a file with definitions is saved, the scan runs once at a time and reads the files in parallel.
const DEF_RE = /\\(?:definecolor|colorlet|providecolor)/;
const DEFS_TTL = 5 * 60 * 1000;
let defsCache = { at: 0, defs: new Map(), files: new Set() };
let defsPending = null;
const colorsFresh = () => Date.now() - defsCache.at < DEFS_TTL;

function projectColors() {
  if (colorsFresh()) return Promise.resolve(defsCache.defs);
  if (defsPending) return defsPending;
  defsPending = (async () => {
    const t0 = Date.now();
    const results = [];
    const files = new Set();
    try {
      const found = await vscode.workspace.findFiles('**/*.{tex,cls,sty}', '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**,**/pdf-versions/**}', 3000);
      const t1 = Date.now();
      const read = async (u, k) => {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === u.fsPath);
        let t = null;
        try { t = open ? open.getText() : await fs.promises.readFile(u.fsPath, 'utf8'); } catch (e) { /* skip */ }
        if (t && DEF_RE.test(t)) { results[k] = t; files.add(u.fsPath); }
      };
      for (let k = 0; k < found.length; k += 32) await Promise.all(found.slice(k, k + 32).map((u, n) => read(u, k + n)));
      log('[таблиця] кольори проєкту: ' + found.length + ' файлів; пошук файлів ' + (t1 - t0) + ' мс, читання ' + ms(t1) + ' мс; з визначеннями ' + files.size);
    } catch (e) { /* no workspace */ }
    defsCache = { at: Date.now(), defs: X.colorDefs(results.filter(Boolean)), files };
    return defsCache.defs;
  })().finally(() => { defsPending = null; });
  return defsPending;
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

// the macros of the project's classes / packages for KaTeX in the grid (kept for a minute: the index itself is cached too)
let macrosCache = { key: '', at: 0, stamp: '', macros: {} };
// fresh for a minute, and only while the macros file (mathjax-macros.tex) is the same
const macrosFresh = (doc) => macrosCache.key === doc.uri.toString() && Date.now() - macrosCache.at < 60000 && macrosCache.stamp === MJ.stamp(doc);
async function katexMacros(doc) {
  if (macrosFresh(doc)) return macrosCache.macros;
  const t0 = Date.now();
  let macros = {};
  try { macros = MP.toKatexMacros([...(await M._allMacros(doc)).cmds.values()]); } catch (e) { /* none */ }
  // what the macros file of the formula preview defines is added (and wins): the same commands as in the LaTeX Workshop hover
  let fromFile = {};
  try { fromFile = MJ.macros(doc); } catch (e) { /* none */ }
  macros = Object.assign({}, macros, fromFile);
  macrosCache = { key: doc.uri.toString(), at: Date.now(), stamp: MJ.stamp(doc), macros };
  log('[таблиця] макроси проєкту: ' + Object.keys(macros).length + ' (з файла макросів ' + Object.keys(fromFile).length + ') за ' + ms(t0) + ' мс');
  return macros;
}

// The grid is shown at once with what is already known; when the colours and macros of the project still have to be
// found (first time, or after a file with definitions was saved), they are searched for in the background and sent after.
async function push(extra) {
  if (!panel) return;
  const t0 = Date.now();
  const cur = await current();
  if (!cur) return;
  if (cur.skip) { panel.webview.postMessage({ type: 'skip', reason: cur.skip }); return; }
  const where = path.basename(cur.doc.uri.fsPath) + ':' + lineOf(cur.doc, cur.env);
  panel.title = 'Таблиця: ' + where;
  const send = (colors, macros) => panel && panel.webview.postMessage(Object.assign({ type: 'model', view: X.toView(cur.model, colors), macros, where }, extra || {}));
  const known = macrosCache.key === cur.doc.uri.toString() ? macrosCache.macros : {};
  if (colorsFresh() && macrosFresh(cur.doc)) { send(defsCache.defs, macrosCache.macros); return; }
  send(defsCache.defs, known);
  log('[таблиця] сітка надіслана за ' + ms(t0) + ' мс; кольори й макроси проєкту ще шукаються');
  const t1 = Date.now();
  await Promise.all([projectColors(), katexMacros(cur.doc)]);
  log('[таблиця] кольори й макроси готові за ' + ms(t1) + ' мс');
  if (panel && colorsFresh()) await push(); // the second picture, now with colours and macros (nothing is left to wait for)
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

/* ------------------- the file follows the grid (tableEditor.followEditor) ------------------- */
const followMode = () => String(cfg().get('tableEditor.followEditor', 'highlight'));

function decos() {
  if (!deco) {
    deco = {
      table: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground') }),
      row: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center })
    };
  }
  return deco;
}

function clearFollow() {
  if (!deco) return;
  for (const ed of vscode.window.visibleTextEditors) { ed.setDecorations(deco.table, []); ed.setDecorations(deco.row, []); }
}

// shows the table (row: its row) in the file without taking the focus from the grid
async function follow(row) {
  const mode = followMode();
  if (!panel || !target) return;
  if (mode === 'off') { clearFollow(); return; }
  const cur = await current();
  if (!cur || cur.skip || !cur.doc) return;
  let ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === cur.doc.uri.toString());
  if (!ed) ed = await vscode.window.showTextDocument(cur.doc, { viewColumn: panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One, preserveFocus: true, preview: false });
  const at = (o) => cur.doc.positionAt(o);
  const tableRange = new vscode.Range(at(cur.env.start), at(cur.env.end));
  let rowRange = null;
  if (Number.isInteger(row)) {
    const spans = X.rowSpans(cur.model, cur.env.bodyStart + cur.model.head.length);
    const sp = spans[Math.max(0, Math.min(row, spans.length - 1))];
    if (sp) {
      let e = sp.end;
      while (e > sp.content && /\s/.test(cur.text[e - 1])) e--;
      rowRange = new vscode.Range(at(sp.content), at(e));
    }
  }
  ed.revealRange(rowRange || new vscode.Range(tableRange.start, tableRange.start), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  clearFollow();
  if (mode === 'highlight' || mode === 'cursor') {
    const d = decos();
    ed.setDecorations(d.table, [tableRange]);
    ed.setDecorations(d.row, rowRange ? [rowRange] : []);
  }
  if (mode === 'cursor') { const p = (rowRange || tableRange).start; ed.selection = new vscode.Selection(p, p); }
}

// bursts of messages (arrow keys) become one reveal, after the pending changes of the file
function scheduleFollow(row) {
  followRow = row;
  clearTimeout(followTimer);
  followTimer = setTimeout(() => { enqueue(() => follow(followRow)).catch(() => {}); }, 60);
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
    if (m.type === 'ready') { if (openedAt) { log('[таблиця] сторінка вкладки завантажилась за ' + ms(openedAt) + ' мс'); openedAt = 0; } enqueue(() => push()); }
    else if (m.type === 'op') enqueue(() => onOp(m.op)).catch((e) => panel && panel.webview.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) }));
    else if (m.type === 'follow') scheduleFollow(Number.isInteger(m.r) ? m.r : null);
    else if (m.type === 'undo' || m.type === 'redo') enqueue(() => history(m.type)).catch(() => {});
  }, null, context.subscriptions);
  panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible && e.webviewPanel.active) scheduleFollow(followRow); }, null, context.subscriptions);
  panel.onDidDispose(() => { clearTimeout(followTimer); clearFollow(); panel = null; target = null; followRow = null; }, null, context.subscriptions);
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
  const fresh = !panel;
  const t0 = Date.now();
  ensurePanel(context);
  // a new panel asks for the table itself ('ready') when its page has loaded: a message sent now would be lost
  if (fresh) openedAt = t0; else await push();
  scheduleFollow(null);
}

let warmTimer = null;
// a file with tables was shown: look for the colours and macros of the project now, before the tab is opened
function warm(doc) {
  if (!cfg().get('tableEditor.prefetch', true) || (colorsFresh() && macrosFresh(doc)) || warmTimer) return;
  warmTimer = setTimeout(async () => {
    try { await Promise.all([projectColors(), katexMacros(doc)]); } catch (e) { /* later, on demand */ } finally { warmTimer = null; }
  }, 1500);
}

function register(context, api) {
  if (api && api.log) log = api.log;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (!/\.(?:tex|cls|sty)$/i.test(d.uri.fsPath)) return;
      if (defsCache.files.has(d.uri.fsPath) || DEF_RE.test(d.getText())) defsCache.at = 0;
    }),
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
        if (out.length) warm(doc);
        return out;
      }
    })
  );
}

exports.register = register;
// the caches of the colours and macros of the project are shared with the panel "Preview selection"
exports.projectColors = projectColors;
exports.colorsFresh = colorsFresh;
exports.colorsNow = () => defsCache.defs;
exports.katexMacros = katexMacros;
exports.macrosFresh = macrosFresh;
exports.macrosNow = (doc) => (macrosCache.key === doc.uri.toString() ? macrosCache.macros : {});
