'use strict';
/* Extra features: number and page of a label from the .aux file (hover), project statistics,
 * numbered equations nobody refers to, TODO view, quick fixes for the typography checks,
 * "where is this macro defined?" diagnostics. Pure logic lives in extraPure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./pure');
const X = require('./extraPure');
const M = require('./macros');

let api = null;
const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
const info = (m, ...btn) => vscode.window.showInformationMessage(m, ...btn);
const SEL_ANY = [{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }];
const QF = vscode.CodeActionKind.QuickFix;
const FIXALL = vscode.CodeActionKind.SourceFixAll.append('tssworkflow');
const eolOf = (doc) => (doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
const relPath = (fp) => {
  const f = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fp));
  return (f ? path.relative(f.uri.fsPath, fp) : fp).replace(/\\/g, '/');
};
const openAt = (uri, line, preserveFocus) =>
  vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preserveFocus: !!preserveFocus, preview: true });

/* --------------------------- .aux numbers ---------------------------- */
const auxCache = new Map(); // file -> { mtime, map }

function readAuxTree(file, depth, map, seen) {
  if (depth > 3 || seen.has(file)) return;
  seen.add(file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const [k, v] of X.parseAux(text)) if (!map.has(k)) map.set(k, v);
  for (const inc of X.auxInputs(text)) readAuxTree(path.resolve(path.dirname(file), inc), depth + 1, map, seen);
}

function auxFilesFor(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return [];
  const root = folder.uri.fsPath;
  const job = cfg().get('jobname', 'main') || 'main';
  const custom = cfg().get('auxFile', '');
  return (custom ? [path.resolve(root, custom)] : []).concat([path.join(root, job + '.aux'), path.join(root, 'build', job + '.aux')]);
}

// { num, page, title } of the label from the last compilation, or null
function auxInfo(uri, name) {
  for (const f of auxFilesFor(uri)) {
    let st;
    try { st = fs.statSync(f); } catch (e) { continue; }
    let c = auxCache.get(f);
    if (!c || c.mtime !== st.mtimeMs) {
      const map = new Map();
      readAuxTree(f, 0, map, new Set());
      c = { mtime: st.mtimeMs, map };
      auxCache.set(f, c);
    }
    const hit = c.map.get(name);
    if (hit && (hit.num || hit.page)) return hit;
  }
  return null;
}

/* ---------------------------- used labels ---------------------------- */
async function usedLabels() {
  const used = new Set();
  for (const d of (await api.buildIndex(false)).values()) d.refs.forEach((r) => used.add(r.name));
  return used;
}

/* ----------------- numbered equations nobody refers to --------------- */
async function unusedEquations() {
  const used = await usedLabels();
  const rows = [];
  for (const f of await api.texFiles()) {
    const lines = api.textOf(f).split(/\r?\n/);
    for (const it of X.numberedEquations(lines, used)) if (it.candidate) rows.push({ f, lines, it });
  }
  if (!rows.length) { info('Нумерованих формул без посилань не знайдено.'); return; }
  rows.sort((a, b) => a.f.fsPath.localeCompare(b.f.fsPath) || a.it.line - b.it.line);
  const qp = vscode.window.createQuickPick();
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.title = 'Нумеровані формули без посилань: ' + rows.length;
  qp.placeholder = 'Відмітьте формули, які зробити зірочковими (без номера й мітки), Enter. Esc нічого не змінює';
  qp.items = rows.map((r) => ({
    label: '\\begin{' + r.it.env + '}  ' + (r.lines[r.it.line + 1] || '').trim().slice(0, 60),
    description: relPath(r.f.fsPath) + ':' + (r.it.line + 1),
    detail: r.it.labels.length ? 'мітка ' + r.it.labels.join(', ') + ' ніде не використана' : 'без мітки',
    r
  }));
  // moving over an item shows the formula in the editor
  qp.onDidChangeActive((act) => { if (act[0]) openAt(act[0].r.f, act[0].r.it.line, true); });
  const chosen = await new Promise((resolve) => {
    qp.onDidAccept(() => { resolve(qp.selectedItems.slice()); qp.hide(); });
    qp.onDidHide(() => resolve([]));
    qp.show();
  });
  qp.dispose();
  if (!chosen.length) return;
  const we = new vscode.WorkspaceEdit();
  for (const c of chosen) {
    const { f, lines, it } = c.r;
    const eol = lines.length && /\r\n/.test(api.textOf(f)) ? '\r\n' : '\n';
    we.replace(f, new vscode.Range(it.line, 0, it.endLine, lines[it.endLine].length), X.starEquation(lines, it).join(eol));
  }
  if (await vscode.workspace.applyEdit(we)) info('Перетворено формул: ' + chosen.length + '. Файли змінено, але не збережено.');
}

/* ---------------------------- statistics ---------------------------- */
const mdCell = (s) => String(s).replace(/\|/g, '\\|');

async function projectStats() {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { info('Відкрий папку проєкту.'); return; }
  const root = folder.uri.fsPath;
  const extra = cfg().get('statsCounters', {}) || {};
  const files = (await api.texFiles()).filter((u) => /\.tex$/i.test(u.fsPath) && u.fsPath.startsWith(root));
  const byPath = new Map(files.map((u) => [u.fsPath, u]));
  const ordered = [];
  const seen = new Set();
  const add = (p) => { if (byPath.has(p) && !seen.has(p)) { seen.add(p); ordered.push(byPath.get(p)); } };
  const mainFile = path.join(root, cfg().get('mainFile', 'main.tex'));
  add(mainFile);
  try {
    const mt = X.stripComments(fs.readFileSync(mainFile, 'utf8'));
    const re = /\\(includechapter|input|include)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(mt))) {
      const n = m[2].trim();
      add(m[1] === 'includechapter' ? path.join(root, n, path.basename(n) + '.tex') : path.join(root, /\.tex$/i.test(n) ? n : n + '.tex'));
    }
  } catch (e) { /* no main file: alphabetical order */ }
  files.map((u) => u.fsPath).sort().forEach(add);

  const extraNames = Object.keys(extra);
  const head = ['Розділ', 'Слів', 'Формул (нум. / ненум.)', 'Рисунків', 'Таблиць', 'tikz', 'Цитувань'].concat(extraNames);
  const row = (title, st) => '| ' + [title, st.words, st.eqNum + ' / ' + st.eqStar, st.figures, st.tables, st.tikz, st.cites]
    .concat(extraNames.map((n) => st.extra[n] || 0)).join(' | ') + ' |';
  const out = ['# Статистика проєкту', '', '| ' + head.join(' | ') + ' |', '|' + head.map((h, i) => (i ? '---:' : ':---')).join('|') + '|'];
  let total = X.emptyStats();
  for (const u of ordered) {
    const fs0 = X.fileStats(api.textOf(u), extra);
    const t = fs0.total;
    if (!t.words && !t.eqNum && !t.eqStar && !t.figures && !t.tables && !t.tikz && !t.cites) continue;
    total = X.addStats(total, t);
    out.push(row('**' + mdCell(relPath(u.fsPath)) + '**', t));
    for (const r of fs0.rows) out.push(row('&emsp;' + (r.level === 1 ? '▸ ' : '') + mdCell(r.title), r.st));
  }
  out.push(row('**Разом**', total));
  out.push('', '_Слова рахуються в тексті без формул, коментарів, verbatim і tikz; аргументи `\\label`, `\\ref`, `\\cite`, `\\includegraphics` не рахуються. Додаткові лічильники: налаштування `tssworkflow.statsCounters`._');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: out.join('\n') + '\n' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/* -------------------------------- TODO -------------------------------- */
const todoKeywords = () => cfg().get('todoKeywords', ['TODO', 'FIXME', 'XXX', 'HACK', 'ПЕРЕВІРИТИ', 'ДОПИСАТИ']);

async function collectTodos() {
  const kws = todoKeywords();
  const res = [];
  for (const f of await api.texFiles()) {
    const items = X.scanTodos(api.textOf(f), kws);
    if (items.length) res.push({ file: f, items });
  }
  res.sort((a, b) => a.file.fsPath.localeCompare(b.file.fsPath));
  return res;
}

class TodoTree {
  constructor() {
    this._ev = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._ev.event;
    this.cache = null;
    this.view = null;
  }
  refresh() { this.cache = null; this._ev.fire(undefined); }
  async load() {
    if (!this.cache) {
      this.cache = await collectTodos();
      if (this.view) {
        const n = this.cache.reduce((a, g) => a + g.items.length, 0);
        this.view.description = n ? String(n) : '';
        this.view.message = n ? undefined : 'Позначок ' + todoKeywords().join(' / ') + ' у коментарях не знайдено';
      }
    }
    return this.cache;
  }
  async getChildren(el) {
    if (!el) return (await this.load()).map((g) => ({ type: 'file', g }));
    if (el.type === 'file') return el.g.items.map((it) => ({ type: 'item', file: el.g.file, it }));
    return [];
  }
  getTreeItem(el) {
    if (el.type === 'file') {
      const t = new vscode.TreeItem(path.basename(el.g.file.fsPath), vscode.TreeItemCollapsibleState.Expanded);
      t.description = path.dirname(relPath(el.g.file.fsPath)).replace(/^\.$/, '') + '  (' + el.g.items.length + ')';
      t.resourceUri = el.g.file;
      t.iconPath = vscode.ThemeIcon.File;
      return t;
    }
    const t = new vscode.TreeItem(el.it.kw + (el.it.text ? ': ' + el.it.text : ''), vscode.TreeItemCollapsibleState.None);
    t.description = 'рядок ' + (el.it.line + 1);
    t.iconPath = new vscode.ThemeIcon(/^(FIXME|XXX|HACK)$/.test(el.it.kw) ? 'bug' : 'checklist');
    t.command = { command: 'vscode.open', title: 'Відкрити', arguments: [el.file, { selection: new vscode.Range(el.it.line, 0, el.it.line, 0) }] };
    return t;
  }
}

async function todoList() {
  const groups = await collectTodos();
  const picks = [];
  for (const g of groups) for (const it of g.items) {
    picks.push({ label: it.kw + (it.text ? ': ' + it.text : ''), description: relPath(g.file.fsPath) + ':' + (it.line + 1), file: g.file, line: it.line });
  }
  if (!picks.length) { info('Позначок ' + todoKeywords().join(' / ') + ' не знайдено.'); return; }
  const pick = await vscode.window.showQuickPick(picks, { matchOnDescription: true, placeHolder: 'TODO / FIXME у проєкті: ' + picks.length });
  if (pick) await openAt(pick.file, pick.line);
}

/* ------------------------ quick fixes for typography ----------------- */
// which hints "fix all" touches: tssworkflow.fixAllCodes (default only the non-breaking spaces)
const TYPO_FIXABLE = { 'typo-nbsp': 'нерозривні пробіли', 'typo-dash': 'дефіс замість тире', 'typo-mixed-script': 'кирилиця й латиниця в одному слові' };
const fixCodes = () => {
  const v = cfg().get('fixAllCodes', ['typo-nbsp']);
  return Array.isArray(v) ? v.filter((c) => TYPO_FIXABLE[c]) : ['typo-nbsp'];
};
const linesOfDoc = (doc) => doc.getText().split(/\r?\n/);
function planEdit(doc, plan) {
  const we = new vscode.WorkspaceEdit();
  for (const e of plan) we.replace(doc.uri, new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.text);
  return we;
}

// "Fix typography hints in file": the same edits as source.fixAll.tssworkflow, from the command palette
async function fixTypographyHints() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !/\.(tex|tikz)$/i.test(ed.document.fileName)) { info('Відкрий .tex-файл.'); return; }
  const codes = fixCodes();
  const plan = X.typoFixPlan(linesOfDoc(ed.document), { codes });
  if (!plan.length) { info('Нічого виправляти: ' + (codes.length ? codes.join(', ') : 'tssworkflow.fixAllCodes порожній') + '.'); return; }
  await vscode.workspace.applyEdit(planEdit(ed.document, plan));
  info('Типографічних зауважень виправлено: ' + plan.length + ' (' + codes.join(', ') + ').');
}

const typoFixes = {
  async provideCodeActions(doc, range, ctx) {
    const out = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== 'TSS Workflow') continue;
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      const text = doc.getText(d.range);
      const replace = (title, newText, preferred) => {
        const a = new vscode.CodeAction(title, QF);
        a.diagnostics = [d];
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, d.range, newText);
        if (preferred) a.isPreferred = true;
        out.push(a);
      };
      if (code === 'typo-nbsp') {
        replace('Замінити пробіл на «~»', text.replace(/[ \u00a0]/, '~'), true);
        if (/одиницею/.test(d.message)) replace('Замінити пробіл на «\\,» (вузький)', text.replace(/[ \u00a0]/, '\\,'));
      } else if (code === 'typo-dash') {
        replace('Замінити на « --- »', ' --- ', true);
      } else if (code === 'typo-mixed-script') {
        const f = X.fixHomoglyphs(text);
        if (f) replace('Замінити латинські літери на кириличні: «' + f + '»', f, true);
      } else if (code === 'label-unused') {
        const lines = doc.getText().split(/\r?\n/);
        const ln = d.range.start.line;
        const it = X.numberedEquations(lines, await usedLabels()).find((x) => x.line <= ln && ln <= x.endLine && x.candidate);
        if (it) {
          const a = new vscode.CodeAction('Зробити ' + it.env + '* без номера й мітки', QF);
          a.diagnostics = [d];
          a.edit = new vscode.WorkspaceEdit();
          a.edit.replace(doc.uri, new vscode.Range(it.line, 0, it.endLine, lines[it.endLine].length), X.starEquation(lines, it).join(eolOf(doc)));
          out.push(a);
        }
      }
    }
    // all hints of the same kind in the file, from the current text
    const kinds = new Set(ctx.diagnostics.filter((d) => d.source === 'TSS Workflow').map((d) => (d.code && typeof d.code === 'object' ? d.code.value : d.code)).filter((c) => TYPO_FIXABLE[c]));
    for (const code of kinds) {
      const plan = X.typoFixPlan(linesOfDoc(doc), { codes: [code] });
      if (plan.length < 2) continue;
      const a = new vscode.CodeAction('Виправити всі в файлі (' + TYPO_FIXABLE[code] + '): ' + plan.length, QF);
      a.edit = planEdit(doc, plan);
      out.push(a);
    }
    // source.fixAll.tssworkflow (Source Action menu, editor.codeActionsOnSave)
    if (ctx.only && ctx.only.contains(FIXALL)) {
      const plan = X.typoFixPlan(linesOfDoc(doc), { codes: fixCodes() });
      if (plan.length) {
        const a = new vscode.CodeAction('TSS Workflow: виправити типографічні зауваження (' + plan.length + ')', FIXALL);
        a.edit = planEdit(doc, plan);
        out.push(a);
      }
    }
    return out;
  }
};

/* ---------------- where is this macro defined (diagnostics) --------- */
async function macroInfo() {
  const ed = vscode.window.activeTextEditor;
  let name = '';
  if (ed) {
    const r = ed.document.getWordRangeAtPosition(ed.selection.active, /\\[A-Za-z@]+/);
    if (r) name = ed.document.getText(r).slice(1);
  }
  const typed = await vscode.window.showInputBox({ prompt: 'Назва макросу (без \\)', value: name });
  if (!typed) return;
  name = typed.trim().replace(/^\\/, '');
  const { cmds, envs } = await M._allMacros(ed && ed.document);
  const e = cmds.get(name) || envs.get(name);
  if (e) {
    const b = await info('\\' + name + ' визначено в ' + path.basename(e.file) + ':' + (e.line + 1) + ': ' + e.src.split('\n')[0].slice(0, 120), 'Відкрити');
    if (b) await openAt(vscode.Uri.file(e.file), e.line);
    return;
  }
  const sources = await M._getSourceFiles();
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defRe = new RegExp('\\\\(?:(?:re)?new|provide|Declare(?:Robust)?|New|Renew|Provide)[A-Za-z]*\\*?\\s*\\{?\\s*\\\\' + esc + '(?![A-Za-z@])|\\\\(?:[gex]?def|let|csdef)\\s*\\\\' + esc + '(?![A-Za-z@])');
  const hits = [];
  for (const f of await vscode.workspace.findFiles('**/*.{tex,cls,sty,ltx,tikz}', api.EXCLUDE, 2000)) {
    api.textOf(f).split(/\r?\n/).forEach((l, i) => { if (defRe.test(P.codePart(l))) hits.push({ f, line: i, text: l.trim().slice(0, 160) }); });
  }
  api.log('[macros] \\' + name + ' не знайдено сканером. Скановані джерела (' + sources.length + '): ' + (sources.map((s) => path.basename(s)).join(', ') || 'немає'));
  hits.forEach((h) => api.log('[macros]   схоже визначення: ' + relPath(h.f.fsPath) + ':' + (h.line + 1) + '  ' + h.text));
  if (hits.length) {
    const inSources = hits.some((h) => sources.includes(h.f.fsPath));
    const msg = '\\' + name + ': сканер макросів не розпізнав визначення, хоча схожі рядки є (' + hits.length + '), перше: ' + relPath(hits[0].f.fsPath) + ':' + (hits[0].line + 1) +
      (inSources ? '. Конструкція, найімовірніше, не підтримується сканером.' : '. Цей файл не входить у скановані джерела: додай його в tssworkflow.macroFiles.');
    const b = await info(msg, 'Відкрити', 'Output');
    if (b === 'Відкрити') await openAt(hits[0].f, hits[0].line);
    else if (b === 'Output') api.showLog();
  } else {
    const b = await info('\\' + name + ' не знайдено в проєкті. Скановано джерел: ' + sources.length + '. Якщо клас лежить поза проєктом, вкажи його в tssworkflow.macroFiles.', 'Output');
    if (b) api.showLog();
  }
}

/* ------------------------------ register ----------------------------- */
function register(context, apiIn) {
  api = apiIn;
  const subs = context.subscriptions;
  const todo = new TodoTree();
  const view = vscode.window.createTreeView('tssworkflow.todoView', { treeDataProvider: todo });
  todo.view = view;
  let timer = null;
  subs.push(
    view,
    vscode.commands.registerCommand('tssworkflow.unusedEquations', unusedEquations),
    vscode.commands.registerCommand('tssworkflow.projectStats', projectStats),
    vscode.commands.registerCommand('tssworkflow.todoList', todoList),
    vscode.commands.registerCommand('tssworkflow.todoRefresh', () => todo.refresh()),
    vscode.commands.registerCommand('tssworkflow.macroInfo', macroInfo),
    vscode.languages.registerCodeActionsProvider(SEL_ANY, typoFixes, { providedCodeActionKinds: [QF, FIXALL] }),
    vscode.commands.registerCommand('tssworkflow.fixTypographyHints', fixTypographyHints),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (!/\.(tex|tikz)$/i.test(d.fileName)) return;
      clearTimeout(timer);
      timer = setTimeout(() => todo.refresh(), 1200);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow.todoKeywords')) todo.refresh(); })
  );
}

module.exports = { register, auxInfo };
