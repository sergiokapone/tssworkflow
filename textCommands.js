'use strict';
/* textCommands.js: wrap, typography, sentences, table operations, environments, section frames, the change preview (diff), normalize. */
const vscode = require('vscode');
const path = require('path');
const P = require('./corePure');
const { cfg, chunkRange, docLines, info, linesOf, replaceLines } = require('./util');

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

module.exports = {
  PREVIEW_SCHEME,
  applyWithPreview,
  convertEnv,
  displayToEquation,
  frameSectionsCmd,
  frameSettings,
  normalizeCmd,
  normalizeOptions,
  previewProvider,
  sentencesCmd,
  tableOps,
  typographyCmd,
  wrapParagraph,
};
