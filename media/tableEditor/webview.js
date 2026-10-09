const vscode = acquireVsCodeApi();
let view = null, last = '', macros = {};
let sel = null;     // { a: {r, c}, f: {r, c} }: selected cells (no cell is being edited)
let mouse = null;   // { r, c, td, dragging }
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const STRUCT = new Set(['addRow', 'delRow', 'moveRow', 'addCol', 'delCol', 'moveCol', 'dupRows']);
// tells the extension which row is active, so that the file is scrolled to it (key: row, or 'x' for the whole table)
let lastFollow = '';
function follow(r, force) {
  const k = Number.isInteger(r) ? String(r) : 'x';
  if (!force && k === lastFollow) return;
  lastFollow = k;
  vscode.postMessage({ type: 'follow', r: Number.isInteger(r) ? r : null });
}
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
let mathErr = ''; // the first KaTeX error while one cell is being drawn
function mathHtml(src) {
  const opts = { output: 'html', strict: 'ignore', macros: Object.assign({}, macros) };
  try {
    if (window.katex) {
      try { return window.katex.renderToString(src, Object.assign({ throwOnError: true }, opts)); }
      catch (e) { if (!mathErr) mathErr = String(e.message || e).replace(/^KaTeX parse error:\s*/, '').replace(/\s+at position[\s\S]*$/, ''); }
      return window.katex.renderToString(src, Object.assign({ throwOnError: false }, opts));
    }
  } catch (e) { /* fall through */ }
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
const CYRILLIC = /[\u0400-\u04FF]/;
const TEXT_GROUP = /\\(?:text|textrm|textit|textbf|textsf|mbox|mathrm)\s*\{[^{}]*\}/g;
// the classes and the tooltip of a cell after it is drawn: a Cyrillic letter in math mode, a formula KaTeX could not draw
function finishCell(td, warn) {
  td.classList.toggle('mathwarn', !!warn);
  td.classList.toggle('matherr', !!mathErr);
  const err = mathErr ? 'Формулу не вдалося намалювати: ' + mathErr + '. Якщо цей макрос визначено в проєкті, у PDF він спрацює; редактор лише не вміє його розгорнути.' : '';
  const parts = [td.dataset.unk || '', warn, err].filter(Boolean);
  if (parts.length) td.title = parts.join('\n'); else td.removeAttribute('title');
}
function renderCell(td, raw) {
  mathErr = '';
  let s = String(raw).replace(/^\\cellcolor(?:\[[^\]]*\])?\{[^}]*\}\s*/, '');
  if (isFormulaRaw(s)) { td.classList.add('formula'); td.innerHTML = chip('ƒ', '') + ' <code>' + esc(s) + '</code>'; finishCell(td, ''); return; }
  td.classList.remove('formula');
  if (view && view.spread) s = s.replace(/^@\s*/, '');
  const mode = td.dataset.mode;
  if ((mode === 'math' || mode === 'dmath') && s.trim() && !hasMathDelims(s)) {
    td.innerHTML = mathHtml((mode === 'dmath' ? '\\displaystyle ' : '') + s);
    finishCell(td, CYRILLIC.test(s.replace(TEXT_GROUP, '')) ? 'Кирилиця поза \\text{…} у математичному режимі (mode=' + mode + '): у PDF буква може не мати гліфа. Загорніть текст у \\text{…}.' : '');
    return;
  }
  td.innerHTML = fmt(s);
  finishCell(td, '');
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
  follow(f.r);
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
  lastFollow = ''; // the file may have been scrolled away since: the next focus tells the extension again
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
      if (st.unknownColor) { td.dataset.unk = 'Колір «' + st.unknownColor + '» не знайдено в проєкті: у PDF він буде з визначення (тут показано без фону)'; td.title = td.dataset.unk; }
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
// every click in the grid brings the file back to the table (to the row that was clicked, else to the table)
document.addEventListener('mousedown', function (e) {
  const t = e.target.closest ? e.target : null;
  const cell = t && t.closest('td.c');
  const head = t && t.closest('th.rh');
  follow(cell ? +cell.dataset.r : head ? +head.dataset.row : null, true);
});
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
  follow(+td.dataset.r);
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
