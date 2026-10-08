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

async function push(extra) {
  if (!panel) return;
  const cur = await current();
  if (!cur) return;
  if (cur.skip) { panel.webview.postMessage({ type: 'skip', reason: cur.skip }); return; }
  panel.title = 'Таблиця: ' + path.basename(cur.doc.uri.fsPath) + ':' + lineOf(cur.doc, cur.env);
  panel.webview.postMessage(Object.assign({ type: 'model', view: X.toView(cur.model, await projectColors()), where: path.basename(cur.doc.uri.fsPath) + ':' + lineOf(cur.doc, cur.env) }, extra || {}));
}

async function onOp(op) {
  const cur = await current();
  if (!cur || cur.skip) { push(); return; }
  const res = X.applyOp(cur.model, op);
  if (res.error) { panel.webview.postMessage({ type: 'error', message: res.error }); push(); return; }
  if (res.same) return;
  const out = X.serialize(res.model);
  if (out === cur.text.slice(cur.env.start, cur.env.end)) { push(); return; }
  const we = new vscode.WorkspaceEdit();
  we.replace(cur.doc.uri, new vscode.Range(cur.doc.positionAt(cur.env.start), cur.doc.positionAt(cur.env.end)), out);
  selfEdit++;
  try { await vscode.workspace.applyEdit(we); } finally { selfEdit--; }
  await push({ focus: op.focus || null });
}

/* -------------------------------- the panel -------------------------------- */
function html(webview, extUri) {
  const n = nonce();
  const kx = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'katex', f)).toString();
  const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + n + "' " + webview.cspSource + '; font-src ' + webview.cspSource + '; img-src ' + webview.cspSource + ' data:;';
  return '<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="' + kx('katex.min.css') + '"><style>' + CSS + '</style></head><body>' +
    '<div id="bar"><span id="what"></span><span id="size"></span></div><div id="warn"></div><div id="toast"></div>' +
    '<div id="wrap"><table id="t"></table></div><div id="hint">Enter: вниз · Tab: далі · Esc: скасувати · вставка діапазону з Excel заповнює клітинки · зміни йдуть у файл (Ctrl+Z скасовує)</div>' +
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
  '#hint{margin-top:8px;font-size:.8em;opacity:.6}'
].join('');

const JS = String.raw`
const vscode = acquireVsCodeApi();
let view = null, last = '';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
function post(op) { vscode.postMessage({ type: 'op', op }); }
function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => { t.style.display = 'none'; }, 5000); }

function btn(label, title, fn, cls, disabled) {
  const b = document.createElement('button');
  b.textContent = label; b.title = title; if (cls) b.className = cls; if (disabled) b.disabled = true;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { e.stopPropagation(); if (!disabled) fn(); });
  return b;
}

function mathHtml(src) {
  try { if (window.katex) return window.katex.renderToString(src, { throwOnError: false, output: 'html', strict: 'ignore' }); } catch (e) { /* fall through */ }
  return '<code>' + esc(src) + '</code>';
}
function chip(icon, text) { return '<span class="chip">' + icon + ' ' + text + '</span>'; }
function textHtml(t) {
  let s = esc(t);
  s = s.replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g, (a, n) => chip('🖼', n));
  s = s.replace(/\\(?:localinput|input|include|subfile)\{([^}]*)\}/g, (a, n) => chip('◇', n));
  s = s.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, chip('◇', 'tikz'));
  s = s.replace(/\\(?:eqref|ref|autoref|cref|Cref)\{([^}]*)\}/g, (a, n) => chip('→', n));
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
function renderCell(td, raw) {
  td.innerHTML = fmt(String(raw).replace(/^\\cellcolor(?:\[[^\]]*\])?\{[^}]*\}\s*/, ''));
}
document.addEventListener('focusin', (e) => {
  const td = e.target;
  if (!td.classList || !td.classList.contains('c')) return;
  td.textContent = td.dataset.orig;
  const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(td); rg.collapse(false); sel.removeAllRanges(); sel.addRange(rg);
});

function render(v, focus) {
  view = v;
  const t = $('t');
  const prev = focus || (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.r !== undefined ? { r: +document.activeElement.dataset.r, c: +document.activeElement.dataset.c } : null);
  t.innerHTML = '';
  const cols = v.canCols;
  // header
  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  let ci = 0;
  for (let c = 0; c < v.width; c++) {
    const th = document.createElement('th'); th.className = 'ch';
    th.appendChild(document.createTextNode(colName(c)));
    const tl = document.createElement('div'); tl.className = 'tools';
    tl.appendChild(btn('◀', 'Лівіше', () => post({ type: 'moveCol', c, dir: -1 }), '', !cols || c === 0));
    tl.appendChild(btn('▶', 'Правіше', () => post({ type: 'moveCol', c, dir: 1 }), '', !cols || c === v.width - 1));
    tl.appendChild(btn('+◀', 'Додати стовпець ліворуч', () => post({ type: 'addCol', at: c }), '', !cols));
    tl.appendChild(btn('▶+', 'Додати стовпець праворуч', () => post({ type: 'addCol', at: c + 1 }), '', !cols));
    if (v.align) for (const a of ['l', 'c', 'r']) tl.appendChild(btn(a, 'Вирівняти: ' + a, () => post({ type: 'setAlign', c, a }), v.align[c] === a ? 'on' : ''));
    tl.appendChild(btn('✕', 'Видалити стовпець', () => post({ type: 'delCol', c }), 'x', !cols || v.width <= 1));
    th.appendChild(tl); head.appendChild(th);
  }
  t.appendChild(head);
  v.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    if (row.rule) tr.className = 'rule';
    if (r === v.rows.length - 1 && v.tailRule) tr.className += ' tailrule';
    const rh = document.createElement('th'); rh.className = 'rh'; rh.textContent = String(r + 1);
    if (row.extra) rh.title = row.extra;
    const tl = document.createElement('div'); tl.className = 'tools';
    tl.appendChild(btn('▲', 'Вище', () => post({ type: 'moveRow', r, dir: -1 }), '', r === 0));
    tl.appendChild(btn('▼', 'Нижче', () => post({ type: 'moveRow', r, dir: 1 }), '', r === v.rows.length - 1));
    tl.appendChild(btn('+▲', 'Додати рядок вище', () => post({ type: 'addRow', at: r, focus: { r, c: 0 } })));
    tl.appendChild(btn('▼+', 'Додати рядок нижче', () => post({ type: 'addRow', at: r + 1, focus: { r: r + 1, c: 0 } })));
    tl.appendChild(btn('✕', 'Видалити рядок', () => post({ type: 'delRow', r }), 'x', v.rows.length <= 1));
    rh.appendChild(tl); tr.appendChild(rh);
    let logical = 0;
    row.cells.forEach((cell, c) => {
      const lg = logical;
      logical += (cell.kind === 'mc' ? cell.span : 1);
      if (cell.hidden) return;
      const td = document.createElement('td');
      const st = cell.style || {};
      td.className = 'c al-' + (st.align || (v.align && v.align[lg]) || 'l') + ((cell.span > 1 || cell.rowspan > 1) ? ' merged' : '') + (st.unknownColor ? ' unk' : '');
      td.contentEditable = 'plaintext-only';
      td.spellcheck = false;
      td.dataset.r = r; td.dataset.c = c; td.dataset.orig = cell.raw;
      if (cell.span > 1) td.colSpan = cell.span;
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      if (st.bg) td.style.background = st.bg;
      if (st.fg) td.style.color = st.fg;
      if (st.bold) td.style.fontWeight = '700';
      if (st.unknownColor) td.title = 'Колір «' + st.unknownColor + '» не знайдено в проєкті: у PDF він буде з визначення (тут показано без фону)';
      renderCell(td, cell.raw);
      tr.appendChild(td);
    });
    // short rows are padded visually (the file is changed only when something is typed there)
    t.appendChild(tr);
  });
  const add = document.createElement('tr');
  const e0 = document.createElement('th'); add.appendChild(e0);
  const tdA = document.createElement('td'); tdA.className = 'addr'; tdA.colSpan = Math.max(1, v.width); tdA.textContent = '＋ рядок';
  tdA.addEventListener('click', () => post({ type: 'addRow', at: v.rows.length, focus: { r: v.rows.length, c: 0 } }));
  add.appendChild(tdA); t.appendChild(add);
  // a "+" cell at the right of the header
  const th = document.createElement('th'); const b = btn('＋', cols ? 'Додати стовпець у кінець' : v.colsWhy, () => post({ type: 'addCol', at: v.width }), 'add', !cols);
  th.appendChild(b); head.appendChild(th);
  $('size').textContent = v.rows.length + ' × ' + v.width;
  const w = [];
  if (v.indexedKeys) w.push('У параметрах є ключі з номерами (row{…}, column{…}, cell{…}, hline{…}): після додавання чи видалення рядків і стовпців перевір їх.');
  if (v.merged) w.push('Є об\'єднані клітинки: стовпці можна додавати й видаляти, а переставляти лише в коді.');
  $('warn').textContent = w.join(' ');
  if (prev) { const el = t.querySelector('td.c[data-r="' + prev.r + '"][data-c="' + Math.min(prev.c, (v.rows[prev.r] ? v.rows[prev.r].cells.length : 1) - 1) + '"]'); if (el) el.focus(); }
}

function sig(v) { return JSON.stringify(v); }

document.addEventListener('focusout', (e) => {
  const td = e.target;
  if (!td.classList || !td.classList.contains('c')) return;
  const txt = td.textContent.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (txt !== td.dataset.orig) { td.dataset.orig = txt; post({ type: 'setCell', r: +td.dataset.r, c: +td.dataset.c, text: txt }); }
  renderCell(td, td.dataset.orig);
});
document.addEventListener('keydown', (e) => {
  const td = e.target;
  if (!td.classList || !td.classList.contains('c')) return;
  const r = +td.dataset.r, c = +td.dataset.c;
  if (e.key === 'Enter') {
    e.preventDefault();
    const nx = document.querySelector('td.c[data-r="' + (r + (e.shiftKey ? -1 : 1)) + '"][data-c="' + c + '"]');
    if (nx) nx.focus(); else td.blur();
  } else if (e.key === 'Escape') { td.textContent = td.dataset.orig; td.blur(); }
});
document.addEventListener('paste', (e) => {
  const td = e.target;
  if (!td.classList || !td.classList.contains('c')) return;
  const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (!/[\t\n]/.test(txt.replace(/[\r\n]+$/, ''))) return; // a single value: normal paste
  e.preventDefault();
  const rows = txt.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map((l) => l.split('\t'));
  post({ type: 'fill', r: +td.dataset.r, c: +td.dataset.c, rows });
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'model') {
    $('what').textContent = m.view.env + ' · ' + (m.where || '');
    const s = sig(m.view);
    const active = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('c');
    if (s !== last || !active) { last = s; render(m.view, m.focus); } else { view = m.view; }
  } else if (m.type === 'skip') {
    $('t').innerHTML = ''; $('size').textContent = ''; $('what').textContent = 'Цю таблицю не можна редагувати візуально';
    $('warn').textContent = m.reason + '. Правь її в коді.'; last = '';
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
    if (m.type === 'ready') push();
    else if (m.type === 'op') onOp(m.op).catch((e) => panel && panel.webview.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) }));
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
