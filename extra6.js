'use strict';
/* TSS Workflow 0.8.0: "Edit table visually".
 * A tab next to the editor shows tblr / longtblr / talltblr / tabular / tabularx / array / longtable as a grid:
 * type in cells, add / delete / move rows and columns, change column alignment, paste a range from Excel.
 * Every change replaces only the text of that one environment (one undo step), and the grid follows manual edits of the file.
 * The model is in extra6Pure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const X = require('./extra6Pure');
const M = require('./macros');
const MP = require('./macrosPure');

const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
const SEL = [{ language: 'latex' }, { language: 'tex' }];
const isTex = (d) => !!d && (d.languageId === 'latex' || d.languageId === 'tex');

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
  const kx = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'katex', f)).toString();
  const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + n + "' " + webview.cspSource + '; font-src ' + webview.cspSource + '; img-src ' + webview.cspSource + ' data:;';
  return '<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="' + kx('katex.min.css') + '"><style>' + CSS + '</style></head><body>' +
    '<div id="bar"><span id="what"></span><span id="size"></span></div><div id="warn"></div><div id="info"></div><div id="toast"></div>' +
    '<div id="wrap" tabindex="0"><table id="t"></table></div><div id="hint">Enter/Tab/стрілки: рух · Shift+клік чи перетягування: виділення · Delete: очистити · Ctrl+C/X/V: копіювати, вирізати, вставити (в тому числі з Excel) · Ctrl+D: дублювати рядок · Ctrl+Enter: рядок нижче · Alt+стрілки: перемістити · Ctrl+Z: скасувати зміну у файлі</div>' +
    '<script nonce="' + n + '" src="' + kx('katex.min.js') + '"></script><script nonce="' + n + '">' + JS + '</script></body></html>';
}

const CSS = [
  'body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:10px 14px;margin:0}',
  '#bar{display:flex;gap:12px;align-items:baseline;margin-bottom:6px;opacity:.85}#what{font-weight:600}#size{opacity:.7}',
  '#warn{color:var(--vscode-editorWarning-foreground);margin:4px 0;font-size:.92em}#warn:empty{display:none}',
  '#toast{position:fixed;right:14px;top:10px;max-width:420px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);padding:6px 10px;border-radius:3px;display:none;z-index:9}',
  '#wrap{overflow:auto;max-height:calc(100vh - 110px);padding:4px 2px 8px 2px}',
  'table{border-collapse:collapse}th,td{border:1px solid var(--vscode-editorWidget-border,#888);padding:0}',
  'th{font-weight:400;background:var(--vscode-editorGroupHeader-tabsBackground);color:var(--vscode-descriptionForeground);position:relative;min-width:30px;font-size:.85em;padding:2px 6px;text-align:center;white-space:nowrap}',
  'th.rh{text-align:right;min-width:34px}',
  'td.c{min-width:90px;max-width:420px;padding:4px 8px;vertical-align:middle;outline:none;white-space:pre-wrap;word-break:break-word;font-family:var(--vscode-editor-font-family)}',
  'td.c:focus{background:var(--vscode-editor-selectionBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}',
  'td.al-l{text-align:left}td.al-c{text-align:center}td.al-r{text-align:right}',
  'tr.rule td.c,tr.rule th.rh{border-top:2px solid var(--vscode-foreground)}tr.tailrule td.c,tr.tailrule th.rh{border-bottom:2px solid var(--vscode-foreground)}',
  '.tools{display:none;position:absolute;z-index:5;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border,#888);border-radius:3px;padding:1px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35)}',
  'th.ch .tools{left:0;top:100%}th.rh .tools{left:100%;top:0}th:hover .tools{display:flex}',
  '.tools button,#t button.add{font:inherit;font-size:.85em;color:var(--vscode-foreground);background:transparent;border:1px solid transparent;border-radius:2px;padding:1px 5px;cursor:pointer}',
  '.tools button:hover,#t button.add:hover{background:var(--vscode-toolbar-hoverBackground)}.tools button.on{border-color:var(--vscode-focusBorder)}.tools button[disabled]{opacity:.35;cursor:default}',
  '.tools button.x:hover{color:var(--vscode-errorForeground)}',
  'td.addc,td.addr{text-align:center;border-style:dashed;opacity:.65}td.addc:hover,td.addr:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}td.addc,td.addr{cursor:pointer;padding:2px 10px}',
  'td.c .chip{display:inline-block;font-size:.85em;padding:0 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}td.c .katex{font-size:1.05em}td.c.merged{box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}td.c.unk{border-bottom:2px dotted var(--vscode-editorWarning-foreground)}td.c b{font-weight:700}',
  'td.c.sel{box-shadow:inset 0 0 0 2px var(--vscode-focusBorder);background-image:linear-gradient(rgba(80,140,255,.25),rgba(80,140,255,.25))}#wrap:focus{outline:none}body.dragging{user-select:none;cursor:cell}',
  'td.c.formula{font-style:italic;background-image:linear-gradient(rgba(150,150,150,.12),rgba(150,150,150,.12))}td.c code{font-family:var(--vscode-editor-font-family)}#info{opacity:.7;margin:2px 0;font-size:.88em}#info:empty{display:none}',
  '#hint{margin-top:8px;font-size:.8em;opacity:.6}'
].join('');

const JS = String.raw`
const vscode = acquireVsCodeApi();
let view = null, last = '', macros = {};
let sel = null;     // { a: {r, c}, f: {r, c} }: selected cells (no cell is being edited)
let mouse = null;   // { r, c, td, dragging }
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const STRUCT = new Set(['addRow', 'delRow', 'moveRow', 'addCol', 'delCol', 'moveCol', 'dupRows']);
function post(op) { if (STRUCT.has(op.type)) { sel = null; paintSel(); } vscode.postMessage({ type: 'op', op: op }); }
function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(function () { t.style.display = 'none'; }, 5000); }
const cellAt = (r, c) => document.querySelector('td.c[data-r="' + r + '"][data-c="' + c + '"]');
const allCells = () => Array.prototype.slice.call(document.querySelectorAll('td.c'));
const isCell = (el) => !!(el && el.classList && el.classList.contains('c'));

function btn(label, title, fn, cls, disabled) {
  const b = document.createElement('button');
  b.textContent = label; b.title = title; if (cls) b.className = cls; if (disabled) b.disabled = true;
  b.addEventListener('mousedown', function (e) { e.preventDefault(); });
  b.addEventListener('click', function (e) { e.stopPropagation(); if (!disabled) fn(); });
  return b;
}

/* ----------------------------- how a cell looks ----------------------------- */
function mathHtml(src) {
  try { if (window.katex) return window.katex.renderToString(src, { throwOnError: false, output: 'html', strict: 'ignore', macros: Object.assign({}, macros) }); } catch (e) { /* fall through */ }
  return '<code>' + esc(src) + '</code>';
}
function chip(icon, text) { return '<span class="chip">' + icon + ' ' + text + '</span>'; }
function textHtml(t) {
  let s = esc(t);
  s = s.replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g, function (a, n) { return chip('🖼', n); });
  s = s.replace(/\\(?:localinput|input|include|subfile)\{([^}]*)\}/g, function (a, n) { return chip('◇', n); });
  s = s.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, chip('◇', 'tikz'));
  s = s.replace(/\\(?:eqref|ref|autoref|cref|Cref)\{([^}]*)\}/g, function (a, n) { return chip('→', n); });
  s = s.replace(/\\rownumber\b/g, chip('№', 'авто'));
  s = s.replace(/\\(?:cite[a-z]*|parencite|textcite|autocite)(?:\[[^\]]*\])*\{([^}]*)\}/g, '[$1]');
  s = s.replace(/\\SI\{([^}]*)\}\{([^}]*)\}/g, '$1\u00a0$2').replace(/\\(?:num|unit|si)\{([^}]*)\}/g, '$1');
  s = s.replace(/\\textbf\{([^{}]*)\}/g, '<b>$1</b>').replace(/\\(?:textit|emph)\{([^{}]*)\}/g, '<i>$1</i>').replace(/\\underline\{([^{}]*)\}/g, '<u>$1</u>');
  s = s.replace(/\\&amp;/g, '&amp;').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\#/g, '#').replace(/\\([{}])/g, '$1');
  s = s.replace(/\\\\/g, ' ').replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, '\u00a0').replace(/\u0001/g, '$');
  return s;
}
function fmt(raw) {
  const s = raw.replace(/\\\$/g, '\u0001');
  const re = /\$\$([\s\S]+?)\$\$|\$([^$]+)\$|\\\(([\s\S]+?)\\\)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) { out += textHtml(s.slice(last, m.index)) + mathHtml(m[1] || m[2] || m[3]); last = re.lastIndex; }
  return out + textHtml(s.slice(last));
}
// spreadtab: "@ text" is a text cell, anything else with letters (sum(c2:[0,-1])) is a formula
const isFormulaRaw = (raw) => !!(view && view.spread) && raw !== '' && !/^@/.test(raw) && !/^\\/.test(raw) && /[A-Za-z]/.test(raw);
// tabularray mode=math|imath|dmath: the whole cell is a formula even without $ ... $
const hasMathDelims = (s) => /(^|[^\\])\$|\\\(/.test(s);
function renderCell(td, raw) {
  let s = String(raw).replace(/^\\cellcolor(?:\[[^\]]*\])?\{[^}]*\}\s*/, '');
  if (isFormulaRaw(s)) { td.classList.add('formula'); td.innerHTML = chip('ƒ', '') + ' <code>' + esc(s) + '</code>'; return; }
  td.classList.remove('formula');
  if (view && view.spread) s = s.replace(/^@\s*/, '');
  const mode = td.dataset.mode;
  if ((mode === 'math' || mode === 'dmath') && s.trim() && !hasMathDelims(s)) {
    td.innerHTML = mathHtml((mode === 'dmath' ? '\\displaystyle ' : '') + s);
    return;
  }
  td.innerHTML = fmt(s);
}

/* -------------------------------- selection -------------------------------- */
function rect() {
  if (!sel) return null;
  return { r1: Math.min(sel.a.r, sel.f.r), r2: Math.max(sel.a.r, sel.f.r), c1: Math.min(sel.a.c, sel.f.c), c2: Math.max(sel.a.c, sel.f.c) };
}
function paintSel() {
  document.querySelectorAll('td.c.sel').forEach(function (td) { td.classList.remove('sel'); });
  const rc = rect();
  if (!rc) return;
  for (let r = rc.r1; r <= rc.r2; r++) for (let c = rc.c1; c <= rc.c2; c++) { const td = cellAt(r, c); if (td) td.classList.add('sel'); }
}
function setSel(a, f) {
  const act = document.activeElement;
  if (isCell(act)) act.blur();
  sel = { a: a, f: f };
  paintSel();
  $('wrap').focus({ preventScroll: true });
}
function clampCell(r, c) {
  if (!view) return null;
  r = Math.max(0, Math.min(view.rows.length - 1, r));
  const n = view.rows[r].cells.length;
  c = Math.max(0, Math.min(n - 1, c));
  return { r: r, c: c };
}
// the nearest existing cell (merged cells hide some of them)
function findCell(r, c, dc) {
  const p = clampCell(r, c);
  if (!p) return null;
  for (let k = p.c; k >= 0 && k < view.rows[p.r].cells.length; k += (dc || 1)) { const td = cellAt(p.r, k); if (td) return td; }
  for (let k = p.c; k >= 0; k--) { const td = cellAt(p.r, k); if (td) return td; }
  return null;
}
function tsv(rc) {
  const lines = [];
  for (let r = rc.r1; r <= rc.r2; r++) { const row = []; for (let c = rc.c1; c <= rc.c2; c++) { const td = cellAt(r, c); row.push(td ? td.dataset.orig : ''); } lines.push(row.join('\t')); }
  return lines.join('\n');
}
function parseGrid(txt) { return txt.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(function (l) { return l.split('\t'); }); }
function caretToEnd(td) { const s = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(td); rg.collapse(false); s.removeAllRanges(); s.addRange(rg); }

/* --------------------------------- drawing --------------------------------- */
function render(v, focus) {
  view = v;
  const t = $('t');
  const act = document.activeElement;
  const prev = focus || (isCell(act) ? { r: +act.dataset.r, c: +act.dataset.c } : null);
  t.innerHTML = '';
  const cols = v.canCols;
  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  for (let c = 0; c < v.width; c++) {
    const th = document.createElement('th'); th.className = 'ch'; th.dataset.col = c;
    th.appendChild(document.createTextNode(colName(c)));
    const tl = document.createElement('div'); tl.className = 'tools';
    tl.appendChild(btn('◀', 'Лівіше (Alt+←)', function () { post({ type: 'moveCol', c: c, dir: -1 }); }, '', !cols || c === 0));
    tl.appendChild(btn('▶', 'Правіше (Alt+→)', function () { post({ type: 'moveCol', c: c, dir: 1 }); }, '', !cols || c === v.width - 1));
    tl.appendChild(btn('+◀', 'Додати стовпець ліворуч', function () { post({ type: 'addCol', at: c }); }, '', !cols));
    tl.appendChild(btn('▶+', 'Додати стовпець праворуч', function () { post({ type: 'addCol', at: c + 1 }); }, '', !cols));
    if (v.align) ['l', 'c', 'r'].forEach(function (a) { tl.appendChild(btn(a, 'Вирівняти: ' + a, function () { post({ type: 'setAlign', c: c, a: a }); }, v.align[c] === a ? 'on' : '')); });
    tl.appendChild(btn('✕', 'Видалити стовпець', function () { post({ type: 'delCol', c: c }); }, 'x', !cols || v.width <= 1));
    th.appendChild(tl); head.appendChild(th);
  }
  t.appendChild(head);
  v.rows.forEach(function (row, r) {
    const tr = document.createElement('tr');
    if (row.rule) tr.className = 'rule';
    if (r === v.rows.length - 1 && v.tailRule) tr.className += ' tailrule';
    const rh = document.createElement('th'); rh.className = 'rh'; rh.textContent = String(r + 1); rh.dataset.row = r;
    if (row.extra) rh.title = row.extra;
    const tl = document.createElement('div'); tl.className = 'tools';
    tl.appendChild(btn('▲', 'Вище (Alt+↑)', function () { post({ type: 'moveRow', r: r, dir: -1 }); }, '', r === 0));
    tl.appendChild(btn('▼', 'Нижче (Alt+↓)', function () { post({ type: 'moveRow', r: r, dir: 1 }); }, '', r === v.rows.length - 1));
    tl.appendChild(btn('+▲', 'Додати рядок вище (Ctrl+Shift+Enter)', function () { post({ type: 'addRow', at: r, focus: { r: r, c: 0 } }); }));
    tl.appendChild(btn('▼+', 'Додати рядок нижче (Ctrl+Enter)', function () { post({ type: 'addRow', at: r + 1, below: true, focus: { r: r + 1, c: 0 } }); }));
    tl.appendChild(btn('⧉', 'Дублювати рядок (Ctrl+D)', function () { post({ type: 'dupRows', r1: r, r2: r, focus: { r: r + 1, c: 0 } }); }));
    tl.appendChild(btn('✕', 'Видалити рядок (Ctrl+Shift+K)', function () { post({ type: 'delRow', r: r }); }, 'x', v.rows.length <= 1));
    rh.appendChild(tl); tr.appendChild(rh);
    let logical = 0;
    row.cells.forEach(function (cell, c) {
      const lg = logical;
      logical += (cell.kind === 'mc' ? cell.span : 1);
      if (cell.hidden) return;
      const td = document.createElement('td');
      const st = cell.style || {};
      td.className = 'c al-' + (st.align || (v.align && v.align[lg]) || 'l') + ((cell.span > 1 || cell.rowspan > 1) ? ' merged' : '') + (st.unknownColor ? ' unk' : '');
      td.contentEditable = 'plaintext-only';
      td.tabIndex = -1;
      td.spellcheck = false;
      td.dataset.r = r; td.dataset.c = c; td.dataset.orig = cell.raw;
      if (st.mode) td.dataset.mode = st.mode;
      if (cell.span > 1) td.colSpan = cell.span;
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      if (st.bg) td.style.background = st.bg;
      if (st.fg) td.style.color = st.fg;
      if (st.bold) td.style.fontWeight = '700';
      if (st.unknownColor) td.title = 'Колір «' + st.unknownColor + '» не знайдено в проєкті: у PDF він буде з визначення (тут показано без фону)';
      renderCell(td, cell.raw);
      tr.appendChild(td);
    });
    t.appendChild(tr);
  });
  const add = document.createElement('tr');
  add.appendChild(document.createElement('th'));
  const tdA = document.createElement('td'); tdA.className = 'addr'; tdA.colSpan = Math.max(1, v.width); tdA.textContent = '＋ рядок';
  tdA.addEventListener('click', function () { post({ type: 'addRow', at: v.rows.length, focus: { r: v.rows.length, c: 0 } }); });
  add.appendChild(tdA); t.appendChild(add);
  const th = document.createElement('th'); th.appendChild(btn('＋', cols ? 'Додати стовпець у кінець' : v.colsWhy, function () { post({ type: 'addCol', at: v.width }); }, 'add', !cols)); head.appendChild(th);
  $('size').textContent = v.rows.length + ' × ' + v.width + (v.spread ? ' · spreadtab' : '');
  const w = [];
  if (v.indexedKeys) w.push('У параметрах є row{odd}, row{even} або відкриті діапазони: вони залежать від кількості рядків, перевір їх після змін.');
  if (v.merged) w.push('Є об\'єднані клітинки: стовпці можна додавати й видаляти, а переставляти лише в коді.');
  $('warn').textContent = w.join(' ');
  const inf = [];
  if (v.keysAuto) inf.push('Номери в row{…}, column{…}, cell{…}, hline{…}, vline{…} зсуваються разом із рядками й стовпцями.');
  if (v.absRefs) inf.push('Посилання на клітинки у формулах (c2…) теж зсуваються автоматично.');
  $('info').textContent = inf.join(' ');
  if (sel && (sel.a.r >= v.rows.length || sel.f.r >= v.rows.length)) sel = null;
  paintSel();
  if (prev && !sel) { const el = findCell(prev.r, prev.c); if (el) el.focus(); }
}
function sig(v) { return JSON.stringify(v); }

/* ---------------------------------- mouse ---------------------------------- */
document.addEventListener('mousedown', function (e) {
  const td = e.target.closest ? e.target.closest('td.c') : null;
  if (!td) return;
  const r = +td.dataset.r, c = +td.dataset.c;
  const act = document.activeElement;
  if (e.shiftKey && (sel || isCell(act))) {
    e.preventDefault();
    const anchor = sel ? sel.a : { r: +act.dataset.r, c: +act.dataset.c };
    setSel(anchor, { r: r, c: c });
    return;
  }
  mouse = { r: r, c: c, td: td, dragging: false };
  if (sel) { sel = null; paintSel(); }
});
document.addEventListener('mousemove', function (e) {
  if (!mouse) return;
  if (!(e.buttons & 1)) { mouse = null; return; }
  const td = e.target.closest ? e.target.closest('td.c') : null;
  if (!td || (td === mouse.td && !mouse.dragging)) return;
  mouse.dragging = true;
  document.body.classList.add('dragging');
  e.preventDefault();
  window.getSelection().removeAllRanges();
  setSel({ r: mouse.r, c: mouse.c }, { r: +td.dataset.r, c: +td.dataset.c });
});
document.addEventListener('mouseup', function () { mouse = null; document.body.classList.remove('dragging'); });
document.addEventListener('click', function (e) {
  if (e.target.closest && e.target.closest('.tools')) return;
  const ch = e.target.closest ? e.target.closest('th.ch') : null;
  const rh = e.target.closest ? e.target.closest('th.rh') : null;
  if (ch && view) { const c = +ch.dataset.col; setSel({ r: 0, c: c }, { r: view.rows.length - 1, c: c }); }
  else if (rh && view) { const r = +rh.dataset.row; setSel({ r: r, c: 0 }, { r: r, c: view.rows[r].cells.length - 1 }); }
});

/* --------------------------------- keyboard --------------------------------- */
function goto(r, c, from) {
  const td = findCell(r, c, 1);
  if (td && td !== from) td.focus();
}
function editKey(e, td) {
  const r = +td.dataset.r, c = +td.dataset.c;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (mod) { td.blur(); if (e.shiftKey) post({ type: 'addRow', at: r, focus: { r: r, c: c } }); else post({ type: 'addRow', at: r + 1, below: true, focus: { r: r + 1, c: c } }); return; }
    goto(r + (e.shiftKey ? -1 : 1), c, td);
    return;
  }
  if (e.key === 'Escape') { td.textContent = td.dataset.orig; td.blur(); renderCell(td, td.dataset.orig); return; }
  if (e.key === 'Tab') { e.preventDefault(); const cells = allCells(); const k = cells.indexOf(td) + (e.shiftKey ? -1 : 1); if (cells[k]) cells[k].focus(); return; }
  if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); td.blur(); post({ type: 'dupRows', r1: r, r2: r, focus: { r: r + 1, c: c } }); return; }
  if (mod && e.shiftKey && (e.key === 'K' || e.key === 'k')) { e.preventDefault(); td.blur(); post({ type: 'delRow', r: r, focus: { r: Math.max(0, r - 1), c: c } }); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); td.blur(); const d = e.key === 'ArrowUp' ? -1 : 1; post({ type: 'moveRow', r: r, dir: d, focus: { r: r + d, c: c } }); return; }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); td.blur(); const d = e.key === 'ArrowLeft' ? -1 : 1; post({ type: 'moveCol', c: c, dir: d, focus: { r: r, c: c + d } }); return; }
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (!vertical && !horizontal) return;
  if (horizontal) {
    const s = window.getSelection();
    const len = td.textContent.length;
    const off = s.anchorOffset;
    const atStart = s.isCollapsed && off === 0, atEnd = s.isCollapsed && off >= len;
    if (!((e.key === 'ArrowLeft' && atStart) || (e.key === 'ArrowRight' && atEnd))) return;
  }
  e.preventDefault();
  const nr = r + (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0);
  const nc = c + (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
  if (e.shiftKey) { const to = clampCell(nr, nc); if (to) setSel({ r: r, c: c }, to); }
  else goto(nr, nc, td);
}
function selKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const rc = rect();
  if (e.key === 'Escape') { sel = null; paintSel(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); post({ type: 'clear', r1: rc.r1, c1: rc.c1, r2: rc.r2, c2: rc.c2 }); return; }
  if (mod && (e.key === 'a' || e.key === 'A') && view) { e.preventDefault(); setSel({ r: 0, c: 0 }, { r: view.rows.length - 1, c: view.width - 1 }); return; }
  if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); post({ type: 'dupRows', r1: rc.r1, r2: rc.r2, focus: { r: rc.r2 + 1, c: rc.c1 } }); return; }
  if (mod && e.shiftKey && (e.key === 'K' || e.key === 'k')) { e.preventDefault(); if (rc.r1 !== rc.r2) { toast('Видаляй рядки по одному.'); return; } post({ type: 'delRow', r: rc.r1 }); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && rc.r1 === rc.r2) { e.preventDefault(); const d = e.key === 'ArrowUp' ? -1 : 1; post({ type: 'moveRow', r: rc.r1, dir: d }); return; }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && rc.c1 === rc.c2) { e.preventDefault(); const d = e.key === 'ArrowLeft' ? -1 : 1; post({ type: 'moveCol', c: rc.c1, dir: d }); return; }
  if (e.key.indexOf('Arrow') === 0) {
    e.preventDefault();
    const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const to = clampCell(sel.f.r + dr, sel.f.c + dc);
    if (!to) return;
    if (e.shiftKey) setSel(sel.a, to); else setSel(to, to);
    return;
  }
  if (e.key === 'Enter' || e.key === 'F2' || (e.key.length === 1 && !mod && !e.altKey)) {
    e.preventDefault();
    const td = cellAt(sel.f.r, sel.f.c);
    sel = null; paintSel();
    if (!td) return;
    td.focus();
    if (e.key.length === 1) { td.textContent = e.key; caretToEnd(td); }
  }
}
document.addEventListener('keydown', function (e) {
  const act = document.activeElement;
  const editing = isCell(act);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
    const typed = editing && act.textContent !== act.dataset.orig;
    if (!typed) { e.preventDefault(); vscode.postMessage({ type: (e.key === 'y' || e.key === 'Y' || e.shiftKey) ? 'redo' : 'undo' }); }
    return;
  }
  if (editing) editKey(e, act);
  else if (sel) selKey(e);
});
document.addEventListener('focusin', function (e) {
  const td = e.target;
  if (!isCell(td)) return;
  td.textContent = td.dataset.orig;
  caretToEnd(td);
});
document.addEventListener('focusout', function (e) {
  const td = e.target;
  if (!isCell(td)) return;
  const txt = td.textContent.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (txt !== td.dataset.orig) { td.dataset.orig = txt; post({ type: 'setCell', r: +td.dataset.r, c: +td.dataset.c, text: txt }); }
  renderCell(td, td.dataset.orig);
});

/* ----------------------------- clipboard ----------------------------- */
document.addEventListener('copy', function (e) {
  if (isCell(document.activeElement) || !sel) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', tsv(rect()));
});
document.addEventListener('cut', function (e) {
  if (isCell(document.activeElement) || !sel) return;
  e.preventDefault();
  const rc = rect();
  e.clipboardData.setData('text/plain', tsv(rc));
  post({ type: 'clear', r1: rc.r1, c1: rc.c1, r2: rc.r2, c2: rc.c2 });
});
document.addEventListener('paste', function (e) {
  const act = document.activeElement;
  const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (isCell(act)) {
    if (!/[\t\n]/.test(txt.replace(/[\r\n]+$/, ''))) return;   // one value: an ordinary paste into the text
    e.preventDefault();
    post({ type: 'fill', r: +act.dataset.r, c: +act.dataset.c, rows: parseGrid(txt) });
    return;
  }
  if (!sel) return;
  e.preventDefault();
  const rc = rect();
  const grid = parseGrid(txt);
  const one = grid.length === 1 && grid[0].length === 1;
  if (one && (rc.r2 > rc.r1 || rc.c2 > rc.c1)) {
    const rows = [];
    for (let r = rc.r1; r <= rc.r2; r++) { const row = []; for (let c = rc.c1; c <= rc.c2; c++) row.push(grid[0][0]); rows.push(row); }
    post({ type: 'fill', r: rc.r1, c: rc.c1, rows: rows });
  } else post({ type: 'fill', r: rc.r1, c: rc.c1, rows: grid });
});

window.addEventListener('message', function (ev) {
  const m = ev.data;
  if (m.type === 'model') {
    macros = m.macros || {};
    $('what').textContent = m.view.env + ' · ' + (m.where || '');
    const s = sig(m.view);
    const active = isCell(document.activeElement);
    if (s !== last || !active) { last = s; render(m.view, m.focus); } else { view = m.view; }
  } else if (m.type === 'skip') {
    $('t').innerHTML = ''; $('size').textContent = ''; $('what').textContent = 'Цю таблицю не можна редагувати візуально';
    $('warn').textContent = m.reason + '. Правь її в коді.'; $('info').textContent = ''; last = ''; sel = null;
  } else if (m.type === 'error') {
    toast(m.message); last = '';
  }
});
vscode.postMessage({ type: 'ready' });
`;

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
