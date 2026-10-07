'use strict';
/* TSS Workflow 0.7.0:
 *   fileMacros          table "macro -> folder" (tssworkflow.fileMacros): Ctrl+click, completion, "file not found" for \input,
 *                       \include, \subfile ... as for \localinput; warning for \input paths that are not relative to the root
 *   includeStyle        \input{...} instead of \localinput{...} when the project does not define \localinput
 *   rename              references are updated after a file or folder is renamed / moved in the Explorer
 *   missing packages    Quick Fix for "File 'x.sty' not found" (tlmgr install ..., copied) + command "Missing packages from log"
 *   labels panel        tree of \label's per file, unused ones marked, button "insert \ref"
 *   word count          status bar item
 *   unused packages, table from CSV / XLSX / clipboard, .bib tools, list of equations, dated PDF copy
 * The logic without VS Code is in extra5Pure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const X = require('./extra5Pure');
const X4 = require('./extra4Pure');

const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
const info = (m, ...b) => vscode.window.showInformationMessage(m, ...b);
const warn = (m, ...b) => vscode.window.showWarningMessage(m, ...b);
const isTex = (doc) => !!doc && (doc.languageId === 'latex' || doc.languageId === 'tex');
const isTexLike = (doc) => isTex(doc) || (!!doc && doc.uri.fsPath.toLowerCase().endsWith('.tikz'));
const isBib = (doc) => !!doc && (doc.languageId === 'bibtex' || doc.uri.fsPath.toLowerCase().endsWith('.bib'));
const EXCLUDE = '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**,**/pdf-versions/**}';
const SEL = [{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }];

let extCtx = null;
let api = {};

/* ------------------------------ helpers ------------------------------ */
const table = () => X.fileMacroTable(cfg().get('fileMacros'));
const rootOf = (uri) => { const f = vscode.workspace.getWorkspaceFolder(uri) || (vscode.workspace.workspaceFolders || [])[0]; return f ? f.uri.fsPath : null; };
const existsFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const existsAny = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
const docLines = (doc) => { const a = []; for (let i = 0; i < doc.lineCount; i++) a.push(doc.lineAt(i).text); return a; };

function textOfPath(abs) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (open) return open.getText();
  try { return fs.readFileSync(abs, 'utf8'); } catch (e) { return null; }
}

// [{ path (relative, with /), abs, text }]
async function projectFiles(exts, root) {
  const names = exts.map((e) => e.replace('.', ''));
  const found = await vscode.workspace.findFiles(names.length > 1 ? '**/*.{' + names.join(',') + '}' : '**/*.' + names[0], EXCLUDE, 5000);
  const out = [];
  for (const u of found) {
    const text = textOfPath(u.fsPath);
    if (text === null) continue;
    const base = root || rootOf(u) || path.dirname(u.fsPath);
    out.push({ path: X.posix(path.relative(base, u.fsPath)), abs: u.fsPath, text });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const ctxFor = (doc) => ({
  dir: path.dirname(doc.uri.fsPath),
  root: rootOf(doc.uri),
  inputRoot: String(cfg().get('inputRoot', 'workspace')),
  rootMacros: (() => { const l = cfg().get('rootRelativeMacros', X.DEFAULT_ROOT_MACROS); return Array.isArray(l) ? l.map((s) => (String(s).startsWith('\\') ? String(s) : '\\' + s)) : X.DEFAULT_ROOT_MACROS; })(),
  exists: existsFile
});

// folder of the older built-in macros (\localinput, \includegraphics) from the table
function legacySub(macro, fallback) {
  const e = table().find((x) => x.macro === macro);
  return e ? e.sub : fallback;
}

/* ============== 1. clickable names, completion, checks for the table ============== */
const genericEntries = () => table().filter((e) => !X.LEGACY_MACROS.has(e.macro));

const linkProvider = {
  provideDocumentLinks(doc) {
    const ctx = ctxFor(doc);
    const entries = genericEntries();
    const links = [];
    for (let i = 0; i < doc.lineCount; i++) {
      for (const r of X.findFileRefs(doc.lineAt(i).text, entries)) {
        const hit = X.resolveRef(r.entry, r.name, ctx);
        const link = new vscode.DocumentLink(new vscode.Range(i, r.start, i, r.start + r.len), vscode.Uri.file(hit.abs));
        link.tooltip = 'Open ' + r.name;
        links.push(link);
      }
    }
    return links;
  }
};

function listFiles(root, exts, depth, rel) {
  rel = rel || '';
  let out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (depth > 0 && !/^(build|node_modules|pdf-versions)$/.test(e.name)) out = out.concat(listFiles(root, exts, depth - 1, r)); }
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(r);
  }
  return out;
}

const completion = {
  provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const ctx = ctxFor(doc);
    for (const entry of genericEntries()) {
      const m = new RegExp('\\\\' + entry.name + '(?![A-Za-z@])\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)$').exec(before);
      if (!m) continue;
      const base = X.basesFor(entry, ctx)[0].base;
      const range = new vscode.Range(pos.line, pos.character - m[1].length, pos.line, pos.character);
      const seen = new Set();
      const items = [];
      for (const rel of listFiles(base, entry.exts, 3)) {
        const text = rel.toLowerCase().endsWith('.tex') ? rel.slice(0, -4) : rel;
        if (seen.has(text)) continue;
        seen.add(text);
        const it = new vscode.CompletionItem(text, vscode.CompletionItemKind.File);
        it.detail = X.posix(path.relative(ctx.root || ctx.dir, path.join(base, rel)));
        it.range = range;
        it.filterText = text;
        it.sortText = '0_' + text;
        items.push(it);
      }
      return items;
    }
    return undefined;
  }
};

const diagFiles = vscode.languages.createDiagnosticCollection('tssworkflow-files');
const SEV = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, information: vscode.DiagnosticSeverity.Information, hint: vscode.DiagnosticSeverity.Hint };

function filesIssues(doc) {
  if (!isTex(doc) || !cfg().get('diagnostics', true)) return [];
  if (path.basename(path.dirname(doc.uri.fsPath)).toLowerCase() === 'tikz') return [];
  return X.checkFileRefs(docLines(doc), table(), ctxFor(doc));
}

function checkFiles(doc) {
  if (!isTexLike(doc)) return;
  const issues = filesIssues(doc);
  diagFiles.set(doc.uri, issues.map((x) => {
    const d = new vscode.Diagnostic(new vscode.Range(x.line, x.col, x.line, x.col + x.len), x.message, SEV[x.severity]);
    d.source = 'TSS Workflow';
    d.code = x.code;
    return d;
  }));
}

const fileFixes = {
  provideCodeActions(doc, range, ctx) {
    const out = [];
    const all = filesIssues(doc).filter((x) => x.code === 'input-root-path');
    for (const d of ctx.diagnostics) {
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      if (d.source !== 'TSS Workflow') continue;
      if (code === 'input-root-path') {
        const x = all.find((y) => y.line === d.range.start.line && y.col === d.range.start.character);
        if (!x) continue;
        const a = new vscode.CodeAction('Замінити на шлях від кореня: ' + x.fix, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.isPreferred = true;
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, d.range, x.fix);
        out.push(a);
        if (all.length > 1) {
          const b = new vscode.CodeAction('Виправити всі шляхи від кореня в файлі: ' + all.length, vscode.CodeActionKind.QuickFix);
          b.diagnostics = [d];
          b.edit = new vscode.WorkspaceEdit();
          for (const y of all) b.edit.replace(doc.uri, new vscode.Range(y.line, y.col, y.line, y.col + y.len), y.fix);
          out.push(b);
        }
      }
    }
    return out;
  }
};

/* ============== \input instead of \localinput when it is not defined ============== */
let localinputCache = { at: 0, root: '', defined: false };
async function localinputDefined(root) {
  if (Date.now() - localinputCache.at < 30000 && localinputCache.root === root) return localinputCache.defined;
  const files = await projectFiles(['.cls', '.sty', '.tex'], root);
  const re = /\\(?:(?:re|provide)?newcommand\*?|def|gdef|edef|NewDocumentCommand|DeclareDocumentCommand|ProvideDocumentCommand|NewCommandCopy|let|DeclareRobustCommand)\s*\{?\s*\\localinput(?![A-Za-z@])/;
  const defined = files.some((f) => re.test(f.text));
  localinputCache = { at: Date.now(), root, defined };
  return defined;
}

// null = \localinput; { prefix } = \input{prefix + name}
async function includeStyle(doc) {
  const mode = String(cfg().get('tikzIncludeMacro', 'auto'));
  if (mode === 'localinput') return null;
  const root = rootOf(doc.uri);
  if (!root) return null;
  if (mode === 'auto' && await localinputDefined(root)) return null;
  const sub = X.posix(path.relative(root, path.join(path.dirname(doc.uri.fsPath), legacySub('\\localinput', 'tikz'))));
  return { prefix: sub ? sub + '/' : '' };
}

/* ======================= 4. rename / move updates the references ======================= */
async function onRenamed(e) {
  const mode = String(cfg().get('updateRefsOnRename', 'ask'));
  if (mode === 'never') return;
  const tbl = table();
  const files = await projectFiles(['.tex', '.tikz', '.cls', '.sty']);
  for (const f of e.files) {
    const oldAbs = f.oldUri.fsPath;
    const newAbs = f.newUri.fsPath;
    if (!rootOf(f.newUri) || oldAbs === newAbs) continue;
    let isDir = false;
    try { isDir = fs.statSync(newAbs).isDirectory(); } catch (err) { continue; }
    const ext = path.extname(newAbs).toLowerCase();
    if (!isDir && !['.tex', '.tikz', '.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif', '.tif', '.tiff', '.sty', '.cls'].includes(ext)) continue;
    const stem = path.basename(oldAbs, isDir ? undefined : path.extname(oldAbs));
    const plan = [];
    let count = 0;
    for (const file of files) {
      if (file.abs === newAbs || (isDir && file.abs.startsWith(newAbs + path.sep))) continue;
      if (!file.text.includes(stem)) continue;
      const lines = file.text.split(/\r?\n/);
      const ctx = { dir: path.dirname(file.abs), root: rootOf(vscode.Uri.file(file.abs)), inputRoot: String(cfg().get('inputRoot', 'workspace')), rootMacros: ctxFor({ uri: vscode.Uri.file(file.abs) }).rootMacros };
      const edits = X.renameRefs(lines, tbl, ctx, oldAbs, newAbs, isDir);
      if (edits.length) { plan.push({ file, edits }); count += edits.length; }
    }
    if (!count) continue;
    if (mode === 'ask') {
      const pick = await info('«' + path.basename(oldAbs) + '» перейменовано на «' + path.basename(newAbs) + '». Оновити ' + count + ' посилань у ' + plan.length + ' файлах?', 'Оновити', 'Ні');
      if (pick !== 'Оновити') continue;
    }
    const we = new vscode.WorkspaceEdit();
    for (const p of plan) for (const ed of p.edits) we.replace(vscode.Uri.file(p.file.abs), new vscode.Range(ed.line, ed.col, ed.line, ed.col + ed.len), ed.newText);
    if (await vscode.workspace.applyEdit(we)) {
      for (const p of plan) {
        const d = vscode.workspace.textDocuments.find((x) => x.uri.fsPath === p.file.abs);
        if (d && d.isDirty) { try { await d.save(); } catch (err) { /* stays modified */ } }
      }
      vscode.window.setStatusBarMessage('Оновлено посилань: ' + count + ' у ' + plan.length + ' файлах', 5000);
    } else warn('Не вдалося оновити посилання на ' + path.basename(oldAbs) + '.');
  }
}

/* ======================= 3. missing packages (tlmgr) ======================= */
const MISSING_RE = /File\s+[`'‘]([^'’`\s]+?\.[A-Za-z0-9]+)['’]\s+not\s+found/;

const packageFixes = {
  provideCodeActions(doc, range, ctx) {
    const out = [];
    const cmdBase = String(cfg().get('tlmgrCommand', 'tlmgr install'));
    for (const d of ctx.diagnostics) {
      const m = MISSING_RE.exec(String(d.message || ''));
      if (!m) continue;
      const miss = X.missingFilesFromLog(String(d.message));
      if (!miss.length) continue;
      const cmds = X.tlmgrCommands(miss, cmdBase);
      if (cmds.install) {
        const a = new vscode.CodeAction('Скопіювати: ' + cmds.install, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.isPreferred = true;
        a.command = { command: 'tssworkflow._copyText', title: 'copy', arguments: [cmds.install, 'Команду скопійовано: ' + cmds.install] };
        out.push(a);
      }
      const s = new vscode.CodeAction('Скопіювати пошук пакета: ' + cmds.search[0], vscode.CodeActionKind.QuickFix);
      s.diagnostics = [d];
      s.command = { command: 'tssworkflow._copyText', title: 'copy', arguments: [cmds.search[0], 'Команду скопійовано: ' + cmds.search[0]] };
      out.push(s);
    }
    return out;
  }
};

function lastLogPath(root) {
  const job = String(cfg().get('jobname', 'main') || 'main');
  const p = path.join(root, job + '.log');
  if (existsFile(p)) return p;
  let best = null;
  try {
    for (const n of fs.readdirSync(root)) {
      if (!/\.log$/i.test(n)) continue;
      const st = fs.statSync(path.join(root, n));
      if (!best || st.mtimeMs > best.t) best = { p: path.join(root, n), t: st.mtimeMs };
    }
  } catch (e) { /* no folder */ }
  return best ? best.p : null;
}

function missingFromLog() {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) return { missing: [], log: null };
  const lp = lastLogPath(folder.uri.fsPath);
  if (!lp) return { missing: [], log: null };
  let text = '';
  try { text = fs.readFileSync(lp, 'utf8'); } catch (e) { return { missing: [], log: lp }; }
  return { missing: X.missingFilesFromLog(text), log: lp };
}

async function missingPackagesCmd() {
  const { missing, log } = missingFromLog();
  if (!log) { info('Немає файла .log у корені проєкту: спершу збери документ.'); return; }
  if (!missing.length) { info('У ' + path.basename(log) + ' немає «File … not found»: усі пакети на місці.'); return; }
  const cmds = X.tlmgrCommands(missing, String(cfg().get('tlmgrCommand', 'tlmgr install')));
  const names = missing.map((m) => m.file).join(', ');
  const buttons = [];
  if (cmds.install) buttons.push('Скопіювати install');
  buttons.push('Скопіювати пошук', 'Показати в терміналі');
  const pick = await info('Бракує файлів: ' + names + '. ' + (cmds.install ? cmds.install : 'Для цих типів файлів спершу знайди пакет командою пошуку.'), ...buttons);
  if (pick === 'Скопіювати install') await vscode.env.clipboard.writeText(cmds.install);
  else if (pick === 'Скопіювати пошук') await vscode.env.clipboard.writeText(cmds.search.join('\n'));
  else if (pick === 'Показати в терміналі') {
    const t = vscode.window.createTerminal('TSS: tlmgr');
    t.show();
    t.sendText(cmds.install || cmds.search[0], false); // not executed: `sudo`, an update of tlmgr itself or a password may be needed
  }
}

/* ============================== 5. labels panel ============================== */
class LabelsProvider {
  constructor() {
    this._ev = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._ev.event;
    this.index = { groups: [], total: 0, unused: 0 };
    this.onlyUnused = false;
    this.timer = null;
    this.view = null;
  }
  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh().catch(() => {}), ms === undefined ? 700 : ms); }
  async refresh() {
    const files = await projectFiles(['.tex', '.tikz', '.cls', '.sty']);
    this.index = X.buildLabelIndex(files.map((f) => ({ path: f.path, abs: f.abs, lines: f.text.split(/\r?\n/) })));
    const abs = new Map(files.map((f) => [f.path, f.abs]));
    for (const g of this.index.groups) g.abs = abs.get(g.path);
    if (this.view) this.view.description = this.index.total + ' міток' + (this.index.unused ? ' · без \\ref: ' + this.index.unused : '');
    this._ev.fire();
  }
  toggleFilter() { this.onlyUnused = !this.onlyUnused; vscode.commands.executeCommand('setContext', 'tssworkflow.labelsOnlyUnused', this.onlyUnused); this._ev.fire(); }
  getTreeItem(el) { return el; }
  getChildren(el) {
    if (!el) {
      const groups = this.index.groups.map((g) => ({ g, labels: this.onlyUnused ? g.labels.filter((l) => !l.uses) : g.labels })).filter((x) => x.labels.length);
      if (!groups.length) {
        const t = new vscode.TreeItem(this.onlyUnused ? 'Усі мітки мають \\ref' : 'У проєкті немає \\label');
        t.iconPath = new vscode.ThemeIcon('check');
        return [t];
      }
      return groups.map(({ g, labels }) => {
        const unused = labels.filter((l) => !l.uses).length;
        const t = new vscode.TreeItem(g.path, vscode.TreeItemCollapsibleState.Expanded);
        t.description = labels.length + (unused ? ' · без \\ref: ' + unused : '');
        t.iconPath = vscode.ThemeIcon.File;
        t.resourceUri = g.abs ? vscode.Uri.file(g.abs) : undefined;
        t.tssChildren = labels.map((l) => this.labelItem(g, l));
        return t;
      });
    }
    return el.tssChildren || [];
  }
  labelItem(g, l) {
    const t = new vscode.TreeItem(l.name, vscode.TreeItemCollapsibleState.None);
    t.description = (l.uses ? '×' + l.uses : 'немає \\ref') + ' · рядок ' + (l.line + 1);
    t.tooltip = l.name + '\n' + g.path + ':' + (l.line + 1) + '\n' + (l.uses ? 'Посилань \\ref: ' + l.uses : 'Жодного \\ref на цю мітку');
    t.iconPath = new vscode.ThemeIcon(l.uses ? 'symbol-key' : 'warning');
    t.contextValue = l.uses ? 'tssLabel' : 'tssLabelUnused';
    t.tssLabel = l.name;
    if (g.abs) t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(g.abs), { selection: new vscode.Range(l.line, l.col, l.line, l.col + l.len) }] };
    return t;
  }
}

function activeTexEditor() {
  const ed = vscode.window.activeTextEditor;
  if (ed && isTexLike(ed.document)) return ed;
  return vscode.window.visibleTextEditors.find((e) => isTexLike(e.document));
}

async function insertRef(name) {
  const ed = activeTexEditor();
  if (!ed) { info('Відкрий .tex-файл, у який вставити \\ref.'); return; }
  const prefixes = cfg().get('labels.eqPrefixes', ['eq', 'eqn', 'equation', 'formula']);
  const text = X.refText(name, Array.isArray(prefixes) ? prefixes : undefined);
  await ed.edit((b) => ed.selections.forEach((s) => b.replace(s, text)));
  await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false });
}

/* ================================= 6. word count ================================= */
function setupWordCount(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.command = 'tssworkflow.projectStats';
  context.subscriptions.push(item);
  let timer = null;
  const update = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isTexLike(ed.document) || !cfg().get('wordCount', true)) { item.hide(); return; }
    const doc = ed.document;
    if (doc.getText().length > 3000000) { item.hide(); return; }
    const all = X.countWords(doc.getText());
    const sel = ed.selection.isEmpty ? 0 : X.countWords(doc.getText(ed.selection));
    item.text = '$(pencil) ' + (sel ? sel + ' із ' : '') + all + ' сл.';
    item.tooltip = 'Слів у ' + path.basename(doc.uri.fsPath) + ': ' + all + ' (без команд, формул, коментарів, рисунків)' + (sel ? '\nУ виділенні: ' + sel : '') + '\nКлік: статистика проєкту. Вимкнути: tssworkflow.wordCount';
    item.show();
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 300); };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(later),
    vscode.window.onDidChangeTextEditorSelection(later),
    vscode.workspace.onDidChangeTextDocument((e) => { const ed = vscode.window.activeTextEditor; if (ed && e.document === ed.document) later(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow.wordCount')) update(); })
  );
  update();
}

/* ============================ 7. unused \usepackage ============================ */
async function unusedPackagesCmd() {
  const root = (vscode.workspace.workspaceFolders || [])[0];
  if (!root) { info('Відкрий папку проєкту.'); return; }
  const files = (await projectFiles(['.tex', '.cls', '.sty'], root.uri.fsPath)).map((f) => ({ path: f.path, abs: f.abs, lines: f.text.split(/\r?\n/) }));
  const res = X.unusedPackages(files);
  if (!res.unused.length) { info('Невикористаних пакетів не знайдено (перевірено ' + res.checked + '; ще ' + res.skipped + ' пакетів немає в таблиці розпізнавання, їх не чіпаю).'); return; }
  const items = res.unused.map((u) => ({ label: u.pkg, description: u.path + ':' + (u.line + 1), detail: 'У проєкті не знайдено жодної команди чи оточення цього пакета. Перевір вручну перед видаленням.', u }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Можливо зайві пакети: ' + res.unused.length + ' (перевірено ' + res.checked + ')' });
  if (!pick) return;
  const f = files.find((x) => x.path === pick.u.path);
  await vscode.window.showTextDocument(vscode.Uri.file(f.abs), { selection: new vscode.Range(pick.u.line, pick.u.col, pick.u.line, pick.u.col + pick.u.pkg.length) });
}

/* ========================= 8. table from CSV / XLSX / clipboard ========================= */
async function tableFromFileCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info('Відкрий .tex-файл, куди вставити таблицю.'); return; }
  const src = await vscode.window.showQuickPick([
    { label: '$(file) Файл .csv / .tsv / .xlsx', id: 'file' },
    { label: '$(clippy) Буфер обміну (скопійований діапазон Excel чи текст CSV)', id: 'clip' }
  ], { placeHolder: 'Звідки взяти дані' });
  if (!src) return;
  let rows;
  try {
    if (src.id === 'clip') {
      const t = await vscode.env.clipboard.readText();
      if (!t.trim()) { warn('Буфер обміну порожній.'); return; }
      rows = X.parseCsv(t, t.includes('\t') ? '\t' : undefined);
    } else {
      const defaultUri = (vscode.workspace.workspaceFolders || [])[0] ? (vscode.workspace.workspaceFolders[0].uri) : undefined;
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri, filters: { 'Таблиці': ['csv', 'tsv', 'txt', 'xlsx'] } });
      if (!picked || !picked[0]) return;
      const file = picked[0].fsPath;
      if (/\.xlsx$/i.test(file)) rows = X.readXlsx(fs.readFileSync(file));
      else rows = X.parseCsv(fs.readFileSync(file, 'utf8'), /\.tsv$/i.test(file) ? '\t' : undefined);
    }
  } catch (e) { vscode.window.showErrorMessage('Не вдалося прочитати таблицю: ' + (e && e.message ? e.message : e)); return; }
  if (!rows.length || !rows[0].length) { warn('У таблиці немає даних.'); return; }
  const c = cfg();
  const floatEnv = c.get('tblr.csvFloat', true) !== false;
  let caption = '';
  let label = '';
  if (floatEnv) {
    const cap = await vscode.window.showInputBox({ prompt: 'Підпис таблиці (\\caption), можна залишити порожнім', ignoreFocusOut: true });
    if (cap === undefined) return;
    caption = cap;
    const lab = await vscode.window.showInputBox({ prompt: 'Мітка без «tab:» (порожньо: без \\label)', ignoreFocusOut: true });
    if (lab === undefined) return;
    label = lab.trim() ? 'tab:' + lab.trim().replace(/^tab:/, '') : '';
  }
  const o = ed.options || {};
  const unit = o.insertSpaces === false ? '\t' : ' '.repeat(typeof o.tabSize === 'number' ? o.tabSize : 2);
  const out = X.buildTblr(rows, { caption, label, floatEnv, unit, headerColor: String(c.get('tblr.headerColor', 'themecolorlight')), oddColor: String(c.get('tblr.oddRowColor', 'gray!10')) });
  const lead = /^\s*/.exec(ed.document.lineAt(ed.selection.active.line).text)[0];
  const eol = ed.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const text = out.replace(/\n$/, '').split('\n').map((l, i) => (i ? lead + l : l)).join(eol);
  await ed.edit((b) => b.replace(ed.selection, text));
  vscode.window.setStatusBarMessage('Таблиця: ' + rows.length + ' рядків, ' + rows[0].length + ' стовпців', 4000);
}

/* ================================= 9. .bib tools ================================= */
function bibOptions(ed) {
  const c = cfg();
  const o = (ed && ed.options) || {};
  return {
    sortBy: String(c.get('bib.sortBy', 'none')),
    sortFields: c.get('bib.sortFields', false) === true,
    unit: o.insertSpaces === false ? '\t' : ' '.repeat(typeof o.tabSize === 'number' ? o.tabSize : 2)
  };
}

async function formatBibCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isBib(ed.document)) { info('Відкрий файл .bib.'); return; }
  const text = ed.document.getText();
  const res = X.formatBib(text, bibOptions(ed));
  if (!res.count) { info('У файлі немає записів BibTeX.'); return; }
  if (res.text === text) { info('Файл .bib уже відформатований (' + res.count + ' записів).'); return; }
  const oldL = text.replace(/\r\n/g, '\n').split('\n');
  const d = X4.diffRange(oldL, res.text.replace(/\r\n/g, '\n').split('\n'));
  const sum = 'Відформатовано записів: ' + res.count;
  if (api.applyWithPreview && d) { if (await api.applyWithPreview(ed, d.s, d.e, d.lines, 'Форматування .bib', sum)) vscode.window.setStatusBarMessage(sum, 4000); return; }
  await ed.edit((b) => b.replace(new vscode.Range(0, 0, ed.document.lineCount - 1, ed.document.lineAt(ed.document.lineCount - 1).text.length), res.text));
}

async function bibDuplicatesCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isBib(ed.document)) { info('Відкрий файл .bib.'); return; }
  const text = ed.document.getText().replace(/\r\n/g, '\n');
  const groups = X.bibDuplicates(X.parseBib(text));
  if (!groups.length) { info('Дублів за DOI чи назвою не знайдено.'); return; }
  const items = [];
  for (const g of groups) {
    for (const e of g.entries) {
      const line = text.slice(0, e.start).split('\n').length - 1;
      items.push({ label: e.key, description: (g.by === 'doi' ? 'однаковий DOI' : 'однакова назва') + ' · рядок ' + (line + 1), detail: X.fieldValue(e, 'title').slice(0, 100), line, group: g.entries.map((x) => x.key).join(' = ') });
    }
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Можливі дублі: ' + groups.length + ' груп(и). Вибери запис, щоб перейти до нього', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  const pos = new vscode.Position(pick.line, 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function bibKeysCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isBib(ed.document)) { info('Відкрий файл .bib.'); return; }
  const bibDoc = ed.document;
  const entries = X.parseBib(bibDoc.getText().replace(/\r\n/g, '\n'));
  const map = X.bibKeyMap(entries);
  if (!map.size) { info('Ключі вже мають вигляд «прізвище+рік» (' + entries.filter((e) => !e.special).length + ' записів).'); return; }
  const sample = [...map].slice(0, 8).map(([a, b]) => a + ' → ' + b).join('\n');
  const pick = await vscode.window.showInformationMessage('Перейменувати ключів: ' + map.size + ' (прізвище першого автора + рік, ASCII). Усі \\cite{…} у проєкті буде оновлено.\n\n' + sample + (map.size > 8 ? '\n…' : ''), { modal: true }, 'Перейменувати');
  if (pick !== 'Перейменувати') return;
  const root = rootOf(bibDoc.uri);
  const files = await projectFiles(['.tex', '.tikz', '.cls', '.sty'], root || undefined);
  const we = new vscode.WorkspaceEdit();
  let cites = 0;
  const touched = [];
  for (const f of files) {
    const r = X.renameCiteKeys(f.text.replace(/\r\n/g, '\n'), map);
    if (!r.count) continue;
    cites += r.count;
    const d = await vscode.workspace.openTextDocument(vscode.Uri.file(f.abs));
    const eol = d.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    we.replace(d.uri, new vscode.Range(0, 0, d.lineCount - 1, d.lineAt(d.lineCount - 1).text.length), r.text.replace(/\n/g, eol));
    touched.push(d);
  }
  const fmt = X.formatBib(bibDoc.getText(), Object.assign({}, bibOptions(ed), { keyMap: map, sortBy: 'none' }));
  we.replace(bibDoc.uri, new vscode.Range(0, 0, bibDoc.lineCount - 1, bibDoc.lineAt(bibDoc.lineCount - 1).text.length), fmt.text);
  if (!(await vscode.workspace.applyEdit(we))) { warn('Не вдалося застосувати зміни.'); return; }
  for (const d of touched.concat([bibDoc])) { try { await d.save(); } catch (e) { /* stays modified */ } }
  info('Ключів перейменовано: ' + map.size + ', посилань \\cite оновлено: ' + cites + ' (у ' + touched.length + ' файлах). Скасувати: Ctrl+Z у кожному файлі.');
}

/* ============================== 10. list of formulas ============================== */
async function listEquationsCmd() {
  const root = (vscode.workspace.workspaceFolders || [])[0];
  if (!root) { info('Відкрий папку проєкту.'); return; }
  const files = await projectFiles(['.tex', '.tikz'], root.uri.fsPath);
  let aux = null;
  try { aux = require('./extra').auxInfo; } catch (e) { /* optional */ }
  const items = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    for (const q of X.scanEquations(lines)) {
      if (q.starred || q.env === 'displaymath') continue;
      const uri = vscode.Uri.file(f.abs);
      const nums = q.labels.map((l) => { const a = aux && aux(uri, l); return a && a.num ? a.num : null; });
      const numTxt = nums.some(Boolean) ? nums.filter(Boolean).join(', ') : '—';
      items.push({ label: '(' + numTxt + ')  ' + (q.labels.length ? q.labels.join(', ') : 'без мітки'), description: f.path + ':' + (q.line + 1) + ' · ' + q.env + (q.rows > 1 ? ' ×' + q.rows : ''), detail: q.snippet, f, q });
    }
  }
  if (!items.length) { info('У проєкті немає нумерованих формул.'); return; }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Формул: ' + items.length + '. Номери беруться з останньої збірки (.aux), «—»: ще не зібрано чи немає мітки', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  await vscode.window.showTextDocument(vscode.Uri.file(pick.f.abs), { selection: new vscode.Range(pick.q.line, 0, pick.q.endLine, 0) });
}

/* ============================== 11. PDF copy with a date ============================== */
async function savePdfCopyCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTexLike(ed.document)) { info('Відкрий .tex розділу чи .tikz рисунка.'); return; }
  const root = rootOf(ed.document.uri);
  if (!root) { warn('Файл не належить відкритій папці.'); return; }
  const file = ed.document.uri.fsPath;
  const base = path.basename(file, path.extname(file));
  const job = String(cfg().get('jobname', 'main')) || base;
  const pdf = path.join(root, job + '.pdf');
  if (!existsFile(pdf)) { warn('Немає ' + job + '.pdf у корені проєкту: спершу збери (▷ чи F5).'); return; }
  const stale = fs.statSync(pdf).mtimeMs < fs.statSync(file).mtimeMs;
  if (stale) {
    const go = await warn('PDF старіший за ' + path.basename(file) + ': розділ змінено після останньої збірки.', 'Все одно зберегти', 'Скасувати');
    if (go !== 'Все одно зберегти') return;
  }
  const dir = path.join(root, String(cfg().get('pdfCopyDir', 'pdf-versions')) || 'pdf-versions');
  fs.mkdirSync(dir, { recursive: true });
  let name = X.datedName(base, new Date(), cfg().get('pdfCopyTime', true) !== false);
  let target = path.join(dir, name);
  for (let n = 2; existsFile(target); n++) target = path.join(dir, name.replace(/\.pdf$/, '-' + n + '.pdf'));
  fs.copyFileSync(pdf, target);
  const pick = await info('Збережено: ' + X.posix(path.relative(root, target)), 'Відкрити');
  if (pick === 'Відкрити') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
}

/* ================================== register ================================== */
function register(context, helpers) {
  extCtx = context;
  api = helpers || {};
  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  const labels = new LabelsProvider();
  labels.view = vscode.window.createTreeView('tssworkflow.labelsView', { treeDataProvider: labels, showCollapseAll: true });
  const debounce = (doc) => { if (isTexLike(doc)) labels.schedule(); };
  const debouncedCheck = (() => { let t = null; return (doc) => { clearTimeout(t); t = setTimeout(() => checkFiles(doc), 400); }; })();

  context.subscriptions.push(
    labels.view,
    vscode.languages.registerDocumentLinkProvider(SEL, linkProvider),
    vscode.languages.registerCompletionItemProvider(SEL, completion, '{', '/'),
    vscode.languages.registerCodeActionsProvider(SEL, fileFixes, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCodeActionsProvider(SEL, packageFixes, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    diagFiles,
    cmd('tssworkflow.missingPackages', missingPackagesCmd),
    cmd('tssworkflow._copyText', async (text, msg) => { await vscode.env.clipboard.writeText(String(text)); vscode.window.setStatusBarMessage(msg || 'Скопійовано', 4000); }),
    cmd('tssworkflow.refreshLabels', () => labels.refresh()),
    cmd('tssworkflow.labelsToggleFilter', () => labels.toggleFilter()),
    cmd('tssworkflow.insertRefFromLabel', (el) => { if (el && el.tssLabel) return insertRef(el.tssLabel); }),
    cmd('tssworkflow.pickRef', async () => {
      if (!labels.index.total) await labels.refresh();
      const items = [];
      for (const g of labels.index.groups) for (const l of g.labels) items.push({ label: l.name, description: g.path + ':' + (l.line + 1) + (l.uses ? ' · ×' + l.uses : ' · без \\ref'), name: l.name });
      if (!items.length) { info('У проєкті немає \\label.'); return; }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Мітка для \\ref', matchOnDescription: true });
      if (pick) await insertRef(pick.name);
    }),
    cmd('tssworkflow.unusedPackages', unusedPackagesCmd),
    cmd('tssworkflow.tableFromFile', tableFromFileCmd),
    cmd('tssworkflow.formatBib', formatBibCmd),
    cmd('tssworkflow.bibDuplicates', bibDuplicatesCmd),
    cmd('tssworkflow.bibNormalizeKeys', bibKeysCmd),
    cmd('tssworkflow.listEquations', listEquationsCmd),
    cmd('tssworkflow.savePdfCopy', savePdfCopyCmd),
    vscode.workspace.onDidOpenTextDocument(checkFiles),
    vscode.workspace.onDidChangeTextDocument((e) => { debouncedCheck(e.document); debounce(e.document); }),
    vscode.workspace.onDidSaveTextDocument((d) => { checkFiles(d); debounce(d); }),
    vscode.workspace.onDidCloseTextDocument((d) => diagFiles.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tssworkflow.fileMacros') || e.affectsConfiguration('tssworkflow.inputRoot') || e.affectsConfiguration('tssworkflow.rootRelativeMacros')) vscode.workspace.textDocuments.forEach(checkFiles);
    })
  );
  try {
    const w = vscode.workspace.createFileSystemWatcher('**/*.{tex,tikz,cls,sty}');
    context.subscriptions.push(w, w.onDidCreate(() => labels.schedule(1000)), w.onDidDelete(() => labels.schedule(1000)));
  } catch (e) { /* no watcher */ }
  if (vscode.workspace.onDidRenameFiles) context.subscriptions.push(vscode.workspace.onDidRenameFiles((e) => onRenamed(e).catch(() => {})));
  setupWordCount(context);
  vscode.workspace.textDocuments.forEach(checkFiles);
  labels.schedule(1500);
}

exports.register = register;
exports.legacySub = legacySub;
exports.includeStyle = includeStyle;
exports.missingFromLog = missingFromLog;
exports._t = { onRenamed, filesIssues, localinputDefined, LabelsProvider };
