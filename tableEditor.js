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
const { EXCLUDE_PDF_VERSIONS, cfg, debounce, isTex, openDocByPath } = require('./util');
const K = require('./webviewKit');

const SEL = [{ language: 'latex' }, { language: 'tex' }];

let deco = null; // decoration types of the table / row shown in the file
let followRow = null;
let target = null; // { uri, start, name }
let selfEdit = 0;
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
      const found = await vscode.workspace.findFiles('**/*.{tex,cls,sty}', EXCLUDE_PDF_VERSIONS, 3000);
      const t1 = Date.now();
      const read = async (u, k) => {
        const open = openDocByPath(u.fsPath);
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
let macrosCache = { key: '', at: 0, stamp: '', ver: -1, macros: {}, cmds: new Map() };
const macrosVersion = () => { try { return typeof M._version === 'function' ? M._version() : 0; } catch (e) { return 0; } };
// fresh for a minute, and only while the macros file (mathjax-macros.tex) is the same
const macrosFresh = (doc) => macrosCache.key === doc.uri.toString() && Date.now() - macrosCache.at < 60000 && macrosCache.stamp === MJ.stamp(doc) && macrosCache.ver === macrosVersion();
async function katexMacros(doc) {
  if (macrosFresh(doc)) return macrosCache.macros;
  const t0 = Date.now();
  const ver = macrosVersion();
  let macros = {};
  let cmds = new Map();
  try { cmds = (await M._allMacros(doc)).cmds || new Map(); macros = MP.toKatexMacros([...cmds.values()]); } catch (e) { /* none */ }
  // the commands of that file are known to the text of the panel too (\let, \newcommand); the file wins, as for formulas
  try { for (const [k, v] of MJ.textMacros(doc)) cmds.set(k, v); } catch (e) { /* none */ }
  // what the macros file of the formula preview defines is added (and wins): the same commands as in the LaTeX Workshop hover
  let fromFile = {};
  try { fromFile = MJ.macros(doc); } catch (e) { /* none */ }
  // commands with an optional first argument (\newcommand{\E}[1][E]{...}) are sent as descriptions: the page makes functions of them
  let opt = {};
  let fileOpt = {};
  try { opt = MP.toKatexOptMacros([...cmds.values()]); } catch (e) { /* none */ }
  try { fileOpt = MJ.optMacros(doc); } catch (e) { /* none */ }
  macros = Object.assign({}, macros, opt, fromFile, fileOpt);
  macrosCache = { key: doc.uri.toString(), at: Date.now(), stamp: MJ.stamp(doc), ver, macros, cmds };
  log('[таблиця] макроси проєкту: ' + Object.keys(macros).length + ' (з файла макросів ' + (Object.keys(fromFile).length + Object.keys(fileOpt).length) + ', з необов\'язковим аргументом ' + (Object.keys(opt).length + Object.keys(fileOpt).length) + ') за ' + ms(t0) + ' мс');
  return macros;
}

// The grid is shown at once with what is already known; when the colours and macros of the project still have to be
// found (first time, or after a file with definitions was saved), they are searched for in the background and sent after.
async function push(extra) {
  if (!ctl.panel) return;
  const t0 = Date.now();
  const cur = await current();
  if (!cur) return;
  if (cur.skip) { ctl.panel.webview.postMessage({ type: 'skip', reason: cur.skip }); return; }
  const where = path.basename(cur.doc.uri.fsPath) + ':' + lineOf(cur.doc, cur.env);
  ctl.panel.title = 'Таблиця: ' + where;
  const send = (colors, macros) => ctl.panel && ctl.panel.webview.postMessage(Object.assign({ type: 'model', view: X.toView(cur.model, colors), macros, where }, extra || {}));
  const known = macrosCache.key === cur.doc.uri.toString() ? macrosCache.macros : {};
  if (colorsFresh() && macrosFresh(cur.doc)) { send(defsCache.defs, macrosCache.macros); return; }
  send(defsCache.defs, known);
  log('[таблиця] сітка надіслана за ' + ms(t0) + ' мс; кольори й макроси проєкту ще шукаються');
  const t1 = Date.now();
  await Promise.all([projectColors(), katexMacros(cur.doc)]);
  log('[таблиця] кольори й макроси готові за ' + ms(t1) + ' мс');
  if (ctl.panel && colorsFresh()) await push(); // the second picture, now with colours and macros (nothing is left to wait for)
}

async function onOp(op) {
  const cur = await current();
  if (!cur || cur.skip) { push(); return; }
  let res = X.applyOp(cur.model, op);
  // merging cells that hold text: the text of all but the first cell is lost, so the user is asked first
  if (res.confirm) {
    const yes = 'Об\'єднати';
    const answer = await vscode.window.showWarningMessage(res.confirm, { modal: true }, yes);
    if (answer !== yes) { push(); return; }
    res = X.applyOp(cur.model, Object.assign({}, op, { confirmed: true }));
  }
  if (res.error) { ctl.panel.webview.postMessage({ type: 'error', message: res.error }); push(); return; }
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
    if (ctl.panel) ctl.panel.reveal(ctl.panel.viewColumn, false);
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
  if (!ctl.panel || !target) return;
  if (mode === 'off') { clearFollow(); return; }
  const cur = await current();
  if (!cur || cur.skip || !cur.doc) return;
  let ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === cur.doc.uri.toString());
  if (!ed) ed = await vscode.window.showTextDocument(cur.doc, { viewColumn: ctl.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One, preserveFocus: true, preview: false });
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
  debounce('tableEditor.follow', 60, () => { enqueue(() => follow(followRow)).catch(() => {}); });
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
    '<div id="wrap" tabindex="0"><table id="t"></table></div><div id="hint">Enter/Tab/стрілки: рух · Shift+клік чи перетягування: виділення · Delete: очистити · Ctrl+C/X/V: копіювати, вирізати, вставити (в тому числі з Excel) · Ctrl+D: дублювати рядок · Ctrl+Enter: рядок нижче · Alt+стрілки: перемістити · Ctrl+M / Ctrl+Shift+M: об\'єднати / розʼєднати виділене · Ctrl+Z: скасувати зміну у файлі</div>' +
    '<script nonce="' + n + '" src="' + kx('katex.min.js') + '"></script><script nonce="' + n + '" src="' + kx('mhchem.min.js') + '"></script><script nonce="' + n + '" src="' + kx('optmacros.js') + '"></script><script nonce="' + n + '" src="' + own('webview.js') + '"></script></body></html>';
}

// the frame of the panel (panel, deferred update, 'ready', panelScope) is webviewKit.createPanelController; this module gives the page and its messages
const ctl = K.createPanelController({
  id: 'tableEditor',
  title: 'Таблиця',
  preserveFocus: true,
  noCopy: true, // the page of the table does not send 'copy'
  timers: ['tableEditor.follow', 'tableEditor.refresh'],
  html: (webview, uri) => html(webview, uri),
  onReveal: (c, p) => { p.reveal(vscode.ViewColumn.Beside, true); },
  // the page has loaded: it asks for the table itself
  onReady: () => { if (openedAt) { log('[таблиця] сторінка вкладки завантажилась за ' + ms(openedAt) + ' мс'); openedAt = 0; } enqueue(() => push()); },
  onMessage: (m, c) => {
    if (m.type === 'op') enqueue(() => onOp(m.op)).catch((e) => c.post({ type: 'error', message: String(e && e.message ? e.message : e) }));
    else if (m.type === 'follow') scheduleFollow(Number.isInteger(m.r) ? m.r : null);
    else if (m.type === 'undo' || m.type === 'redo') enqueue(() => history(m.type)).catch(() => {});
  },
  onViewState: (e) => { if (e.webviewPanel.visible && e.webviewPanel.active) scheduleFollow(followRow); },
  onReset: () => { clearFollow(); target = null; followRow = null; }
});

function ensurePanel(context) { return ctl.open(context); }

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
  const fresh = !ctl.panel;
  const t0 = Date.now();
  ensurePanel(context);
  // a new panel asks for the table itself ('ready') when its page has loaded: a message sent now would be lost
  if (fresh) openedAt = t0; else await push();
  scheduleFollow(null);
}

/* ------------------- merged cells in the text: the lightbulb and the warnings ------------------- */
// \SetCell[r=,c=] in the body <-> cell{i}{j} = {r=,c=}{…} in the options of tblr; both ways of writing are read, and when one
// cell has a merge in both places (or two merges overlap) the editor warns
let spanDiag = null;
const spanKinds = () => (vscode.CodeActionKind || {});

function spanEdit(doc, env, text) {
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(doc.positionAt(env.start), doc.positionAt(env.end)), text);
  return we;
}

const spanActions = {
  provideCodeActions(doc, range, ctx) {
    const text = doc.getText();
    const off = doc.offsetAt(range.start);
    const env = X.tableAt(text, off);
    if (!env) return [];
    const map = X.spanMap(text, env);
    if (!map || !map.model.isTblr) return [];
    const kinds = spanKinds();
    const out = [];
    const add = (title, op, kind, fixes) => {
      const r = X.convertSpans(text, env, op);
      if (r.error || !kind) return;
      const a = new vscode.CodeAction(title, kind);
      a.edit = spanEdit(doc, env, r.text);
      if (fixes) a.diagnostics = fixes;
      out.push(a);
    };
    const cells = map.spans.filter((x) => x.src === 'cell');
    const opts = map.spans.filter((x) => x.src === 'opts');
    const here = map.spans.find((x) => x.range && x.range[0] <= off && off <= x.range[1]);
    const dup = map.conflicts.find((c) => c.kind === 'dup' && c.at.some((x) => x.range && x.range[0] <= off && off <= x.range[1]));
    if (dup) {
      const mine = (ctx && ctx.diagnostics ? ctx.diagnostics : []).filter((d) => d.code === 'table-span-dup');
      const p = dup.cells[0];
      add('Залишити \\SetCell, прибрати об\'єднання з параметрів таблиці', { type: 'spanKeep', r: p.r, c: p.c, keep: 'cell' }, kinds.QuickFix, mine);
      add('Залишити об\'єднання в параметрах таблиці, прибрати з \\SetCell', { type: 'spanKeep', r: p.r, c: p.c, keep: 'opts' }, kinds.QuickFix, mine);
    }
    if (here && !dup) {
      const nm = 'cell{' + (here.r + 1) + '}{' + (here.c + 1) + '}';
      if (here.src === 'cell') add('Перенести це об\'єднання в параметри таблиці (' + nm + ' = {r=…,c=…})', { type: 'spansToOptions', r: here.r, c: here.c }, kinds.RefactorRewrite);
      else add('Перенести це об\'єднання (' + nm + ') у \\SetCell', { type: 'spansToCells', r: here.r, c: here.c }, kinds.RefactorRewrite);
    }
    if (cells.length && (cells.length > 1 || !here || here.src !== 'cell')) add('Перенести всі об\'єднання таблиці (' + cells.length + ') з \\SetCell у параметри', { type: 'spansToOptions' }, kinds.RefactorRewrite);
    if (opts.length && (opts.length > 1 || !here || here.src !== 'opts')) add('Перенести всі об\'єднання таблиці (' + opts.length + ') з параметрів у \\SetCell', { type: 'spansToCells' }, kinds.RefactorRewrite);
    return out;
  }
};

function refreshSpanDiag(doc) {
  if (!spanDiag || !doc || !isTex(doc)) return;
  const text = doc.getText();
  const found = [];
  for (const env of X.locateTables(text)) {
    let map = null;
    try { map = X.spanMap(text, env); } catch (e) { map = null; }
    if (!map) continue;
    for (const c of map.conflicts) {
      const rg = (c.at.find((x) => x.range) || {}).range || map.headRange || [env.start, env.bodyStart];
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(rg[0]), doc.positionAt(rg[1])), c.msg, c.kind === 'hidden' || c.kind === 'complex' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
      d.source = 'TSS Workflow';
      d.code = 'table-span-' + c.kind;
      found.push(d);
    }
  }
  spanDiag.set(doc.uri, found);
}

let warmTimer = null;
// a file with tables was shown: look for the colours and macros of the project now, before the tab is opened
function warm(doc) {
  if (!cfg().get('tableEditor.prefetch', true) || (colorsFresh() && macrosFresh(doc)) || warmTimer) return;
  warmTimer = setTimeout(async () => {
    try { await Promise.all([projectColors(), katexMacros(doc)]); } catch (e) { /* later, on demand */ } finally { warmTimer = null; }
  }, 1500);
}

// the warnings about merged cells and the lightbulb actions; nothing is registered where the host lacks the API (test stubs)
function registerSpanTools() {
  const subs = [];
  const langs = vscode.languages || {};
  if (typeof langs.registerCodeActionsProvider === 'function') {
    const k = spanKinds();
    subs.push(langs.registerCodeActionsProvider(SEL, spanActions, { providedCodeActionKinds: [k.RefactorRewrite, k.QuickFix].filter(Boolean) }));
  }
  if (typeof langs.createDiagnosticCollection === 'function') {
    spanDiag = langs.createDiagnosticCollection('tssworkflow-table-spans');
    subs.push(spanDiag);
    const ws = vscode.workspace;
    const on = (ev, cb) => (typeof ev === 'function' ? ev(cb) : null);
    const later = (doc) => { if (doc && isTex(doc)) debounce('tableEditor.spanDiag:' + doc.uri.toString(), 700, () => refreshSpanDiag(doc)); };
    subs.push(on(ws.onDidOpenTextDocument, (d) => refreshSpanDiag(d)));
    subs.push(on(ws.onDidChangeTextDocument, (e) => later(e.document)));
    subs.push(on(ws.onDidCloseTextDocument, (d) => { if (spanDiag) spanDiag.delete(d.uri); }));
    for (const d of ws.textDocuments || []) refreshSpanDiag(d);
  }
  return subs.filter(Boolean);
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
      if (!ctl.panel || !target || selfEdit || e.document.uri.toString() !== target.uri.toString()) return;
      debounce('tableEditor.refresh', 250, () => push());
    }),
    ...registerSpanTools(),
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
exports.isOpen = () => ctl.isOpen(); // for the state report (debugState.js)
// the caches of the colours and macros of the project are shared with the panel "Preview selection"
exports.projectColors = projectColors;
exports.colorsFresh = colorsFresh;
exports.colorsNow = () => defsCache.defs;
exports.katexMacros = katexMacros;
exports.macrosFresh = macrosFresh;
exports.macrosNow = (doc) => (macrosCache.key === doc.uri.toString() ? macrosCache.macros : {});
// the commands of the project (name -> entry) for the text of the panel: its simple macros are drawn by their bodies
exports.textMacrosNow = (doc) => (macrosCache.key === doc.uri.toString() ? macrosCache.cmds : new Map());
