'use strict';
/* Extra features of TSS Workflow: wrap / typography / sentences, table operations,
 * environment conversion, project-wide labels (completion, rename, checks), quick error
 * checks, picture browser, unused files, compile-on-save switch, change preview (diff),
 * normalize file, hovers, heading navigator, build-log warnings, typography on save. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const P = require('./corePure');
const X = require('./projectInfoPure');

const EXCLUDE = '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**}';
const PIC_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif', '.tif', '.tiff'];
const SEL = [
  { language: 'latex', scheme: 'file', pattern: '**/*.tex' },
  { language: 'latex', scheme: 'file', pattern: '**/*.tikz' },
  { language: 'tex', scheme: 'file', pattern: '**/*.tex' },
  { scheme: 'file', pattern: '**/*.tikz' }
];
const SEL_ANY = [{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }];
const REF_CTX = new RegExp('\\\\(?:' + P.REF_CMDS + ')\\*?\\{([^}]*)$');

const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
const isTexDoc = (doc) =>
  doc.languageId === 'latex' || doc.languageId === 'tex' || doc.uri.fsPath.toLowerCase().endsWith('.tikz');
const info = (m) => vscode.window.showInformationMessage(m);

/* ------------------------------ helpers ------------------------------ */
function docLines(doc) {
  const a = [];
  for (let i = 0; i < doc.lineCount; i++) a.push(doc.lineAt(i).text);
  return a;
}
const linesOf = (doc, s, e) => docLines(doc).slice(s, e + 1);

async function replaceLines(ed, s, e, newLines) {
  const doc = ed.document;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const range = new vscode.Range(s, 0, e, doc.lineAt(e).text.length);
  await ed.edit((b) => b.replace(range, newLines.join(eol)));
}

// selected lines, or the paragraph around the cursor
function chunkRange(ed) {
  const doc = ed.document;
  if (!ed.selection.isEmpty) {
    const s = ed.selection.start.line;
    let e = ed.selection.end.line;
    if (ed.selection.end.character === 0 && e > s) e--;
    return { startLine: s, endLine: e };
  }
  const cur = ed.selection.active.line;
  if (P.lineKind(doc.lineAt(cur).text) === 'hard') {
    info('Постав курсор в абзац або виділи рядки.');
    return null;
  }
  let s = cur;
  let e = cur;
  while (s > 0 && P.canJoin(doc.lineAt(s - 1).text, doc.lineAt(s).text)) s--;
  while (e + 1 < doc.lineCount && P.canJoin(doc.lineAt(e).text, doc.lineAt(e + 1).text)) e++;
  return { startLine: s, endLine: e };
}

function listFiles(root, exts, depth, rel) {
  rel = rel || '';
  let out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (depth > 0) out = out.concat(listFiles(root, exts, depth - 1, r));
    } else if (exts.includes(path.extname(e.name).toLowerCase())) {
      out.push(r);
    }
  }
  return out;
}

function textOf(uri) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch (e) { return ''; }
}
const baseOf = (p) => path.basename(p, path.extname(p));
const texFiles = () => vscode.workspace.findFiles('**/*.{tex,tikz}', EXCLUDE, 3000);

/* --------------------- wrap / typography / sentences ----------------- */
async function transformParagraph(fn, doneMessage) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const r = chunkRange(ed);
  if (!r) return;
  const old = linesOf(ed.document, r.startLine, r.endLine);
  const res = fn(old, ed);
  if (res.lines.length === old.length && res.lines.every((l, i) => l === old[i])) {
    vscode.window.setStatusBarMessage('Нічого змінювати', 2000);
    return;
  }
  await replaceLines(ed, r.startLine, r.endLine, res.lines);
  if (doneMessage) info(doneMessage(res));
}

const wrapParagraph = () =>
  transformParagraph((old, ed) => {
    const tab = typeof ed.options.tabSize === 'number' ? ed.options.tabSize : 4;
    return { lines: P.wrapLines(old, cfg().get('wrapWidth', 90), tab) };
  });

const typographyCmd = () =>
  transformParagraph(
    (old) => {
      const r = P.typography(old.join('\n'), { quotes: cfg().get('quoteStyle', 'guillemets') });
      return { lines: r.text.split('\n'), count: r.count };
    },
    (r) => 'Типографіку виправлено: ' + r.count + ' місць'
  );

const sentencesCmd = () => transformParagraph((old) => ({ lines: P.sentenceLines(old) }));

/* ----------------------------- table ops ----------------------------- */
function findTableBlock(ed) {
  const doc = ed.document;
  if (!ed.selection.isEmpty) return chunkRange(ed);
  const blk = P.tableBlockLines(docLines(doc), ed.selection.active.line);
  if (!blk || blk.endLine < blk.startLine) {
    info('Постав курсор усередину таблиці (tblr, tabular, align...) або виділи рядки.');
    return null;
  }
  return blk;
}

async function tableOps() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const blk = findTableBlock(ed);
  if (!blk) return;
  const items = [
    { label: 'Додати стовпчик праворуч від поточного', op: 'addRight' },
    { label: 'Додати стовпчик ліворуч від поточного', op: 'addLeft' },
    { label: 'Видалити поточний стовпчик', op: 'delete' },
    { label: 'Сортувати рядки за поточним стовпчиком (перший рядок лишається заголовком)', op: 'sort' },
    { label: 'Транспонувати таблицю', op: 'transpose' }
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Дія з таблицею' });
  if (!pick) return;
  const old = linesOf(ed.document, blk.startLine, blk.endLine);
  const idx = ed.selection.active.line - blk.startLine;
  const col = idx >= 0 && idx < old.length ? P.colAt(old[idx], ed.selection.active.character) : 0;
  const res = P.tableOp(old, pick.op, col);
  if (res.error) { vscode.window.showWarningMessage(res.error); return; }
  await replaceLines(ed, blk.startLine, blk.endLine, P.alignLines(res.lines));
  if (pick.op !== 'sort') info('Оновлено вміст таблиці. Специфікацію стовпців (colspec / {ccc}) перевір і зміни вручну.');
}

/* --------------------------- environments ---------------------------- */
// \[ ... \]  ->  \begin{equation*} ... \end{equation*}: on the selection, else on the display formula under the cursor
function displayBlockAround(lines, cur) {
  const has = (l, ch) => {
    const code = P.codePart(l);
    for (let c = 0; c < code.length - 1; c++) {
      if (code[c] !== '\\') continue;
      if (code[c + 1] === ch) return true;
      c++;
    }
    return false;
  };
  let s = cur;
  while (s >= 0 && cur - s <= 100 && !has(lines[s], '[')) {
    if (s < cur && has(lines[s], ']')) return null; // closed above the cursor: not inside a formula
    s--;
  }
  if (s < 0 || !has(lines[s], '[')) return null;
  if (s < cur && has(lines[s], ']')) return null; // that formula is closed above the cursor
  let e = Math.max(cur, s);
  while (e < lines.length && e - s <= 100 && !has(lines[e], ']')) e++;
  if (e >= lines.length || !has(lines[e], ']')) return null;
  return { s, e };
}

async function displayToEquation() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const all = docLines(ed.document);
  let s;
  let e;
  if (!ed.selection.isEmpty) {
    s = ed.selection.start.line;
    e = ed.selection.end.line;
    if (ed.selection.end.character === 0 && e > s) e--;
  } else {
    const blk = displayBlockAround(all, ed.selection.active.line);
    if (!blk) { info('Постав курсор усередину \\[ ... \\] або виділи рядки з такими формулами.'); return; }
    s = blk.s;
    e = blk.e;
  }
  const res = P.displayMathToEquation(all.slice(s, e + 1));
  if (!res.count) { info('Формул \\[ ... \\] для заміни не знайдено.'); return; }
  await replaceLines(ed, s, e, res.lines);
  vscode.window.setStatusBarMessage('\\[ ... \\] → equation*: ' + res.count, 3000);
}

async function convertEnv() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const items = P.CONVERTIBLE.map((n) => ({ label: n, choice: n })).concat([
    { label: '+ додати \\label{eq:}', choice: '+label' },
    { label: '− прибрати \\label', choice: '-label' }
  ]);
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Перетворити середовище формули' });
  if (!pick) return;
  const res = P.convertEnv(docLines(ed.document), ed.selection.active.line, pick.choice);
  if (res.error) { vscode.window.showWarningMessage(res.error); return; }
  await ed.edit((b) => {
    for (const e of res.edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.text);
  });
}


/* ---------------------------- section frames ------------------------- */
/* ---------------------- change preview (diff) ------------------------ */
const PREVIEW_SCHEME = 'tssworkflow-preview';
const previewDocs = new Map();
let previewSeq = 0;
const previewProvider = {
  provideTextDocumentContent(uri) { return previewDocs.get(uri.toString()) || ''; }
};

async function closePreview(uri) {
  const tg = vscode.window.tabGroups;
  if (tg && tg.all) {
    for (const g of tg.all) {
      for (const t of g.tabs) {
        const inp = t.input;
        if (inp && inp.modified && inp.modified.toString() === uri.toString()) { await tg.close(t); return; }
      }
    }
    return;
  }
  const a = vscode.window.activeTextEditor;
  if (a && a.document.uri.toString() === uri.toString()) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

// replaces lines s..e with newLines, optionally after a side-by-side preview; returns true if applied
async function applyWithPreview(ed, s, e, newLines, title, summary) {
  const doc = ed.document;
  const oldLines = linesOf(doc, s, e);
  if (newLines.length === oldLines.length && newLines.every((l, i) => l === oldLines[i])) return false;
  if (!cfg().get('previewChanges', true)) { await replaceLines(ed, s, e, newLines); return true; }
  const all = docLines(doc);
  const full = all.slice(0, s).concat(newLines, all.slice(e + 1));
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const right = vscode.Uri.parse(PREVIEW_SCHEME + ':/' + encodeURIComponent(path.basename(doc.uri.fsPath)) + '?' + (++previewSeq));
  previewDocs.set(right.toString(), full.join(eol));
  const version = doc.version;
  await vscode.commands.executeCommand('vscode.diff', doc.uri, right, title + ': перегляд змін (ліворуч поточний, праворуч новий текст)', { preview: true });
  const pick = await vscode.window.showInformationMessage(summary, 'Застосувати', 'Скасувати');
  await closePreview(right);
  previewDocs.delete(right.toString());
  if (pick !== 'Застосувати') return false;
  if (doc.version !== version) { info('Файл змінився під час перегляду, зміни не застосовано.'); return false; }
  const ed2 = await vscode.window.showTextDocument(doc, { viewColumn: ed.viewColumn, preserveFocus: false });
  await replaceLines(ed2, s, e, newLines);
  return true;
}

function wholeOrSelection(ed) {
  const doc = ed.document;
  let s = 0;
  let e = doc.lineCount - 1;
  let scope = 'у файлі';
  if (!ed.selection.isEmpty) {
    s = ed.selection.start.line;
    e = ed.selection.end.line;
    if (ed.selection.end.character === 0 && e > s) e--;
    scope = 'у виділенні';
  }
  return { s, e, scope };
}

/* ---------------------------- frames, normalize ---------------------- */
// frame look from settings: tssworkflow.frameRules (rule line per kind) and tssworkflow.frameBlankLines
function frameSettings() {
  const raw = cfg().get('frameRules', {}) || {};
  const rules = {};
  const bad = [];
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') continue;
    if (v.trim() === '' || P.isRuleLine(v)) rules[k] = v;
    else bad.push(k);
  }
  if (bad.length) info('tssworkflow.frameRules: «' + bad.join('», «') + '» пропущено. Рядок має бути коментарем із 8 і більше однакових символів - = * # _ ~ . , наприклад "%% ---------".');
  return { rules, opts: { blank: cfg().get('frameBlankLines', true), envs: cfg().get('frameEnvironments', []) || [] } };
}

// replace = true ("Re-frame"): the rule lines that already stand next to a block are swapped for the current look
async function frameSectionsCmd(replace) {
  replace = replace === true;
  const ed = vscode.window.activeTextEditor;
  if (!ed) { info('Відкрий .tex-файл.'); return; }
  const { s, e, scope } = wholeOrSelection(ed);
  const fs0 = frameSettings();
  const res = P.frameSections(linesOf(ed.document, s, e), fs0.rules, Object.assign({}, fs0.opts, { replace }));
  const st = res.stat;
  if (!res.count) {
    const why = st.found
      ? 'знайдено ' + st.found + ', уже обрамлено ' + st.already + (st.skipped ? ', пропущено ' + st.skipped + ' (текст у тому ж рядку)' : '')
      : 'заголовків і формульних середовищ ' + scope + ' не знайдено';
    info((replace ? 'Нічого перебудовувати: ' : 'Нічого обрамляти: ') + why + '.');
    return;
  }
  const title = replace ? 'Переобрамлення' : 'Обрамлення';
  const sum = title + ': заголовків ' + st.sections + ', формул ' + st.equations + (replace && st.replaced ? '; замінено старих рамок: ' + st.replaced : '') + (st.already ? '; уже були обрамлені: ' + st.already : '') + (st.skipped ? '; пропущено: ' + st.skipped : '') + '.';
  if (await applyWithPreview(ed, s, e, res.lines, title, sum)) vscode.window.setStatusBarMessage(sum, 4000);
}

// the steps of "Normalize file" and their settings (see also normalizeOptions)
const NORM_STEPS = [
  { key: 'normalizeTypography', label: 'Типографіка (~, ---, «»)' },
  { key: 'displayMathToEquation', label: 'Формули \\[ ... \\] → equation*' },
  { key: 'normalizeTables', label: 'Вирівнювання таблиць по &' },
  { key: 'normalizeFrames', label: 'Обрамлення заголовків і формул' },
  { key: 'normalizeBlankLines', label: 'Порожні рядки (між абзацами й навколо заголовків)' }
];
const LINE_MODES = { keep: 'переноси рядків не чіпати', join: 'рядки абзацу склеювати', wrap: 'рядки переносити за шириною' };

async function normalizeCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { info('Відкрий .tex-файл.'); return; }
  const { s, e } = wholeOrSelection(ed);
  const c = cfg();
  const mode = c.get('normalizeLineBreaks', 'keep');
  const framesOn = c.get('normalizeFrames', true);
  const fs1 = framesOn ? frameSettings() : null;
  const old = linesOf(ed.document, s, e);
  const res = P.normalizeLines(old, {
    typography: c.get('normalizeTypography', true),
    quotes: c.get('quoteStyle', 'guillemets'),
    displayMath: c.get('displayMathToEquation', true),
    tables: c.get('normalizeTables', true),
    lineBreaks: mode,
    wrapWidth: c.get('wrapWidth', 90),
    tabSize: typeof ed.options.tabSize === 'number' ? ed.options.tabSize : 4,
    frames: fs1,
    blankLines: c.get('normalizeBlankLines', true)
      ? { paragraph: c.get('blankLinesParagraph', 1), heading: c.get('blankLinesHeading', 2) }
      : null,
    isTikz: ed.document.uri.fsPath.toLowerCase().endsWith('.tikz')
  });
  const st = res.stats;
  const parts = [];
  if (c.get('normalizeTypography', true)) parts.push('типографія ' + st.typography);
  if (c.get('displayMathToEquation', true)) parts.push('\\[...\\] → equation* ' + st.displayMath);
  if (c.get('normalizeTables', true)) parts.push('таблиць вирівняно ' + st.tables);
  if (mode === 'join' || mode === 'wrap') parts.push((mode === 'join' ? 'склеєно рядків ' : 'змінено рядків ') + st.lineBreaks);
  if (framesOn) parts.push('обрамлено ' + st.frames);
  if (c.get('normalizeBlankLines', true)) parts.push('проміжків між абзацами й заголовками ' + st.blank);
  const sum = 'Нормалізація: ' + (parts.join(', ') || 'жодного кроку не ввімкнено') + '.';
  if (await applyWithPreview(ed, s, e, res.lines, 'Нормалізація', sum)) vscode.window.setStatusBarMessage(sum, 4000);
  else if (res.lines.length === e - s + 1 && res.lines.every((l, i) => l === ed.document.lineAt(s + i).text)) info('Нормалізація: змін немає.' + (ed.document.uri.fsPath.toLowerCase().endsWith('.tikz') ? ' У .tikz-файлах переноси рядків і порожні рядки не змінюються.' : ' (' + LINE_MODES[mode] + ')'));
}

// writes a setting where it is currently defined (folder, workspace, else user settings)
async function setCfg(key, value) {
  const c = cfg();
  const ins = c.inspect(key);
  const target = ins && ins.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : ins && ins.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}

// quick pick: which steps Normalize runs and what it does with line breaks
async function normalizeOptions() {
  const c = cfg();
  const items = NORM_STEPS.map((x) => ({ label: x.label, key: x.key, picked: c.get(x.key, true) }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Що виконує Normalize file (відміть потрібне, Esc скасовує)' });
  if (!picked) return;
  const cur = c.get('normalizeLineBreaks', 'keep');
  const modes = [
    { label: 'Не чіпати переноси рядків', v: 'keep' },
    { label: 'Склеїти рядки кожного абзацу в один', v: 'join' },
    { label: 'Переносити рядки за шириною (tssworkflow.wrapWidth)', v: 'wrap' }
  ].map((m) => Object.assign(m, { description: m.v === cur ? 'зараз' : '' }));
  const m = await vscode.window.showQuickPick(modes, { placeHolder: 'Переноси рядків у Normalize file' });
  if (!m) return;
  let width = c.get('wrapWidth', 90);
  if (m.v === 'wrap') {
    const w = await vscode.window.showInputBox({
      prompt: 'Ширина рядка (символів)',
      value: String(width),
      validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 20 ? null : 'Ціле число, не менше 20')
    });
    if (w === undefined) return;
    width = Number(w);
  }
  const curQ = c.get('quoteStyle', 'guillemets');
  const quoteModes = [
    { label: 'Лапки «...»', description: '"..." і ``...\'\' стають «...»', v: 'guillemets' },
    { label: 'Лапки \\enquote{...}', description: '"...", <<...>>, «...» стають \\enquote{...} (потрібен csquotes)', v: 'enquote' },
    { label: 'Лапки не чіпати', description: '', v: 'keep' }
  ].map((q) => Object.assign(q, { detail: q.v === curQ ? 'зараз' : undefined }));
  const q = await vscode.window.showQuickPick(quoteModes, { placeHolder: 'Лапки в типографіці й Normalize file' });
  if (!q) return;
  const on = new Set(picked.map((x) => x.key));
  for (const x of NORM_STEPS) await setCfg(x.key, on.has(x.key));
  await setCfg('normalizeLineBreaks', m.v);
  await setCfg('quoteStyle', q.v);
  if (m.v === 'wrap') await setCfg('wrapWidth', width);
  info('Normalize file: ' + [...on].length + ' з ' + NORM_STEPS.length + ' кроків, ' + LINE_MODES[m.v] + (m.v === 'wrap' ? ' (' + width + ')' : '') + '.');
}

/* ------------------------------- labels ------------------------------ */
let labelCache = null;
let labelDirty = true;

async function buildIndex(force) {
  if (!labelCache || labelDirty || force) {
    const m = new Map();
    for (const f of await texFiles()) m.set(f.fsPath, P.scanLabelsAndRefs(textOf(f), baseOf(f.fsPath)));
    labelCache = m;
    labelDirty = false;
  }
  return labelCache;
}

const refCompletion = {
  async provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const m = REF_CTX.exec(before);
    if (!m) return undefined;
    const typed = m[1].slice(m[1].lastIndexOf(',') + 1);
    const lead = typed.length - typed.trimStart().length;
    const range = new vscode.Range(pos.line, pos.character - typed.length + lead, pos.line, pos.character);
    const idx = await buildIndex(false);
    const here = P.scanLabelsAndRefs(doc.getText(), baseOf(doc.uri.fsPath));
    const items = [];
    const seen = new Set();
    const add = (l, file, rank) => {
      if (seen.has(l.name)) return;
      seen.add(l.name);
      const it = new vscode.CompletionItem(l.name, vscode.CompletionItemKind.Reference);
      it.detail = path.basename(file) + ':' + (l.line + 1);
      it.documentation = l.ctx || '';
      it.range = range;
      it.filterText = l.name;
      it.sortText = rank + '_' + l.name;
      items.push(it);
    };
    here.labels.forEach((l) => add(l, doc.uri.fsPath, '0'));
    for (const [file, data] of idx) {
      if (file === doc.uri.fsPath) continue;
      const near = path.dirname(file) === path.dirname(doc.uri.fsPath) ? '1' : '2';
      data.labels.forEach((l) => add(l, file, near));
    }
    return items;
  }
};

const renameProvider = {
  prepareRename(doc, pos) {
    const hit = P.labelAtPos(doc.lineAt(pos.line).text, pos.character);
    if (!hit) throw new Error('Постав курсор на назву мітки (\\label або \\ref).');
    return { range: new vscode.Range(pos.line, hit.col, pos.line, hit.col + hit.len), placeholder: hit.name };
  },
  async provideRenameEdits(doc, pos, newName) {
    const hit = P.labelAtPos(doc.lineAt(pos.line).text, pos.character);
    if (!hit) return undefined;
    if (!/^[^\s{},%\\]+$/.test(newName)) throw new Error('Назва мітки не може містити пробіли, {}, кому, % або \\.');
    const idx0 = await buildIndex(false);
    for (const data of idx0.values()) {
      if (data.labels.some((l) => l.macro && l.name === hit.name)) throw new Error('Ця мітка задана макросом \\currfilebase: перейменуй файл, а не мітку.');
    }
    const edit = new vscode.WorkspaceEdit();
    const files = await texFiles();
    if (!files.some((f) => f.fsPath === doc.uri.fsPath)) files.push(doc.uri);
    for (const f of files) {
      const text = textOf(f);
      if (!text.includes(hit.name)) continue;
      for (const p of P.renamePositions(text, hit.name)) {
        edit.replace(f, new vscode.Range(p.line, p.col, p.line, p.col + p.len), newName);
      }
    }
    labelDirty = true;
    return edit;
  }
};

const diagLabels = vscode.languages.createDiagnosticCollection('tssworkflow-labels');

async function checkLabels(showMessage) {
  const idx = await buildIndex(true);
  const defs = new Map();
  const used = new Set();
  for (const [file, data] of idx) {
    for (const l of data.labels) {
      if (!defs.has(l.name)) defs.set(l.name, []);
      defs.get(l.name).push({ file, l });
    }
    for (const r of data.refs) used.add(r.name);
  }
  const byFile = new Map();
  const add = (file, l, message, sev, code) => {
    if (!byFile.has(file)) byFile.set(file, []);
    const d = new vscode.Diagnostic(new vscode.Range(l.line, l.col, l.line, l.col + l.len), message, sev);
    d.source = 'TSS Workflow';
    d.code = code;
    byFile.get(file).push(d);
  };
  let dup = 0;
  let undef = 0;
  let unused = 0;
  let badPrefix = 0;
  for (const [name, arr] of defs) {
    if (arr.length > 1) {
      dup++;
      arr.forEach((x) => add(x.file, x.l, 'Мітка «' + name + '» визначена ' + arr.length + ' разів', vscode.DiagnosticSeverity.Error, 'label-duplicate'));
    }
  }
  for (const [file, data] of idx) {
    for (const r of data.refs) {
      if (!defs.has(r.name)) {
        undef++;
        add(file, r, 'Мітку «' + r.name + '» не знайдено в проєкті', vscode.DiagnosticSeverity.Warning, 'label-undefined');
      }
    }
  }
  // labels nobody refers to, and label prefixes by environment
  const sevName = cfg().get('unusedLabels', 'hint');
  const sevMap = { hint: vscode.DiagnosticSeverity.Hint, information: vscode.DiagnosticSeverity.Information, warning: vscode.DiagnosticSeverity.Warning };
  const prefixes = cfg().get('labelPrefixes', {}) || {};
  for (const [file, data] of idx) {
    for (const l of data.labels) {
      if (l.macro) continue;
      if (sevMap[sevName] !== undefined && !used.has(l.name)) {
        unused++;
        add(file, l, 'Мітка «' + l.name + '» ніде не використана', sevMap[sevName], 'label-unused');
      }
      for (let i = l.envs.length - 1; i >= 0; i--) {
        const pre = prefixes[l.envs[i]];
        if (typeof pre !== 'string') continue;
        if (pre && !l.name.startsWith(pre)) {
          badPrefix++;
          add(file, l, 'Мітка в «' + l.envs[i] + '» має починатися з «' + pre + '»', vscode.DiagnosticSeverity.Warning, 'label-prefix');
        }
        break;
      }
    }
  }
  diagLabels.clear();
  for (const [file, ds] of byFile) diagLabels.set(vscode.Uri.file(file), ds);
  if (showMessage) {
    info('Мітки: дублікатів ' + dup + ', невизначених посилань ' + undef + ', без використання ' + unused + ', з неправильним префіксом ' + badPrefix + ' (див. Problems).');
  }
}

/* ------------------- project .vscode/settings.json -------------------- */
// Creates .vscode/settings.json from the template (P.PROJECT_SETTINGS_TEMPLATE or the file in tssworkflow.projectSettingsTemplate);
// if the file exists, only the missing top-level keys are added. `arg` may be the folder path (from the prompt on opening).
async function initProjectSettings(arg) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) { info('Відкрий папку проєкту: .vscode/settings.json створюється в робочій папці.'); return; }
  let folder = typeof arg === 'string' ? folders.find((f) => f.uri.fsPath === arg) : undefined;
  if (!folder && folders.length === 1) folder = folders[0];
  if (!folder) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: 'У якій папці створити .vscode/settings.json?' }
    );
    if (!pick) return;
    folder = pick.folder;
  }
  const file = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
  if (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file && d.isDirty)) {
    vscode.window.showWarningMessage('.vscode/settings.json має незбережені зміни. Збережи або закрий його і повтори.');
    return;
  }
  const exists = fs.existsSync(file);
  const existing = exists ? fs.readFileSync(file, 'utf8') : '';
  let tpl = null;
  const tplPath = String(cfg().get('projectSettingsTemplate', '') || '').trim();
  if (tplPath) {
    // the user's own template: used as it is
    try {
      tpl = JSON.parse(P.dropTrailingCommas(P.stripJsonc(fs.readFileSync(tplPath, 'utf8').replace(/^\uFEFF/, ''))));
      if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw new Error('шаблон має бути JSON-об\'єктом');
    } catch (err) {
      vscode.window.showWarningMessage('Не вдалося прочитати шаблон «' + tplPath + '»: ' + (err && err.message ? err.message : err));
      return;
    }
  } else {
    // built-in template: main file = the only .tex of the root, else main.tex, else ask
    const cur = P.parseSettings(existing) || {};
    let mainFile = typeof cur['tssworkflow.mainFile'] === 'string' && cur['tssworkflow.mainFile'] ? cur['tssworkflow.mainFile'] : null;
    if (!mainFile) {
      let names = [];
      try { names = fs.readdirSync(folder.uri.fsPath); } catch (e) { names = []; }
      const r = P.pickMainTex(names, cfg().get('driver', 'alone.tex'));
      if (r.choose) {
        const pick = await vscode.window.showQuickPick(
          r.choose.map((n) => ({ label: n })),
          { placeHolder: 'У папці кілька .tex і немає main.tex. Який файл головний (mainFile)?' }
        );
        if (!pick) return;
        mainFile = pick.label;
      } else {
        mainFile = r.file;
      }
    }
    // .sty/.cls in subfolders (the ones in the root are found through the preamble of the main file)
    let macroFiles = [];
    try {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{sty,cls}'), EXCLUDE, 60);
      macroFiles = found.map((u) => path.relative(folder.uri.fsPath, u.fsPath).split(path.sep).join('/'))
        .filter((p) => p.includes('/')).sort().slice(0, 10);
    } catch (e) { macroFiles = []; }
    tpl = P.buildProjectSettings({
      mainFile,
      macroFiles,
      texlogsieve: !!P.findInPath(String(cfg().get('texlogsieveCommand', 'texlogsieve') || 'texlogsieve'))
    });
  }
  const res = P.mergeMissingSettings(existing, tpl, tplPath ? null : P.PROJECT_SETTINGS_COMMENTS);
  if (res.error) { vscode.window.showWarningMessage('.vscode/settings.json: ' + res.error + '. Файл не змінено.'); return; }
  if (exists && !res.added.length) {
    info('У .vscode/settings.json уже є всі ключі шаблону.');
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return;
  }
  if (exists) {
    const ok = await vscode.window.showInformationMessage(
      'У .vscode/settings.json немає ' + res.added.length + ' ключів шаблону: ' + res.added.slice(0, 4).join(', ') + (res.added.length > 4 ? ', …' : '') + '. Додати їх? Наявні ключі й коментарі не чіпаються.',
      'Додати', 'Скасувати'
    );
    if (ok !== 'Додати') return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, res.text, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  info((exists ? 'Додано ключів: ' : 'Створено .vscode/settings.json, ключів: ') + res.added.length + '.');
}

/* ------------------------------ citations ---------------------------- */
const diagCites = vscode.languages.createDiagnosticCollection('tssworkflow-cites');
let bibKeyCache = [];

// \cite keys against the .bib files of the workspace: undefined keys (in .tex), duplicate and unused entries (in .bib)
async function checkCitations(showMessage) {
  diagCites.clear();
  if (!cfg().get('citationChecks', true)) return;
  const bibs = await vscode.workspace.findFiles('**/*.bib', EXCLUDE, 200);
  if (!bibs.length) {
    if (showMessage) info('У проєкті немає .bib файлів: перевіряти нічого.');
    return;
  }
  const keys = new Map();
  for (const f of bibs) {
    for (const k of P.parseBibKeys(textOf(f))) {
      if (!keys.has(k.name)) keys.set(k.name, []);
      keys.get(k.name).push({ file: f.fsPath, k });
    }
  }
  bibKeyCache = [...keys.keys()];
  const byFile = new Map();
  const add = (file, x, message, sev, code) => {
    if (!byFile.has(file)) byFile.set(file, []);
    const d = new vscode.Diagnostic(new vscode.Range(x.line, x.col, x.line, x.col + x.len), message, sev);
    d.source = 'TSS Workflow';
    d.code = code;
    byFile.get(file).push(d);
  };
  const used = new Set();
  let nociteAll = false;
  let undef = 0;
  let dup = 0;
  let unused = 0;
  for (const f of await texFiles()) {
    const r = P.scanCites(textOf(f));
    if (r.nociteAll) nociteAll = true;
    for (const c of r.cites) {
      used.add(c.name);
      if (!keys.has(c.name)) {
        undef++;
        add(f.fsPath, c, 'Ключа «' + c.name + '» немає в .bib файлах проєкту', vscode.DiagnosticSeverity.Warning, 'cite-undefined');
      }
    }
  }
  for (const [name, arr] of keys) {
    if (arr.length > 1) {
      dup++;
      arr.forEach((x) => add(x.file, x.k, 'Ключ «' + name + '» у .bib визначений ' + arr.length + ' разів', vscode.DiagnosticSeverity.Warning, 'bib-duplicate'));
    }
  }
  const sevName = cfg().get('unusedBibEntries', 'hint');
  if (SEV[sevName] !== undefined && sevName !== 'error' && !nociteAll) {
    for (const [name, arr] of keys) {
      if (used.has(name)) continue;
      unused++;
      add(arr[0].file, arr[0].k, 'Запис «' + name + '» ніде не цитується', SEV[sevName], 'bib-unused');
    }
  }
  for (const [file, ds] of byFile) diagCites.set(vscode.Uri.file(file), ds);
  if (showMessage) {
    info('Цитування: невизначених ключів ' + undef + ', дублікатів у .bib ' + dup + ', нецитованих записів ' + unused +
      (nociteAll ? ' (є \\nocite{*}: нецитовані не рахуються)' : '') + ' (див. Problems).');
  }
}

/* ------------------------- LTeX: project dictionary ------------------- */
// Collects the spelling hits of the LTeX extension (it checks only the files that are open), lets the user pick
// words and adds them to the user setting ltex.dictionary for the language of ltex.language.
async function ltexDictionary() {
  const counts = new Map();
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      if (!/ltex/i.test(String(d.source || ''))) continue;
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      const isSpell = /MORFOLOGIK|HUNSPELL|SPELL/i.test(String(code || '')) || /spell|орфограф|правопис/i.test(d.message);
      if (!isSpell) continue;
      const doc = vscode.workspace.textDocuments.find((x) => x.uri.toString() === uri.toString());
      const word = (doc ? doc.getText(d.range) : textOf(uri).split(/\r?\n/)[d.range.start.line].slice(d.range.start.character, d.range.end.character)).trim();
      if (word && !/\s/.test(word)) counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  if (!counts.size) {
    info('Орфографічних діагностик LTeX немає. LTeX перевіряє лише відкриті файли: відкрий потрібні розділи й зачекай кінця перевірки.');
    return;
  }
  const lang = String(vscode.workspace.getConfiguration('ltex').get('language', 'en-US'));
  if (lang === 'auto') { info('Для ltex.language = "auto" невідомо, до якої мови додавати слова. Вкажи конкретну мову, напр. uk-UA.'); return; }
  const items = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 300)
    .map(([w, n]) => ({ label: w, description: '×' + n }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Слова для ltex.dictionary (' + lang + ')', placeHolder: 'Познач слова, які треба вважати правильними' });
  if (!picked || !picked.length) return;
  const conf = vscode.workspace.getConfiguration('ltex');
  const cur = conf.inspect('dictionary');
  const next = Object.assign({}, (cur && cur.globalValue) || {});
  next[lang] = [...new Set([...(next[lang] || []), ...picked.map((p) => p.label)])];
  await conf.update('dictionary', next, vscode.ConfigurationTarget.Global);
  info('До ltex.dictionary (' + lang + ', User settings) додано слів: ' + picked.length + '. LTeX може перевірити файли заново з затримкою.');
}

/* --------------------------- quick error checks ---------------------- */
const X5sub = (m, d) => { try { return require('./filesAndLabels').legacySub(m, d); } catch (e) { return d; } };
const diagSyntax = vscode.languages.createDiagnosticCollection('tssworkflow');

function existsFor(doc) {
  const dir = path.dirname(doc.uri.fsPath);
  if (path.basename(dir).toLowerCase() === 'tikz') return undefined; // paths inside tikz files are not resolved here
  return (kind, name) => {
    if (kind === 'tikz') {
      const b = path.join(dir, X5sub('\\localinput', 'tikz'), name);
      return fs.existsSync(b) || (!path.extname(name) && (fs.existsSync(b + '.tikz') || fs.existsSync(b + '.tex')));
    }
    const b = path.join(dir, X5sub('\\includegraphics', 'Pictures'), name);
    if (fs.existsSync(b)) return true;
    return !path.extname(name) && PIC_EXTS.some((e) => fs.existsSync(b + e));
  };
}

const SEV = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint
};

function checkSyntax(doc) {
  if (!isTexDoc(doc) || !cfg().get('diagnostics', true)) { diagSyntax.delete(doc.uri); return; }
  const lines = docLines(doc);
  const issues = P.syntaxChecks(lines, existsFor(doc));
  // figure without \caption / \label, and the user's own rules (tssworkflow.lintRules)
  const figSev = cfg().get('figureChecks', 'information');
  if (SEV[figSev] !== undefined) P.figureChecks(lines).forEach((x) => issues.push(Object.assign({ severity: figSev }, x)));
  issues.push(...P.lintRules(lines, cfg().get('lintRules', []), doc.uri.fsPath));
  const typoSev = cfg().get('typographyChecks', 'hint');
  if (SEV[typoSev] !== undefined) {
    X.typographyChecks(lines, { mixedMacros: cfg().get('mixedMacros', [['vec', 'vect']]) })
      .forEach((x) => issues.push(Object.assign({ severity: typoSev }, x)));
  }
  diagSyntax.set(
    doc.uri,
    issues.map((x) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(x.line, x.col, x.line, x.col + x.len),
        x.message,
        SEV[x.severity] !== undefined ? SEV[x.severity] : vscode.DiagnosticSeverity.Warning
      );
      d.source = 'TSS Workflow';
      d.code = x.code;
      return d;
    })
  );
}

/* --------------------------------- hovers ---------------------------- */
function labelPreviewMd(file, l, aux) {
  const lines = textOf(vscode.Uri.file(file)).split(/\r?\n/);
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**' + l.name + '**' + (aux ? '  ·  № ' + aux.num + (aux.page ? ', стор. ' + aux.page : '') : '') + '  \n' + path.basename(file) + ':' + (l.line + 1) + '\n\n');
  let body = null;
  if (l.envLine >= 0 && lines[l.envLine]) {
    const m = /\\begin\{([^{}]*)\}/.exec(lines[l.envLine]);
    if (m) {
      const end = P.envEnd(lines, m[1], l.envLine, m.index + m[0].length);
      if (end) {
        const block = lines.slice(l.envLine, end.line + 1);
        if (P.MATH_ENVS.has(m[1])) body = block.slice(0, 14);
        else {
          const ci = block.findIndex((x) => /\\caption/.test(x));
          body = ci >= 0 ? block.slice(ci, ci + 3) : block.slice(0, 4);
        }
      }
    }
  }
  if (!body) body = [l.ctx || ''];
  md.appendCodeblock(body.join('\n'), 'latex');
  return md;
}

const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function argAt(code, re, col) {
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[0].lastIndexOf('{') + 1;
    const len = m[1].length;
    if (col >= start && col <= start + len) return { name: m[1].trim(), start, len };
  }
  return null;
}

// hover on \includegraphics: name, size, a thumbnail (tssworkflow.imagePreviewMode / imagePreviewMaxMB) and a link that opens the file
function imageHoverMd(file) {
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: ['vscode.open'] };
  md.appendMarkdown('**' + path.basename(file) + '**  ·  ' + P.formatFileSize(size) + '\n\n');
  const cmdArgs = encodeURIComponent(JSON.stringify([vscode.Uri.file(file)]));
  const open = '[Відкрити зображення](command:vscode.open?' + cmdArgs + ')';
  if (!IMG_MIME[ext]) {
    md.appendMarkdown('Попередній перегляд для ' + ext + ' недоступний.  \n[Відкрити файл](command:vscode.open?' + cmdArgs + ')');
    return md;
  }
  const plan = P.imagePreviewPlan(size, cfg.get('imagePreviewMode', 'file'), cfg.get('imagePreviewMaxMB', 1));
  if (plan.kind === 'file') {
    md.appendMarkdown('![](' + vscode.Uri.file(file).toString() + ')\n\n' + open);
  } else if (plan.kind === 'data') {
    md.appendMarkdown('![](data:' + IMG_MIME[ext] + ';base64,' + fs.readFileSync(file).toString('base64') + ')\n\n' + open);
  } else if (plan.kind === 'too-big') {
    md.appendMarkdown('Завеликий для превʼю: ' + P.formatFileSize(size) + ', ліміт ' + String(plan.limitMB).replace('.', ',') + ' МБ (`tssworkflow.imagePreviewMaxMB`).  \n' + open);
  } else if (plan.kind === 'data-too-big') {
    md.appendMarkdown('У режимі `data` показуються лише файли до ' + P.formatFileSize(P.DATA_URI_MAX) + '. Постав `tssworkflow.imagePreviewMode` = `file`.  \n' + open);
  } else {
    md.appendMarkdown(open);
  }
  return md;
}

const hoverProvider = {
  async provideHover(doc, pos) {
    const line = doc.lineAt(pos.line).text;
    const base = baseOf(doc.uri.fsPath);
    const ref = P.scanLabelsAndRefs(line, base).refs.find((r) => pos.character >= r.col && pos.character <= r.col + r.len);
    if (ref) {
      let found = P.scanLabelsAndRefs(doc.getText(), base).labels.find((l) => l.name === ref.name);
      let file = doc.uri.fsPath;
      if (!found) {
        const idx = await buildIndex(false);
        for (const [fp, data] of idx) {
          const l = data.labels.find((x) => x.name === ref.name);
          if (l) { found = l; file = fp; break; }
        }
      }
      const range = new vscode.Range(pos.line, ref.col, pos.line, ref.col + ref.len);
      if (!found) return new vscode.Hover('Мітку «' + ref.name + '» не знайдено в проєкті', range);
      return new vscode.Hover(labelPreviewMd(file, found, require('./projectInfo').auxInfo(doc.uri, ref.name)), range);
    }
    const code = P.codePart(line);
    const dir = path.dirname(doc.uri.fsPath);
    const inc = argAt(code, /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g, pos.character);
    if (inc && inc.name) {
      const b = path.join(dir, X5sub('\\includegraphics', 'Pictures'), inc.name);
      const file = [b].concat(PIC_EXTS.map((e) => b + e)).find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
      const range = new vscode.Range(pos.line, inc.start, pos.line, inc.start + inc.len);
      if (!file) return new vscode.Hover('Файл не знайдено: Pictures/' + inc.name, range);
      return new vscode.Hover(imageHoverMd(file), range);
    }
    const lin = argAt(code, /\\localinput\{([^}]*)\}/g, pos.character);
    if (lin && lin.name) {
      const b = path.join(dir, X5sub('\\localinput', 'tikz'), lin.name);
      const file = [b, b + '.tikz', b + '.tex'].find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
      const range = new vscode.Range(pos.line, lin.start, pos.line, lin.start + lin.len);
      if (!file) return new vscode.Hover('Файл не знайдено: tikz/' + lin.name, range);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const md = new vscode.MarkdownString();
      md.appendMarkdown('**' + path.basename(file) + '**  (' + lines.length + ' рядків)\n\n');
      md.appendCodeblock(lines.slice(0, 15).join('\n') + (lines.length > 15 ? '\n...' : ''), 'latex');
      return new vscode.Hover(md, range);
    }
    return undefined;
  }
};

/* -------------------------- heading navigator ------------------------ */
async function goToHeading() {
  const ed = vscode.window.activeTextEditor;
  const folder = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { info('Відкрий папку проєкту.'); return; }
  const root = folder.uri.fsPath;
  const items = [];
  const seen = new Set();
  const walk = (fp) => {
    if (seen.has(fp) || !fs.existsSync(fp)) return;
    seen.add(fp);
    const lines = textOf(vscode.Uri.file(fp)).split(/\r?\n/);
    const events = P.scanHeadings(lines).map((h) => ({ line: h.line, h }));
    lines.forEach((l, i) => {
      const m = /^\s*\\includechapter\{([^}]*)\}/.exec(P.codePart(l));
      if (m) events.push({ line: i, inc: m[1].trim() });
    });
    events.sort((a, b) => a.line - b.line);
    for (const ev of events) {
      if (ev.h) items.push({ file: fp, h: ev.h });
      else walk(path.join(root, ev.inc, ev.inc + '.tex'));
    }
  };
  walk(path.join(root, (cfg().get('jobname', 'main') || 'main') + '.tex'));
  const rest = (await texFiles()).map((u) => u.fsPath).filter((p) => !seen.has(p) && p.startsWith(root)).sort();
  for (const fp of rest) walk(fp);
  if (!items.length) { info('Заголовків не знайдено.'); return; }
  const picks = items.map((it) => ({
    label: '\u00a0\u00a0'.repeat(Math.max(0, it.h.level - 1)) + it.h.title,
    description: it.h.kind + (it.h.star ? '*' : '') + ' · ' + path.relative(root, it.file).replace(/\\/g, '/') + ':' + (it.h.line + 1),
    it
  }));
  const pick = await vscode.window.showQuickPick(picks, { matchOnDescription: true, placeHolder: 'Перейти до заголовка (весь проєкт)' });
  if (!pick) return;
  const pos = new vscode.Position(pick.it.h.line, 0);
  await vscode.window.showTextDocument(vscode.Uri.file(pick.it.file), { selection: new vscode.Range(pos, pos) });
}

/* ------------------------- build log warnings ------------------------ */
const diagLog = vscode.languages.createDiagnosticCollection('tssworkflow-log');

const outLog = vscode.window.createOutputChannel('TSS Workflow');
// the second argument (VS Code 1.63+) gives the channel the language `tssreport`, coloured by syntaxes/tssreport.tmLanguage.json
const tlsLog = vscode.window.createOutputChannel('texlogsieve', 'tssreport');
let pplatexWarned = false;

function setLogDiagnostics(folder, items) {
  // logWarnings = false: keep only errors, whatever the log parser is
  if (!cfg().get('logWarnings', true)) items = items.filter((x) => x.severity === vscode.DiagnosticSeverity.Error);
  const by = new Map();
  const seen = new Set();
  const absent = new Set();
  let shown = 0;
  for (const it of items) {
    const fp = path.resolve(folder, it.file);
    const l0 = it.line === null || it.line === undefined ? 0 : it.line;
    // errors may span several lines; warnings (Overfull ... in paragraph at lines 31--319) mark only the first line
    const l1 = it.severity !== vscode.DiagnosticSeverity.Error || it.endLine === null || it.endLine === undefined ? l0 : Math.max(l0, it.endLine);
    const hint = P.logHint(it.message);
    const text = hint && !it.message.includes(hint) ? it.message + '. ' + hint : it.message;
    const key = fp + ':' + l0 + ':' + text;
    if (seen.has(key)) continue;
    if (!fs.existsSync(fp)) { absent.add(it.file); continue; }
    seen.add(key);
    shown++;
    const d = new vscode.Diagnostic(new vscode.Range(l0, 0, l1, 1000), text, it.severity);
    d.source = it.source;
    if (!by.has(fp)) by.set(fp, []);
    by.get(fp).push(d);
  }
  for (const [fp, ds] of by) diagLog.set(vscode.Uri.file(fp), ds);
  outLog.appendLine('[Problems] показано ' + shown + ' у ' + by.size + ' файлах' +
    (absent.size ? '; пропущено, бо файла немає на диску: ' + [...absent].slice(0, 5).join(', ') : ''));
}

// builtin: our own log parser (Overfull, undefined references); pplatex: output of `pplatex -i job.log`
function builtinLog(folder, job) {
  let log;
  try { log = fs.readFileSync(path.join(folder, job + '.log'), 'utf8'); } catch (e) { outLog.appendLine('[builtin] немає ' + job + '.log'); return; }
  const items = P.parseLog(log, cfg().get('overfullThreshold', 5)).map((it) => ({
    file: it.file, line: it.line, message: it.message, severity: vscode.DiagnosticSeverity.Warning, source: 'LaTeX log'
  }));
  // errors are read from the log as well, not only from the terminal output of latexmk
  for (const it of P.parseLogErrors(log)) {
    items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity: vscode.DiagnosticSeverity.Error, source: 'LaTeX log' });
  }
  outLog.appendLine('[builtin] ' + job + '.log: ' + items.length + ' записів');
  setLogDiagnostics(folder, items);
}

function pplatexLog(folder, job) {
  return new Promise((resolve) => {
    const cmd = String(cfg().get('pplatexCommand', 'ppluatex') || 'ppluatex').trim();
    const logPath = path.join(folder, job + '.log');
    if (!fs.existsSync(logPath)) { outLog.appendLine('[pplatex] немає ' + logPath + ': нічого розбирати'); resolve(); return; }
    cp.execFile(cmd, ['-i', logPath], { cwd: folder, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err && (err.code === 'ENOENT' || !stdout)) {
        if (!pplatexWarned) {
          pplatexWarned = true;
          vscode.window.showWarningMessage('pplatex не запустився («' + cmd + '»: ' + (err.message || err) +
            '). Використовую вбудований розбір логу. Перевір PATH або tssworkflow.pplatexCommand.');
        }
        builtinLog(folder, job);
        resolve();
        return;
      }
      const bb = cfg().get('pplatexBadBoxes', 'information');
      const sevOf = {
        hint: vscode.DiagnosticSeverity.Hint,
        information: vscode.DiagnosticSeverity.Information,
        warning: vscode.DiagnosticSeverity.Warning
      };
      const items = [];
      for (const it of P.parsePplatex(stdout, cfg().get('overfullThreshold', 5))) {
        let severity;
        if (it.kind === 'Error') severity = vscode.DiagnosticSeverity.Error;
        else if (it.kind === 'Warning') severity = vscode.DiagnosticSeverity.Warning;
        else if (bb === 'off') continue;
        else severity = sevOf[bb] === undefined ? vscode.DiagnosticSeverity.Information : sevOf[bb];
        items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity, source: 'pplatex' });
      }
      setLogDiagnostics(folder, items);
      resolve();
    });
  });
}

let texlogsieveWarned = false;

function texlogsieveLog(folder, job) {
  return new Promise((resolve) => {
    const cmd = String(cfg().get('texlogsieveCommand', 'texlogsieve') || 'texlogsieve').trim();
    const logPath = path.join(folder, job + '.log');
    if (!fs.existsSync(logPath)) { outLog.appendLine('[texlogsieve] немає ' + logPath + ': нічого розбирати'); resolve(); return; }
    let args = cfg().get('texlogsieveArgs', ['${log}']);
    if (!Array.isArray(args)) args = ['${log}'];
    args = args.map((a) => String(a).replace(/\$\{log\}/g, logPath));
    if (!args.some((a) => a === logPath)) args.push(logPath);
    cp.execFile(cmd, args, { cwd: folder, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err && (err.code === 'ENOENT' || !stdout)) {
        if (!texlogsieveWarned) {
          texlogsieveWarned = true;
          vscode.window.showWarningMessage('texlogsieve не запустився («' + cmd + '»: ' + (err.message || err) +
            '). Використовую вбудований розбір логу. Перевір PATH або tssworkflow.texlogsieveCommand.');
        }
        builtinLog(folder, job);
        resolve();
        return;
      }
      const bb = cfg().get('pplatexBadBoxes', 'information');
      const sevOf = {
        hint: vscode.DiagnosticSeverity.Hint,
        information: vscode.DiagnosticSeverity.Information,
        warning: vscode.DiagnosticSeverity.Warning
      };
      const inside = (fp) => { const r = path.relative(folder, fp); return r && !r.startsWith('..') && !path.isAbsolute(r); };
      const items = [];
      const report = [];
      let outside = 0;
      const parsed = P.parseTexlogsieve(stdout, cfg().get('overfullThreshold', 5));
      try { P.attachMissingLines(parsed, fs.readFileSync(logPath, 'utf8')); } catch (e) { /* no log: the page number is enough */ }
      for (const it of parsed) {
        // warnings from packages in the TeX tree (biblatex, microtype ...) are noise: keep project files only.
        // Errors are never dropped, wherever they were reported.
        if (it.kind !== 'Error' && !inside(path.resolve(folder, it.file))) { outside++; continue; }
        let severity;
        if (it.kind === 'Error') severity = vscode.DiagnosticSeverity.Error;
        else if (it.kind === 'Warning' || it.kind === 'Missing') severity = vscode.DiagnosticSeverity.Warning;
        else if (bb === 'off') continue;
        else severity = sevOf[bb] === undefined ? vscode.DiagnosticSeverity.Information : sevOf[bb];
        items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity, source: 'texlogsieve' });
        report.push({ kind: it.kind, file: it.file, line: it.line, message: it.message });
      }
      if (!items.some((x) => x.severity === vscode.DiagnosticSeverity.Error)) {
        // texlogsieve gave no errors: take them from the log itself
        try {
          for (const it of P.parseLogErrors(fs.readFileSync(logPath, 'utf8'))) {
            items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity: vscode.DiagnosticSeverity.Error, source: 'LaTeX log' });
            report.push({ kind: 'Error', file: it.file, line: it.line, message: it.message });
          }
        } catch (e) { /* no log */ }
      }
      outLog.appendLine('[texlogsieve] ' + cmd + ' ' + args.join(' ') + ' -> розібрано ' + parsed.length + ', показано ' + items.length +
        (outside ? ', відкинуто попереджень поза проєктом: ' + outside : '') + (err ? ', код виходу ' + err.code : ''));
      if (!parsed.length) outLog.appendLine('--- початок виводу texlogsieve ---\n' + String(stdout).slice(0, 1500) + '\n---');
      setLogDiagnostics(folder, items);
      showReportInTerminal(stdout, items);
      showReportInOutput(folder, job, report, outside);
      resolve();
    });
  });
}

// the same problems as in Problems, grouped by kind, in their own Output channel (file:line is clickable)
function showReportInOutput(folder, job, report, outside) {
  const mode = cfg().get('texlogsieveOutput', 'always');
  if (mode === 'off') return;
  const rel = (fp) => {
    const abs = path.resolve(folder, fp);
    const r = path.relative(folder, abs);
    return (r && !r.startsWith('..') && !path.isAbsolute(r)) ? r.split(path.sep).join('/') : abs;
  };
  const entries = report.map((e) => ({ kind: e.kind, file: rel(e.file), line: e.line, message: e.message }));
  const time = new Date().toTimeString().slice(0, 8);
  const lines = P.formatTexlogsieveReport(entries, { job, time, outside });
  tlsLog.clear();
  tlsLog.appendLine(lines.join('\n'));
  if (mode === 'always' || entries.length) tlsLog.show(true);
}

/* ---------------- texlogsieve report in a terminal tab --------------- */
let tlsTerm; let tlsEmitter; let tlsReady = false; let tlsPending = '';

function tlsTerminal() {
  if (tlsTerm && tlsTerm.exitStatus === undefined) return tlsTerm;
  const emitter = new vscode.EventEmitter();
  tlsEmitter = emitter;
  tlsReady = false;
  const pty = {
    onDidWrite: emitter.event,
    open: () => { tlsReady = true; if (tlsPending) { emitter.fire(tlsPending); tlsPending = ''; } },
    close: () => { tlsTerm = undefined; tlsReady = false; }
  };
  tlsTerm = vscode.window.createTerminal({ name: 'texlogsieve', pty });
  return tlsTerm;
}

function tlsWrite(text, reset) {
  if (reset) tlsPending = '';
  const data = (reset ? '\x1b[2J\x1b[3J\x1b[H' : '') + text;
  if (tlsReady && tlsEmitter) tlsEmitter.fire(data); else tlsPending += data;
}

// light colouring: banners cyan, errors red, warnings and bad boxes yellow
function colorReport(text) {
  const RED = '\x1b[31m'; const YEL = '\x1b[33m'; const CYA = '\x1b[36m'; const BLD = '\x1b[1m'; const RST = '\x1b[0m';
  return text.split('\n').map((ln) => {
    if (/^From file /.test(ln) || /^=+\s+Summary:/.test(ln) || /^After last page:/.test(ln)) return BLD + CYA + ln + RST;
    if (/^pg (?:\d+|\?): ! /.test(ln)) return RED + ln + RST;
    if (/(?:Warning|Overfull|Underfull|Missing characters)/.test(ln)) return YEL + ln + RST;
    return ln;
  }).join('\n');
}

function showReportInTerminal(stdout, items) {
  const mode = cfg().get('texlogsieveTerminal', 'always');
  if (mode === 'off') return;
  const nErr = items.filter((x) => x.severity === vscode.DiagnosticSeverity.Error).length;
  const nWarn = items.filter((x) => x.severity === vscode.DiagnosticSeverity.Warning).length;
  const problems = nErr + nWarn > 0;
  if (mode === 'onProblems' && !problems && !(tlsTerm && tlsTerm.exitStatus === undefined)) return;
  const head = '\x1b[1m texlogsieve: ' + (nErr ? '\x1b[31m' + nErr + ' помилок' : '\x1b[32m0 помилок') +
    '\x1b[0m\x1b[1m, ' + nWarn + ' попереджень (у Problems)\x1b[0m\n\n';
  const body = String(stdout).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').replace(/\s+$/, '');
  const text = (head + (body ? colorReport(body) : 'texlogsieve нічого не виводить.') + '\n').replace(/\n/g, '\r\n');
  const term = tlsTerminal();
  tlsWrite(text, true);
  if (mode === 'always' || problems) term.show(true);
}

function onBuildFinished(folder, job) {
  diagLog.clear();
  outLog.appendLine('--- збірка завершена, logParser = ' + cfg().get('logParser', 'builtin') + ' ---');
  if (cfg().get('logParser', 'builtin') === 'pplatex') return pplatexLog(folder, job);
  if (cfg().get('logParser', 'builtin') === 'texlogsieve') return texlogsieveLog(folder, job);
  if (!cfg().get('logWarnings', true)) return undefined;
  builtinLog(folder, job);
  return undefined;
}

/* ------- code that typography leaves alone: tssworkflow.protectedCommands ------ */
const syncUserCode = () => P.setProtectedCommands(cfg().get('protectedCommands', []));

/* ----------------------- typography on save -------------------------- */
function typographyOnWillSave(e) {
  const d = e.document;
  if (!cfg().get('typographyOnSave', false) || !/\.tex$/i.test(d.uri.fsPath)) return;
  if (d.languageId !== 'latex' && d.languageId !== 'tex') return;
  const old = docLines(d);
  const r = P.typography(old.join('\n'), { quotes: cfg().get('quoteStyle', 'guillemets') });
  if (!r.count) return;
  const neu = r.text.split('\n');
  if (neu.length !== old.length) return;
  const edits = [];
  for (let i = 0; i < old.length; i++) {
    if (neu[i] !== old[i]) edits.push(vscode.TextEdit.replace(new vscode.Range(i, 0, i, old[i].length), neu[i]));
  }
  if (edits.length) e.waitUntil(Promise.resolve(edits));
}

/* --------------------------- pictures panel -------------------------- */
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function picturesPanel() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const docUri = ed.document.uri;
  const dir = path.join(path.dirname(docUri.fsPath), 'Pictures');
  const files = fs.existsSync(dir) ? listFiles(dir, ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'], 3) : [];
  if (!files.length) { vscode.window.showWarningMessage('У ' + dir + ' немає зображень для перегляду.'); return; }
  const panel = vscode.window.createWebviewPanel(
    'tssworkflowPictures', 'Pictures', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(dir)] }
  );
  const w = panel.webview;
  const cards = files.map((rel) => {
    const uri = w.asWebviewUri(vscode.Uri.file(path.join(dir, rel)));
    const name = rel.replace(/\.[^.]+$/, '');
    return '<div class="c" data-n="' + esc(name) + '"><img src="' + uri + '"><div>' + esc(rel) + '</div></div>';
  }).join('');
  w.html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' + w.cspSource + '; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
    '<style>body{font-family:sans-serif;display:flex;flex-wrap:wrap;gap:10px;padding:8px}' +
    '.c{width:150px;cursor:pointer;border:1px solid #8884;border-radius:4px;padding:4px;font-size:11px;word-break:break-all}' +
    '.c:hover{border-color:#4a9eff}.c img{width:100%;height:110px;object-fit:contain;background:#fff}</style></head><body>' +
    cards +
    '<script>const vs=acquireVsCodeApi();document.querySelectorAll(".c").forEach(e=>e.onclick=()=>vs.postMessage({name:e.dataset.n}));</script>' +
    '</body></html>';
  panel.webview.onDidReceiveMessage(async (msg) => {
    const e = vscode.window.visibleTextEditors.find((x) => x.document.uri.toString() === docUri.toString());
    if (!e) return;
    const pos = e.selection.active;
    const text = e.document.lineAt(pos.line).text;
    const re = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g;
    let m;
    let ctx = null;
    while ((m = re.exec(text)) !== null) {
      const s = m.index + m[0].lastIndexOf('{') + 1;
      if (pos.character >= s && pos.character <= s + m[1].length) ctx = { s, e: s + m[1].length };
    }
    await e.edit((b) =>
      ctx
        ? b.replace(new vscode.Range(pos.line, ctx.s, pos.line, ctx.e), msg.name)
        : b.insert(pos, '\\includegraphics[width=\\linewidth]{' + msg.name + '}')
    );
  });
}

/* ---------------------------- unused files --------------------------- */
async function unusedFiles() {
  const tex = await texFiles();
  const texts = tex.map((f) => ({ p: f.fsPath, t: textOf(f) }));
  const pics = await vscode.workspace.findFiles('**/Pictures/**/*.{png,jpg,jpeg,gif,webp,svg,pdf,eps,tif,tiff}', EXCLUDE, 5000);
  const tikz = await vscode.workspace.findFiles('**/tikz/**/*.{tikz,tex}', EXCLUDE, 5000);
  const unused = pics.concat(tikz).filter((f) => {
    const base = path.basename(f.fsPath).replace(/\.[^.]+$/, '');
    const re = new RegExp('(?<![\\w-])' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    return !texts.some((x) => x.p !== f.fsPath && re.test(x.t));
  });
  if (!unused.length) { info('Файлів без посилань не знайдено.'); return; }
  const items = unused.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Файли, на які ніде немає посилань: ' + unused.length + ' (обери, щоб відкрити)'
  });
  if (pick) vscode.commands.executeCommand('vscode.open', pick.uri);
}

/* ------------------------------ quick fixes -------------------------- */
const QF = vscode.CodeActionKind.QuickFix;

function mkFix(title, d, edit) {
  const a = new vscode.CodeAction(title, QF);
  a.diagnostics = [d];
  a.edit = edit;
  return a;
}

// all label names of the project (cached index)
async function allLabelNames() {
  const names = new Set();
  for (const data of (await buildIndex(false)).values()) data.labels.forEach((l) => names.add(l.name));
  return names;
}

// last line of the block of non-blank lines that starts at `line`
function blockEndLine(doc, line) {
  let e = line;
  while (e + 1 < doc.lineCount && doc.lineAt(e + 1).text.trim() !== '') e++;
  return e;
}

const quickFixes = {
  async provideCodeActions(doc, range, ctx) {
    const out = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== 'TSS Workflow') continue;
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      const uri = doc.uri;
      const replaceWith = (title, text) => {
        const we = new vscode.WorkspaceEdit();
        we.replace(uri, d.range, text);
        out.push(mkFix(title, d, we));
      };
      if (code === 'missing-backslash') {
        const we = new vscode.WorkspaceEdit();
        we.insert(uri, d.range.start, '\\');
        out.push(mkFix('Додати «\\»', d, we));
      } else if (code === 'blank-in-math') {
        const ln = d.range.start.line;
        const del = new vscode.WorkspaceEdit();
        if (ln + 1 < doc.lineCount) del.delete(uri, new vscode.Range(ln, 0, ln + 1, 0));
        else del.delete(uri, new vscode.Range(ln, 0, ln, doc.lineAt(ln).text.length));
        out.push(mkFix('Видалити порожній рядок', d, del));
        const com = new vscode.WorkspaceEdit();
        com.replace(uri, new vscode.Range(ln, 0, ln, doc.lineAt(ln).text.length), '%');
        out.push(mkFix('Замінити порожній рядок на «%»', d, com));
      } else if (code === 'end-mismatch') {
        const m = /\\begin\{([^}]*)\}/.exec(d.message);
        if (m) replaceWith('Замінити на \\end{' + m[1] + '}', '\\end{' + m[1] + '}');
      } else if (code === 'missing-end') {
        const m = /\\end\{([^}]*)\}/.exec(d.message);
        if (m) {
          const ln = d.range.start.line;
          const last = blockEndLine(doc, ln);
          const indent = /^\s*/.exec(doc.lineAt(ln).text)[0];
          const we = new vscode.WorkspaceEdit();
          we.insert(uri, new vscode.Position(last, doc.lineAt(last).text.length), '\n' + indent + '\\end{' + m[1] + '}');
          out.push(mkFix('Додати \\end{' + m[1] + '} після цього блоку (до порожнього рядка)', d, we));
        }
      } else if (code === 'file-missing-tikz' || code === 'file-missing-pic') {
        const isTikz = code === 'file-missing-tikz';
        const name = doc.getText(d.range).trim();
        const dir = path.join(path.dirname(uri.fsPath), isTikz ? 'tikz' : 'Pictures');
        const names = [];
        for (const rel of listFiles(dir, isTikz ? ['.tikz', '.tex'] : PIC_EXTS, 3)) {
          names.push(isTikz ? rel : rel.slice(0, rel.length - path.extname(rel).length));
        }
        for (const s of P.suggest(name, names, 3)) replaceWith('Замінити на «' + s + '»', s);
      } else if (code === 'label-undefined') {
        const name = doc.getText(d.range).trim();
        for (const s of P.suggest(name, [...(await allLabelNames())], 3)) replaceWith('Замінити на «' + s + '»', s);
      } else if (code === 'cite-undefined') {
        const name = doc.getText(d.range).trim();
        for (const s of P.suggest(name, bibKeyCache, 3)) replaceWith('Замінити на «' + s + '»', s);
      } else if (code === 'figure-no-caption' || code === 'figure-no-label') {
        const nm = /«([^»]*)»/.exec(d.message);
        const lines = docLines(doc);
        const end = nm && P.envEnd(lines, nm[1], d.range.start.line, d.range.end.character);
        if (end) {
          const endTok = '\\end{' + nm[1] + '}';
          const endCol = end.col - endTok.length;
          const before = lines[end.line].slice(0, Math.max(0, endCol));
          if (endCol >= 0 && before.trim() === '') {
            const isCap = code === 'figure-no-caption';
            const prefix = (cfg().get('labelPrefixes', {}) || {})[nm[1].replace(/\*$/, '')] || (/figure/.test(nm[1]) ? 'pic:' : '');
            const text = before + (isCap ? '\\caption{}' : '\\label{' + prefix + '}') + '\n';
            const we = new vscode.WorkspaceEdit();
            we.insert(uri, new vscode.Position(end.line, 0), text);
            out.push(mkFix(isCap ? 'Додати \\caption{} перед ' + endTok : 'Додати \\label{' + prefix + '} перед ' + endTok, d, we));
          }
        }
      } else if (code === 'label-prefix') {
        const m = /починатися з «([^»]*)»/.exec(d.message);
        if (m && m[1]) {
          const newName = m[1] + doc.getText(d.range).trim();
          if (!(await allLabelNames()).has(newName)) {
            try {
              const we = await renameProvider.provideRenameEdits(doc, d.range.start, newName);
              if (we) out.push(mkFix('Перейменувати мітку на «' + newName + '» у всьому проєкті', d, we));
            } catch (e) { /* e.g. a label defined by a macro: no fix */ }
          }
        }
      }
    }
    return out;
  }
};

/* ------------------------------- outline ----------------------------- */
const symbolProvider = {
  provideDocumentSymbols(doc) {
    const lines = docLines(doc);
    const kindOf = (lvl) =>
      lvl <= 1 ? vscode.SymbolKind.Module : lvl === 2 ? vscode.SymbolKind.Class : lvl === 3 ? vscode.SymbolKind.Method : vscode.SymbolKind.Field;
    const conv = (n) => {
      const range = new vscode.Range(n.line, 0, n.endLine, lines[n.endLine].length);
      const sel = new vscode.Range(n.line, 0, n.line, lines[n.line].length);
      const sym = new vscode.DocumentSymbol(n.title, n.kind + (n.star ? '*' : ''), kindOf(n.level), range, sel);
      sym.children = n.children.map(conv);
      return sym;
    };
    return P.outlineTree(lines).map(conv);
  }
};

/* ------------------------------ register ----------------------------- */
function register(context, api) {
  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  const subs = context.subscriptions;
  syncUserCode();
  require('./macros').register(context, { log: (m) => outLog.appendLine(m), exclude: EXCLUDE });
  require('./tikzExtract').register(context);
  require('./projectInfo').register(context, {
    texFiles, textOf, buildIndex, EXCLUDE, log: (m) => outLog.appendLine(m), showLog: () => outLog.show(true)
  });
  subs.push(
    cmd('tssworkflow.wrap', wrapParagraph),
    cmd('tssworkflow.typography', typographyCmd),
    cmd('tssworkflow.sentences', sentencesCmd),
    cmd('tssworkflow.frameSections', () => frameSectionsCmd(false)),
    cmd('tssworkflow.reframeSections', () => frameSectionsCmd(true)),
    cmd('tssworkflow.normalize', normalizeCmd),
    cmd('tssworkflow.normalizeOptions', normalizeOptions),
    cmd('tssworkflow.goToHeading', goToHeading),
    cmd('tssworkflow.tableOps', tableOps),
    cmd('tssworkflow.convertEnv', convertEnv),
    cmd('tssworkflow.displayToEquation', displayToEquation),
    cmd('tssworkflow.pictures', picturesPanel),
    cmd('tssworkflow.unusedFiles', unusedFiles),
    cmd('tssworkflow.checkLabels', () => checkLabels(true)),
    cmd('tssworkflow.checkCitations', () => checkCitations(true)),
    cmd('tssworkflow.initProjectSettings', initProjectSettings),
    cmd('tssworkflow.showHooks', showHooks),
    cmd('tssworkflow.ltexDictionary', ltexDictionary),
    cmd('tssworkflow.toggleCompileOnSave', () =>
      cfg().update('compileOnSave', !cfg().get('compileOnSave', false), vscode.ConfigurationTarget.Global)),
    vscode.languages.registerCompletionItemProvider(SEL, refCompletion, '{', ','),
    vscode.languages.registerRenameProvider(SEL_ANY, renameProvider),
    vscode.languages.registerHoverProvider(SEL_ANY, hoverProvider),
    vscode.languages.registerCodeActionsProvider(SEL_ANY, quickFixes, { providedCodeActionKinds: [QF] }),
    vscode.languages.registerDocumentSymbolProvider(SEL_ANY, symbolProvider, { label: 'TSS Workflow headings' }),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),
    vscode.workspace.onWillSaveTextDocument(typographyOnWillSave),
    diagSyntax,
    diagLabels,
    diagCites,
    diagLog
  );

  // "compile on save" indicator
  const auto = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  auto.command = 'tssworkflow.toggleCompileOnSave';
  const refreshAuto = () => {
    const ed = vscode.window.activeTextEditor;
    auto.text = '$(sync) Auto: ' + (cfg().get('compileOnSave', false) ? 'on' : 'off');
    auto.tooltip = 'Компіляція при збереженні (розділ або рисунок). Клік перемикає.';
    if (ed && isTexDoc(ed.document)) auto.show(); else auto.hide();
  };
  subs.push(auto, vscode.window.onDidChangeActiveTextEditor(refreshAuto));
  refreshAuto();

  // quick error checks (debounced) and project label checks (on save)
  const timers = new Map();
  const later = (doc) => {
    const k = doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => checkSyntax(doc), 700));
  };
  let labelTimer = null;
  let citeTimer = null;
  subs.push(
    vscode.workspace.onDidOpenTextDocument(checkSyntax),
    vscode.workspace.onDidCloseTextDocument((d) => diagSyntax.delete(d.uri)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isTexDoc(e.document)) later(e.document);
      if (!e.contentChanges.length || !e.contentChanges[0].text) return;
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document !== e.document || !isTexDoc(e.document)) return;
      const pos = ed.selection.active;
      if (REF_CTX.test(e.document.lineAt(pos.line).text.slice(0, pos.character))) {
        clearTimeout(timers.get('suggest'));
        timers.set('suggest', setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 30));
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if ((isTexDoc(d) || /\.bib$/i.test(d.fileName)) && cfg().get('diagnostics', true)) {
        clearTimeout(citeTimer);
        citeTimer = setTimeout(() => checkCitations(false), 800);
      }
      if (!isTexDoc(d)) return;
      labelDirty = true;
      checkSyntax(d);
      if (api && api.onSave && cfg().get('compileOnSave', false)) api.onSave(d);
      if (cfg().get('diagnostics', true)) {
        clearTimeout(labelTimer);
        labelTimer = setTimeout(() => checkLabels(false), 500);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tssworkflow')) {
        syncUserCode();
        refreshAuto();
        vscode.workspace.textDocuments.forEach(checkSyntax);
      }
    })
  );
  vscode.workspace.textDocuments.forEach(checkSyntax);
}

// \ShowHook for the page output hooks: which packages put code into shipout
async function showHooks() {
  const ed = vscode.window.activeTextEditor;
  const folder = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Відкрий папку проєкту (workspace).'); return; }
  const cwd = folder.uri.fsPath;
  const mainFile = cfg().get('mainFile', 'main.tex') || 'main.tex';
  // a chapter (or figure) file of the project: the same document the compile button builds (alone.tex + \TargetChapter);
  // a root file or no editor: the whole document (mainFile)
  const target = ed && ed.document.uri.fsPath.startsWith(cwd) && !P.isPackageFile(ed.document.uri.fsPath)
    ? P.hooksTarget(path.relative(cwd, ed.document.uri.fsPath))
    : null;
  const input = target ? (cfg().get('driver', 'alone.tex') || 'alone.tex') : mainFile;
  if (!fs.existsSync(path.join(cwd, input))) {
    vscode.window.showWarningMessage('Не знайдено ' + input + ' у корені проєкту (налаштування tssworkflow.' + (target ? 'driver' : 'mainFile') + ').');
    return;
  }
  const what = target ? 'розділ «' + target.chapter + '»' + (target.tikz ? ', рисунок «' + target.tikz + '»' : '') + ' через ' + input : 'весь документ (' + input + ')';
  const jobname = path.basename(input, path.extname(input)) + '-hooks';
  const names = ['shipout/before', 'shipout/foreground', 'shipout/background', 'shipout/after', 'shipout/lastpage'];
  const inject = P.hooksInject(names, target, input);
  const exe = cfg().get('lualatex', 'lualatex');
  outLog.appendLine('[hooks] ' + what + ': ' + exe + ' -jobname=' + jobname + ' (зупиняється на початку документа)');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TSS: читаю хуки виводу сторінки…' }, () =>
    new Promise((resolve) => {
      cp.execFile(exe, ['-interaction=nonstopmode', '-file-line-error', '-shell-escape', '-jobname=' + jobname, inject],
        { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 180000, env: Object.assign({}, process.env, { max_print_line: '10000' }) }, (err) => {
          let log = '';
          try { log = fs.readFileSync(path.join(cwd, jobname + '.log'), 'utf8'); } catch (e) { /* no log */ }
          for (const f of fs.readdirSync(cwd)) {
            if (f.startsWith(jobname + '.')) { try { fs.unlinkSync(path.join(cwd, f)); } catch (e) { /* ignore */ } }
          }
          const hooks = P.parseShowHooks(log);
          if (!hooks.length) {
            // say what the log really shows instead of guessing
            const d = P.diagnoseHooksLog(log);
            let why;
            if (err && err.code === 'ENOENT') why = ': не запустився ' + exe;
            else if (err && err.killed) why = ': збірка перервана через 180 с';
            else if (d.empty) why = ': LaTeX не створив логу (дивись вивід TSS Workflow)';
            else if (d.old) why = ': LaTeX від ' + d.date + ' надто старий, хуки є від 2021 року';
            else if (d.error) why = ': збірка зупинилась до початку документа (' + d.error + ')';
            else why = ' (LaTeX' + (d.date ? ' від ' + d.date : '') + '; дивись вивід TSS Workflow)';
            vscode.window.showWarningMessage('Хуки не знайдено' + why + '. Запускалось: ' + what + '.');
            if (log) outLog.appendLine(log.slice(-3000));
            resolve();
            return;
          }
          const head = 'Код, який пакети додали в хуки виводу сторінки (LaTeX \\ShowHook, зупинка на початку документа).\n' +
            'Що запускалось: ' + what + '.\n' +
            'Підозрюй те, що малює чи друкує під час виводу: eso-pic, background, draftwatermark, tikzpagenodes, zref, tcolorbox (remember picture) тощо.\n' +
            'Хуки, які пакети додають пізніше, ніж у \\begin{document}, тут не видно.\n\n';
          const text = head + hooks.map((h) => '=== ' + h.hook + ' ===\n' + h.text).join('\n\n') + '\n';
          vscode.workspace.openTextDocument({ content: text, language: 'plaintext' }).then((doc) => vscode.window.showTextDocument(doc, { preview: false }));
          resolve();
        });
    }));
}

module.exports = { register, onBuildFinished, frameSettings, applyWithPreview, _t: { imageHoverMd, wrapParagraph, typographyCmd, sentencesCmd, tableOps, convertEnv, refCompletion, renameProvider } };
