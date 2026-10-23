'use strict';
/* TSS Workflow 0.5.0:
 *   Rename chapter / Move chapter up, down   a chapter folder X/X.tex is renamed with the main file, paths and references
 *   Replace in project                       LaTeX-aware search and replace (not in comments and verbatim), with a snapshot
 *   Snapshots                                Make snapshot / Restore snapshot (also taken before every project-wide change)
 *   Normalize project                        "Normalize file" for every file of the project
 *   Notation consistency                     \varepsilon / \epsilon, \le / \leq, ... across the project, with unify
 *   Terms                                    used before defined (\\emph{...}), defined but not in the index; \\index for the selected term
 *   Build parts                              only the chosen \part's of the main file
 *   \cite completion and hover               author, year, title from the .bib files
 *   Panel "Проблеми"                         errors, warnings and overfull boxes of the project as a tree
 * The logic without VS Code is in projectRefactorPure.js. */
const vscode = require('vscode');
const VT = require('./viewTitles');
const path = require('path');
const fs = require('fs');
const X = require('./projectRefactorPure');
const { tr } = require('./i18n');
const TERMS = require('./termsPure');
const C = require('./chaptersPure');
const P = require('./corePure');
const { excludeNow, SEL_ANY, cfg, debounce, errText, info, projectRoot, saveDocs, textOfPath, warn, warnUnsaved } = require('./util');
const { posix } = require('./corePure');

const SRC_GLOB = '**/*.{tex,tikz,cls,sty,bib}';

let ctx = null;


function needRoot() {
  const r = projectRoot();
  if (!r) warn(tr('Відкрий папку проєкту (workspace).'));
  return r;
}

const mainSettings = () => ({
  mainFile: cfg().get('mainFile', 'main.tex') || 'main.tex',
  macro: cfg().get('chapterIncludeMacro', '\\includechapter') || '\\includechapter',
  listMacros: (() => { const l = cfg().get('chapterListMacros', ['\\multiinclude']); return Array.isArray(l) ? l : []; })()
});


// the source files of the project: [{ path: 'rel/with/slashes', abs, text }]; `exts` limits the extensions
async function projectFiles(root, exts) {
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, SRC_GLOB), excludeNow(), 5000);
  const out = [];
  for (const u of found) {
    const ext = path.extname(u.fsPath).toLowerCase();
    if (exts && !exts.includes(ext)) continue;
    const text = textOfPath(u.fsPath);
    if (text === null) continue;
    out.push({ path: posix(path.relative(root, u.fsPath)), abs: u.fsPath, text });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
const TEXT_EXTS = ['.tex', '.tikz', '.cls', '.sty'];

// writes the new texts through one WorkspaceEdit (open documents stay consistent) and saves the touched files
async function applyChanges(root, changes) {
  if (!changes.size) return true;
  const edit = new vscode.WorkspaceEdit();
  const docs = [];
  for (const [rel, text] of changes) {
    const uri = vscode.Uri.file(path.join(root, rel));
    const doc = await vscode.workspace.openTextDocument(uri);
    docs.push(doc);
    const last = doc.lineAt(doc.lineCount - 1);
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount - 1, last.text.length), text);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return false;
  warnUnsaved(await saveDocs(docs));
  return true;
}

/* ================================== snapshots =============================== */
function snapRoot() {
  const base = ctx.globalStorageUri ? ctx.globalStorageUri.fsPath : ctx.globalStoragePath;
  return path.join(base, 'snapshots');
}

function listSnapshots(root) {
  const dir = snapRoot();
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const id of ids) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8'));
      if (!root || m.root === root) out.push(m);
    } catch (e) { /* not a snapshot */ }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

// copies the source files of the project (or `only`, relative paths) into a new snapshot; -> manifest
async function takeSnapshot(root, label, only) {
  const files = (await projectFiles(root, null)).filter((f) => !only || only.includes(f.path));
  // the id is the time to the second and the label: a second snapshot with the same label within a second must not overwrite the first
  const base = X.snapshotId(new Date(), label);
  let id = base;
  for (let n = 2; fs.existsSync(path.join(snapRoot(), id)); n++) id = base + '-' + n;
  const dir = path.join(snapRoot(), id);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const kept = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f.abs); } catch (e) { continue; }
    if (st.size > 20 * 1024 * 1024) continue;
    // the text on disk may differ from an open unsaved document: the snapshot keeps what is shown in the editor
    const dest = path.join(dir, 'files', f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.text, 'utf8');
    kept.push(f.path);
  }
  const manifest = { id, label: label || '', root, date: new Date().toISOString(), files: kept, moves: [] };
  writeManifest(manifest);
  for (const old of X.snapshotsToPrune(listSnapshots(null).map((m) => m.id), Math.max(1, Number(cfg().get('snapshotsKeep', 15)) || 15))) {
    try { fs.rmSync(path.join(snapRoot(), old), { recursive: true, force: true }); } catch (e) { /* stays */ }
  }
  return manifest;
}

function writeManifest(m) {
  fs.writeFileSync(path.join(snapRoot(), m.id, 'manifest.json'), JSON.stringify(m, null, 1), 'utf8');
}

async function makeSnapshotCmd() {
  const root = needRoot();
  if (!root) return;
  const label = await vscode.window.showInputBox({ prompt: tr('Назва знімка (можна порожню)'), value: '' });
  if (label === undefined) return;
  const m = await takeSnapshot(root, label.trim());
  info(tr('Знімок збережено: {0} файлів ({1}). Відновити: «Restore snapshot».', m.files.length, m.id));
}

async function restoreSnapshotCmd() {
  const root = needRoot();
  if (!root) return;
  const list = listSnapshots(root);
  if (!list.length) { info(tr('Знімків цього проєкту ще немає. Вони створюються перед перейменуванням розділу, заміною по проєкту, нормалізацією проєкту й командою «Make snapshot».')); return; }
  const pick = await vscode.window.showQuickPick(list.map((m) => ({
    label: m.label || tr('(без назви)'),
    description: new Date(m.date).toLocaleString(),
    detail: tr('{0} файлів', m.files.length) + (m.moves && m.moves.length ? tr(' · з перейменуванням папок') : ''),
    m
  })), { placeHolder: tr('Який знімок відновити?') });
  if (!pick) return;
  const m = pick.m;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) {
    const s = await warn(tr('Є незбережені файли. Їх треба зберегти перед відновленням.'), tr('Зберегти все'));
    if (s !== tr('Зберегти все')) return;
    await vscode.workspace.saveAll(false);
  }
  const go = await warn(tr('Відновити знімок «{0}»? {1} файлів буде перезаписано', m.label || m.id, m.files.length) +
    (m.moves && m.moves.length ? tr(', папки повернуться на старі місця') : '') + tr('. Поточний стан теж збережеться як знімок.'), { modal: true }, tr('Відновити'));
  if (go !== tr('Відновити')) return;
  await takeSnapshot(root, tr('перед відновленням {0}', m.id));
  try {
    for (const mv of (m.moves || []).slice().reverse()) {
      const from = path.join(root, mv.to);
      const to = path.join(root, mv.from);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    }
    for (const rel of m.files) {
      const src = path.join(snapRoot(), m.id, 'files', rel);
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  } catch (e) { warn(tr('Не вдалося відновити знімок: {0}', errText(e))); return; }
  await vscode.commands.executeCommand('tssworkflow.refreshChapters');
  info(tr('Знімок відновлено: {0} файлів.', m.files.length));
}

/* ================================ rename chapter ============================ */
function chapterFolders(root) {
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => !d.startsWith('.')); } catch (e) { return []; }
  return dirs.filter((d) => fs.existsSync(path.join(root, d, d + '.tex'))).sort((a, b) => a.localeCompare(b));
}

// the chapter name of what was clicked in the "Розділи" panel (an element with name/file) or picked from a list
async function chapterFromArg(root, arg, title) {
  if (arg && arg.kind === 'chapter' && arg.name) return arg.name;
  const file = arg && (arg.file || arg.fsPath);
  if (file) {
    const rel = posix(path.relative(root, file)).split('/');
    if (rel.length >= 2 && !rel[0].startsWith('..')) return rel[0];
  }
  const names = chapterFolders(root);
  if (!names.length) { warn(tr('У проєкті немає папок розділів X/X.tex.')); return null; }
  const p = await vscode.window.showQuickPick(names, { placeHolder: title });
  return p || null;
}

async function renameChapterCmd(arg) {
  const root = needRoot();
  if (!root) return;
  const oldName = await chapterFromArg(root, arg, tr('Який розділ перейменувати?'));
  if (!oldName) return;
  const folders = fs.readdirSync(root).map((d) => d.toLowerCase());
  const newName = await vscode.window.showInputBox({
    prompt: tr('Нова назва розділу «{0}» (папка, файл, списки в головному файлі, посилання)', oldName),
    value: oldName,
    validateInput: (v) => {
      if (!X.validChapterName(v)) return tr('Лише латинські літери, цифри, _ і -, починати з літери');
      if (v === oldName) return tr('Те саме ім’я');
      if (folders.includes(v.toLowerCase())) return tr('Така папка чи файл уже є');
      return null;
    }
  });
  if (!newName || newName === oldName) return;
  const ms = mainSettings();
  const files = await projectFiles(root, TEXT_EXTS);
  const plan = X.renameChapterTexts(files, oldName, newName, ms);
  const list = [...plan.changes.keys()];
  const ok = await warn(tr('Перейменувати розділ «{0}» → «{1}»? Папка {0}/ і файл {0}.tex перейменуються; ', oldName, newName) +
    tr('змін у {0} файлах', list.length) + (list.length ? ' (' + list.slice(0, 4).join(', ') + (list.length > 4 ? ', …' : '') + ')' : '') +
    tr(': у списках головного файла {0}, шляхів {1}, посилань {2}. Знімок проєкту збережеться.', plan.stat.main, plan.stat.paths, plan.stat.refs), { modal: true }, tr('Перейменувати'));
  if (ok !== tr('Перейменувати')) return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  const snap = await takeSnapshot(root, tr('перед перейменуванням {0} → {1}', oldName, newName));
  try {
    if (!(await applyChanges(root, plan.changes))) throw new Error(tr('VS Code не прийняв правки тексту'));
    const dirEdit = new vscode.WorkspaceEdit();
    dirEdit.renameFile(vscode.Uri.file(path.join(root, oldName)), vscode.Uri.file(path.join(root, newName)));
    if (!(await vscode.workspace.applyEdit(dirEdit))) fs.renameSync(path.join(root, oldName), path.join(root, newName));
    snap.moves.push({ from: oldName, to: newName });
    const fileEdit = new vscode.WorkspaceEdit();
    fileEdit.renameFile(vscode.Uri.file(path.join(root, newName, oldName + '.tex')), vscode.Uri.file(path.join(root, newName, newName + '.tex')));
    if (!(await vscode.workspace.applyEdit(fileEdit))) fs.renameSync(path.join(root, newName, oldName + '.tex'), path.join(root, newName, newName + '.tex'));
    snap.moves.push({ from: newName + '/' + oldName + '.tex', to: newName + '/' + newName + '.tex' });
    writeManifest(snap);
  } catch (e) {
    writeManifest(snap);
    warn(tr('Перейменування не завершено: {0}. Стан можна повернути командою «Restore snapshot».', errText(e)));
    return;
  }
  // what is left: the old name as a word in code, and other files of the folder that carry it in their name
  const left = [];
  const wordRe = new RegExp('(?<![A-Za-z0-9_])' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])');
  for (const f of await projectFiles(root, TEXT_EXTS)) {
    const n = f.text.split('\n').filter((l) => wordRe.test(C.stripComment(l))).length;
    if (n) left.push(f.path + ' (' + n + ')');
  }
  const others = (() => { try { return fs.readdirSync(path.join(root, newName)).filter((n) => n.startsWith(oldName) && n !== newName + '.tex'); } catch (e) { return []; } })();
  await vscode.commands.executeCommand('tssworkflow.refreshChapters');
  info(tr('Розділ перейменовано: {0} → {1}.', oldName, newName) +
    (left.length ? tr(' Слово «{0}» лишилось у коді: {1} (перевір).', oldName, left.slice(0, 3).join(', ') + (left.length > 3 ? ', …' : '')) : '') +
    (others.length ? tr(' У папці є файли з старою назвою: {0}.', others.slice(0, 3).join(', ')) : ''));
}

async function moveChapterCmd(arg, dir) {
  const root = needRoot();
  if (!root) return;
  const name = await chapterFromArg(root, arg, tr('Який розділ пересунути?'));
  if (!name) return;
  const ms = mainSettings();
  const abs = path.join(root, ms.mainFile);
  const text = textOfPath(abs);
  if (text === null) { warn(tr('Не знайдено {0} (налаштування tssworkflow.mainFile).', ms.mainFile)); return; }
  const r = X.moveChapter(text, name, dir, ms.macro, ms.listMacros);
  if (r.error === 'notfound') { warn(tr('Розділу «{0}» немає у списках головного файла (він не підключений).', name)); return; }
  if (r.error === 'first') { info(tr('«{0}» уже перший.', name)); return; }
  if (r.error === 'last') { info(tr('«{0}» уже останній.', name)); return; }
  if (r.error) return;
  if (!(await applyChanges(root, new Map([[ms.mainFile, r.text]])))) { warn(tr('Не вдалося змінити {0}', ms.mainFile)); return; }
  await vscode.commands.executeCommand('tssworkflow.refreshChapters');
  vscode.window.setStatusBarMessage(dir < 0 ? tr('«{0}» вище за «{1}»', name, r.with) : tr('«{0}» нижче за «{1}»', name, r.with), 4000);
}

/* ============================= replace in project =========================== */
// reports are untitled Markdown documents; every \"Розділ/Розділ.tex:12\" in them is a link that opens the file at that line
const reports = new Map(); // uri of the report -> { root, doc, regen (async () => new Markdown, or null) }
const reportLinks = {
  provideDocumentLinks(doc) {
    const rp = reports.get(doc.uri.toString());
    const root = rp && rp.root;
    if (!root) return [];
    const links = [];
    for (let i = 0; i < doc.lineCount; i++) {
      for (const r of TERMS.fileLineRefs(doc.lineAt(i).text)) {
        const abs = path.resolve(root, r.rel);
        if (abs !== root && !abs.startsWith(root + path.sep)) continue; // only inside the project
        if (!fs.existsSync(abs)) continue;
        const link = new vscode.DocumentLink(new vscode.Range(i, r.start, i, r.start + r.len), vscode.Uri.file(abs).with({ fragment: 'L' + r.line + (r.col ? ',' + r.col : '') }));
        link.tooltip = r.col ? tr('Відкрити {0}, рядок {1}, стовпець {2}', r.rel, r.line, r.col) : tr('Відкрити {0}, рядок {1}', r.rel, r.line);
        links.push(link);
      }
    }
    return links;
  }
};

// "↻ Оновити звіт" above the first line of a report that can be built again
const reportLens = {
  provideCodeLenses(doc) {
    const rp = reports.get(doc.uri.toString());
    if (!rp || !rp.regen) return [];
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: tr('↻ Оновити звіт'), command: 'tssworkflow._refreshReport', arguments: [doc.uri.toString()] })];
  }
};

const refreshing = new Set();
async function refreshReport(uri) {
  const rp = reports.get(String(uri));
  if (!rp || !rp.regen || !rp.doc || rp.doc.isClosed || refreshing.has(String(uri))) return;
  refreshing.add(String(uri));
  try {
    const md = await rp.regen();
    const whole = new vscode.Range(0, 0, rp.doc.lineCount, 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(rp.doc.uri, rp.doc.validateRange ? rp.doc.validateRange(whole) : whole, md);
    if (!(await vscode.workspace.applyEdit(edit))) { warn(tr('VS Code не прийняв оновлення звіту.')); return; }
    vscode.window.setStatusBarMessage(tr('Звіт оновлено'), 3000);
  } catch (e) {
    warn(tr('Не вдалося оновити звіт: {0}', errText(e)));
  } finally { refreshing.delete(String(uri)); }
}

// regen: how to build the same report again (a report that cannot be built again has no button)
async function reportDoc(md, root, regen) {
  const d = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  if (root) reports.set(d.uri.toString(), { root, doc: d, regen: regen || null });
  return vscode.window.showTextDocument(d, { preview: false });
}

// the project files that are searched, the matches; a report of them
async function scanReplace(root, find, repl, o) {
  const files = await projectFiles(root, TEXT_EXTS);
  const changes = new Map();
  const per = [];
  let total = 0;
  const hits = [];
  for (const f of files) {
    const r = X.replaceInText(f.text, find, repl, o);
    if (r.error) return { error: r.error };
    if (r.count) {
      changes.set(f.path, r.text);
      per.push(f.path + ' (' + r.count + ')');
      total += r.count;
      const lines = f.text.split('\n');
      for (const h of r.hits.slice(0, 30)) hits.push(f.path + ':' + (h.line + 1) + '  ' + lines[h.line].trim().slice(0, 110));
    }
  }
  return { changes, per, total, hits };
}
const replaceMd = (find, repl, sc) => tr('# Збіги «{0}» → «{1}»', find, repl) + '\n\n' + sc.per.join('\n') + '\n\n```\n' + sc.hits.slice(0, 200).join('\n') + '\n```\n';

async function replaceInProjectCmd() {
  const root = needRoot();
  if (!root) return;
  const ed = vscode.window.activeTextEditor;
  const sel = ed && !ed.selection.isEmpty && ed.selection.isSingleLine ? ed.document.getText(ed.selection) : '';
  const find = await vscode.window.showInputBox({ prompt: tr('Що замінити в проєкті (коментарі й verbatim не чіпаються)'), value: sel });
  if (!find) return;
  const repl = await vscode.window.showInputBox({ prompt: tr('На що замінити (у режимі регулярного виразу: $1, $2, $&)'), value: '' });
  if (repl === undefined) return;
  const opts = await vscode.window.showQuickPick([
    { label: tr('Регулярний вираз'), key: 'regex', picked: false },
    { label: tr('Макрос цілком (\\vect не збігається з \\vectX)'), key: 'wholeMacro', picked: true },
    { label: tr('Враховувати регістр'), key: 'caseSensitive', picked: true }
  ], { canPickMany: true, placeHolder: tr('Параметри пошуку') });
  if (!opts) return;
  const has = (k) => opts.some((o) => o.key === k);
  const o = { regex: has('regex'), wholeMacro: has('wholeMacro'), caseSensitive: has('caseSensitive') };
  const sc = await scanReplace(root, find, repl, o);
  if (sc.error) { warn(tr('Некоректний вираз: {0}', sc.error)); return; }
  const { changes, per, total } = sc;
  if (!total) { info(tr('Збігів не знайдено.')); return; }
  const msg = tr('Знайдено {0} збігів у {1} файлах ({2}). Замінити? Знімок проєкту збережеться.', total, changes.size, per.slice(0, 3).join(', ') + (per.length > 3 ? ', …' : ''));
  const pick = await warn(msg, tr('Замінити'), tr('Показати список'));
  if (pick === tr('Показати список')) {
    await reportDoc(replaceMd(find, repl, sc), root, async () => { const again = await scanReplace(root, find, repl, o); return again.error ? tr('# Збіги\n\nНекоректний вираз: {0}\n', again.error) : again.total ? replaceMd(find, repl, again) : tr('# Збіги «{0}» → «{1}»\n\nЗбігів не знайдено.\n', find, repl); });
    if ((await info(tr('Замінити {0} збігів?', total), tr('Замінити'))) !== tr('Замінити')) return;
  } else if (pick !== tr('Замінити')) return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  await takeSnapshot(root, tr('перед заміною {0} → {1}', find, repl));
  if (!(await applyChanges(root, changes))) { warn(tr('VS Code не прийняв правки.')); return; }
  info(tr('Замінено {0} у {1} файлах. Повернути: «Restore snapshot».', total, changes.size));
}

/* ============================= normalize project ============================ */
async function normalizeProjectCmd(api) {
  const root = needRoot();
  if (!root) return;
  const c = cfg();
  const framesOn = c.get('normalizeFrames', true);
  const fr = framesOn && api.frameSettings ? api.frameSettings() : null;
  const mk = (isTikz) => ({
    typography: c.get('normalizeTypography', true),
    quotes: c.get('quoteStyle', 'guillemets'),
    displayMath: c.get('displayMathToEquation', true),
    tables: c.get('normalizeTables', true),
    lineBreaks: c.get('normalizeLineBreaks', 'keep'),
    wrapWidth: c.get('wrapWidth', 90),
    tabSize: 4,
    frames: fr,
    blankLines: c.get('normalizeBlankLines', true)
      ? { paragraph: c.get('blankLinesParagraph', 1), heading: c.get('blankLinesHeading', 2) }
      : null,
    isTikz
  });
  const files = await projectFiles(root, ['.tex', '.tikz']);
  const changes = new Map();
  for (const f of files) {
    const eol = f.text.includes('\r\n') ? '\r\n' : '\n';
    const old = f.text.split(/\r?\n/);
    const res = P.normalizeLines(old, mk(f.path.toLowerCase().endsWith('.tikz')));
    const neu = res.lines.join(eol);
    if (neu !== f.text) changes.set(f.path, neu);
  }
  if (!changes.size) { info(tr('Нормалізація проєкту: змін немає ({0} файлів перевірено).', files.length)); return; }
  const list = [...changes.keys()];
  const go = await warn(tr('Нормалізувати {0} з {1} файлів ({2}) кроками з налаштувань «Normalize file»? Знімок проєкту збережеться.', changes.size, files.length, list.slice(0, 3).join(', ') + (list.length > 3 ? ', …' : '')), { modal: true }, tr('Нормалізувати'));
      if (go !== tr('Нормалізувати')) return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  await takeSnapshot(root, tr('перед нормалізацією проєкту'));
  if (!(await applyChanges(root, changes))) { warn(tr('VS Code не прийняв правки.')); return; }
  info(tr('Нормалізовано {0} файлів. Повернути: «Restore snapshot».', changes.size));
}

/* ============================== notation consistency ======================== */
async function notationCmd() {
  const root = needRoot();
  if (!root) return;
  const custom = cfg().get('notationGroups', []);
  const groups = Array.isArray(custom) && custom.length ? custom : X.NOTATION_DEFAULT;
  const files = await projectFiles(root, ['.tex', '.tikz', '.sty', '.cls']);
  const rep = X.notationReport(files, groups);
  await reportDoc(X.formatNotationReport(rep, { folder: path.basename(root) }), root, async () => {
    const g = cfg().get('notationGroups', []);
    return X.formatNotationReport(X.notationReport(await projectFiles(root, ['.tex', '.tikz', '.sty', '.cls']), Array.isArray(g) && g.length ? g : X.NOTATION_DEFAULT), { folder: path.basename(root) });
  });
  const mixed = rep.filter((r) => r.mixed);
  if (!mixed.length) return;
  const g = await vscode.window.showQuickPick(mixed.map((r) => ({
    label: tr(r.name), description: r.variants.map((v) => tr(v.label) + ' ' + v.count).join(' · '), r
  })), { placeHolder: tr('Уніфікувати позначення? (Esc: лише звіт)') });
  if (!g) return;
  const best = g.r.variants.slice().sort((a, b) => b.count - a.count)[0];
  const t = await vscode.window.showQuickPick(g.r.variants.map((v) => ({
    label: tr(v.label), description: tr('{0} разів', v.count) + (v === best ? tr(' · найчастіше') : ''), v
  })), { placeHolder: tr('До якого запису привести решту?') });
  if (!t) return;
  const plan = X.notationUnify(files, g.r.group, t.v.label);
  if (!plan.count) { info(tr('Нічого міняти.')); return; }
  const go = await warn(tr('Замінити {0} записів на {1} у {2} файлах? Знімок проєкту збережеться.', plan.count, tr(t.v.label), plan.changes.size), { modal: true }, tr('Замінити'));
  if (go !== tr('Замінити')) return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  await takeSnapshot(root, tr('перед уніфікацією {0}', tr(t.v.label)));
  if (!(await applyChanges(root, plan.changes))) { warn(tr('VS Code не прийняв правки.')); return; }
  info(tr('Уніфіковано: {0} замін у {1} файлах.', plan.count, plan.changes.size));
}

/* ================================== terms =================================== */
// the first lines of the main file decide whether the subject index exists: % !TEX indexprogram = upmendex (workspacePure.indexProgram)
function indexOfMain(root) {
  const t = textOfPath(path.join(root, mainSettings().mainFile));
  return t === null ? { name: '', raw: '' } : P.indexProgram(t);
}

// the files in the order of the book, the report and its Markdown
async function termsCompute(root) {
  const ms = mainSettings();
  const mainText = textOfPath(path.join(root, ms.mainFile));
  const order = mainText === null ? [] : C.chapterNames(mainText, ms.macro, ms.listMacros);
  const files = (await projectFiles(root, ['.tex'])).sort(TERMS.byBookOrder(order));
  const ip = indexOfMain(root);
  const macros = cfg().get('termMacros', ['\\emph']);
  const ignore = cfg().get('termsIgnore', []);
  const forms = cfg().get('termsForms', []);
  const mac = Array.isArray(macros) ? macros : ['\\emph'];
  const rep = TERMS.termsReport(files, { macros: mac, ignore: Array.isArray(ignore) ? ignore : [], forms: Array.isArray(forms) ? forms : [], index: !!ip.name });
  return { files, ip, rep, md: TERMS.formatTermsReport(rep, { folder: path.basename(root), macros: Array.isArray(macros) ? macros : [], index: !!ip.name }) };
}

async function termsCmd() {
  const root = needRoot();
  if (!root) return;
  const { files, ip, rep, md } = await termsCompute(root);
  await reportDoc(md, root, async () => (await termsCompute(root)).md);
  if (ip.raw && !ip.name) warn(tr('indexprogram = {0}: підтримуються upmendex, mendex, makeindex. Покажчик не збирається.', ip.raw));
  if (!rep.noIndex.length) return;
  const go = await warn(tr('Додати \\index{…} після першого означення {0} термінів, яких немає в покажчику? «Додати» бере запис з написання в означенні (воно може бути не в називному відмінку), «Уточнити форми…» питає запис для кожного терміна. Знімок проєкту збережеться.', rep.noIndex.length), { modal: true }, tr('Додати'), tr('Уточнити форми…'));
  if (go !== tr('Додати') && go !== tr('Уточнити форми…')) return;
  let entries = null;
  if (go === tr('Уточнити форми…')) {
    entries = new Map();
    for (const t of rep.noIndex) {
      const v = await vscode.window.showInputBox({
        prompt: tr('Запис покажчика для «{0}» ({1}:{2}). Впиши називний відмінок. Порожньо: пропустити цей термін; Esc: скасувати все', t.term, t.def.path, t.def.line),
        value: t.term,
        ignoreFocusOut: true
      });
      if (v === undefined) return;
      const e = TERMS.indexEntryFor(v);
      if (e) entries.set(t.term, v.trim());
    }
    if (!entries.size) { info(tr('Жодного запису не додано.')); return; }
  }
  const plan = TERMS.indexInsertions(files, rep, entries);
  if (!plan.size) { info(tr('Нічого додавати.')); return; }
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  await takeSnapshot(root, tr('перед додаванням \\index до термінів'));
  if (!(await applyChanges(root, plan))) { warn(tr('VS Code не прийняв правки.')); return; }
  info(tr('Додано \\index до {0} термінів у {1} файлах. Повернути: «Restore snapshot».', entries ? entries.size : rep.noIndex.length, plan.size));
}

// \index{...} right after the selected word or phrase (after every selection); without a selection the word under the cursor
async function indexTermCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !(ed.document.languageId === 'latex' || ed.document.languageId === 'tex')) { info(tr('Виділи термін у файлі .tex.')); return; }
  const doc = ed.document;
  const word = /[\p{L}\p{M}][\p{L}\p{M}'’ʼ-]*/u;
  const ranges = ed.selections.map((sel) => (sel.isEmpty ? doc.getWordRangeAtPosition(sel.active, word) : sel)).filter(Boolean);
  const items = ranges.map((r) => ({ at: r.end, entry: TERMS.indexEntryFor(doc.getText(r)) })).filter((x) => x.entry);
  if (!items.length) { info(tr('Виділи термін (або постав курсор у слово).')); return; }
  await ed.edit((b) => { for (const x of items) b.replace(new vscode.Range(x.at.line, x.at.character, x.at.line, x.at.character), '\\index{' + x.entry + '}'); });
  const root = projectRoot();
  if (root && !indexOfMain(root).name) vscode.window.setStatusBarMessage(tr('\\index додано, але покажчик не збиратиметься: у головному файлі немає % !TEX indexprogram = upmendex'), 6000);
}

/* ================================== build parts ============================= */
async function buildPartsCmd() {
  const root = needRoot();
  if (!root) return;
  const ms = mainSettings();
  const abs = path.join(root, ms.mainFile);
  const text = textOfPath(abs);
  if (text === null) { warn(tr('Не знайдено {0} (налаштування tssworkflow.mainFile).', ms.mainFile)); return; }
  const parts = C.chapterStructure(text, ms.macro, ms.listMacros);
  if (parts.length < 2) { info(tr('У {0} менше двох частин (\\part): збирай розділ чи весь документ.', ms.mainFile)); return; }
  const picks = await vscode.window.showQuickPick(parts.map((p, i) => ({
    label: p.title || tr('(розділи до першої \\part)'), description: tr('{0} розд.: {1}', p.names.length, p.names.slice(0, 4).join(', ') + (p.names.length > 4 ? ', …' : '')), i
  })), { canPickMany: true, placeHolder: tr('Які частини зібрати?') });
  if (!picks || !picks.length) return;
  const base = path.basename(ms.mainFile, path.extname(ms.mainFile));
  const outRel = base + '-parts.tex';
  const filtered = X.filterMainForParts(text, ms.macro, ms.listMacros, picks.map((p) => p.i));
  try { fs.writeFileSync(path.join(root, outRel), filtered, 'utf8'); } catch (e) { warn(tr('Не вдалося записати {0}: {1}', outRel, errText(e))); return; }
  vscode.window.setStatusBarMessage(tr('Збірка частин: {0}', picks.map((p) => p.label).join(', ')), 5000);
  await vscode.commands.executeCommand('tssworkflow._compileFile', { file: outRel, openPdf: true });
}

/* ============================== \cite: completion, hover =================== */
let bibCache = null;
async function bibEntries() {
  if (bibCache) return bibCache;
  const out = [];
  const found = await vscode.workspace.findFiles('**/*.bib', excludeNow(), 200);
  for (const u of found) {
    const t = textOfPath(u.fsPath);
    if (t === null) continue;
    for (const e of X.parseBibEntries(t)) out.push(Object.assign(e, { file: u.fsPath }));
  }
  bibCache = out;
  return out;
}

const citeCompletion = {
  async provideCompletionItems(doc, pos) {
    if (!cfg().get('citeCompletion', true)) return undefined;
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const m = X.CITE_CTX.exec(before);
    if (!m) return undefined;
    const typed = m[1].slice(m[1].lastIndexOf(',') + 1);
    const lead = typed.length - typed.trimStart().length;
    const range = new vscode.Range(pos.line, pos.character - typed.length + lead, pos.line, pos.character);
    const items = [];
    const seen = new Set();
    for (const e of await bibEntries()) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const who = X.shortAuthors(e.author);
      const it = new vscode.CompletionItem({ label: e.key, description: (who + (e.year ? ' ' + e.year : '')).trim() || undefined }, vscode.CompletionItemKind.Reference);
      it.detail = e.title || undefined;
      it.documentation = [e.author, e.journal, path.basename(e.file) + ':' + (e.line + 1)].filter(Boolean).join('\n');
      it.range = range;
      it.filterText = e.key + ' ' + e.author + ' ' + e.title;
      it.sortText = e.key;
      items.push(it);
    }
    return items;
  }
};

const citeHover = {
  async provideHover(doc, pos) {
    if (!cfg().get('citeCompletion', true)) return undefined;
    const line = doc.lineAt(pos.line).text;
    if (!/cite/.test(line)) return undefined;
    const hit = P.scanCites(line).cites.find((c) => pos.character >= c.col && pos.character <= c.col + c.len);
    if (!hit) return undefined;
    const e = (await bibEntries()).find((x) => x.key === hit.name);
    if (!e) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**' + e.key + '** · ' + (X.shortAuthors(e.author) || '—') + (e.year ? ' (' + e.year + ')' : ''));
    if (e.title) md.appendMarkdown('\n\n*' + e.title.replace(/[*_`]/g, '\\$&') + '*');
    if (e.journal) md.appendMarkdown('\n\n' + e.journal.replace(/[*_`]/g, '\\$&'));
    return new vscode.Hover(md, new vscode.Range(pos.line, hit.col, pos.line, hit.col + hit.len));
  }
};

/* ================================= problems panel =========================== */
const SEV = ['error', 'warning', 'information', 'hint'];
const SOURCE_RE = /TSS|LaTeX|texlog|pplatex/i;

function collectProblems(root) {
  const out = [];
  for (const [uri, ds] of vscode.languages.getDiagnostics()) {
    if (!uri || uri.scheme !== 'file') continue;
    const rel = root ? posix(path.relative(root, uri.fsPath)) : uri.fsPath;
    if (rel.startsWith('..')) continue;
    for (const d of ds) {
      if (!SOURCE_RE.test(String(d.source || ''))) continue;
      out.push({ file: rel, abs: uri.fsPath, line: d.range.start.line, severity: SEV[d.severity] || 'hint', message: String(d.message).split('\n')[0], source: d.source });
    }
  }
  return out;
}

class ProblemsProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    this.view = null;
  }
  refresh() { this._em.fire(); }
  getTreeItem(el) { return el.item; }
  getChildren(el) {
    if (el) return el.children || [];
    const root = projectRoot();
    const list = collectProblems(root);
    const groups = X.groupProblems(list);
    const icon = { error: 'error', warning: 'warning', box: 'symbol-ruler', other: 'info' };
    const items = groups.map((g) => {
      const byFile = new Map();
      for (const d of g.items) { if (!byFile.has(d.file)) byFile.set(d.file, []); byFile.get(d.file).push(d); }
      const item = new vscode.TreeItem(g.label + ' (' + g.items.length + ')', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'tssworkflow.problems.' + g.id;
      item.iconPath = new vscode.ThemeIcon(icon[g.id]);
      const children = [...byFile].map(([file, ds]) => {
        const fi = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.Expanded);
        fi.id = 'tssworkflow.problems.' + g.id + '.' + file;
        fi.description = String(ds.length);
        fi.iconPath = vscode.ThemeIcon.File;
        fi.resourceUri = vscode.Uri.file(ds[0].abs);
        return {
          item: fi,
          children: ds.map((d, k) => {
            const ii = new vscode.TreeItem((d.line + 1) + ': ' + d.message, vscode.TreeItemCollapsibleState.None);
            ii.id = fi.id + ':' + k + ':' + d.line;
            ii.tooltip = d.message + (d.source ? ' · ' + d.source : '');
            ii.command = { command: 'vscode.open', title: tr('Відкрити'), arguments: [vscode.Uri.file(d.abs), { selection: new vscode.Range(d.line, 0, d.line, 0), preview: false }] };
            return { item: ii };
          })
        };
      });
      return { item, children };
    });
    if (this.view) {
      const n = list.filter((d) => d.severity === 'error' || d.severity === 'warning').length;
      this.view.badge = n ? { value: n, tooltip: tr('Помилок і попереджень: {0}', n) } : undefined;
      this.view.message = list.length ? undefined : tr('✓ Проблем (TSS Workflow, лог LaTeX) немає');
    }
    return items;
  }
}

/* ================================== register ================================ */
function register(context, api) {
  ctx = context;
  api = api || {};
  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  const problems = new ProblemsProvider();
  const view = VT.track(vscode.window.createTreeView('tssworkflow.problemsView', { treeDataProvider: problems, showCollapseAll: true }), 'tssworkflow.problemsView');
  problems.view = view;
  const later = () => debounce('problems.refresh', 300, () => problems.refresh());
  const resetBib = (d) => { if (!d || /\.bib$/i.test(d.fileName || '')) bibCache = null; };
  context.subscriptions.push(
    view,
    vscode.languages.onDidChangeDiagnostics(later),
    vscode.workspace.onDidSaveTextDocument(resetBib),
    cmd('tssworkflow.refreshProblems', () => problems.refresh()),
    cmd('tssworkflow.renameChapter', renameChapterCmd),
    cmd('tssworkflow.moveChapterUp', (arg) => moveChapterCmd(arg, -1)),
    cmd('tssworkflow.moveChapterDown', (arg) => moveChapterCmd(arg, +1)),
    cmd('tssworkflow.replaceInProject', replaceInProjectCmd),
    cmd('tssworkflow.makeSnapshot', makeSnapshotCmd),
    cmd('tssworkflow.restoreSnapshot', restoreSnapshotCmd),
    cmd('tssworkflow.normalizeProject', () => normalizeProjectCmd(api)),
    cmd('tssworkflow.notationReport', notationCmd),
    cmd('tssworkflow.termsReport', termsCmd),
    cmd('tssworkflow.indexTerm', indexTermCmd),
    cmd('tssworkflow.buildParts', buildPartsCmd),
    cmd('tssworkflow._refreshReport', refreshReport),
    vscode.languages.registerDocumentLinkProvider({ language: 'markdown', scheme: 'untitled' }, reportLinks),
    vscode.languages.registerCodeLensProvider({ language: 'markdown', scheme: 'untitled' }, reportLens),
    vscode.workspace.onDidCloseTextDocument((d) => reports.delete(d.uri.toString())),
    vscode.languages.registerCompletionItemProvider(SEL_ANY, citeCompletion, '{', ','),
    vscode.languages.registerHoverProvider(SEL_ANY, citeHover)
  );
  if (vscode.workspace.createFileSystemWatcher) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.bib');
    context.subscriptions.push(w, w.onDidChange(() => { bibCache = null; }), w.onDidCreate(() => { bibCache = null; }), w.onDidDelete(() => { bibCache = null; }));
  }
}

exports.register = register;
exports.reportDoc = reportDoc; // the report documents of other modules (preflight.js) get the same links and the refresh lens
exports._t = { collectProblems, ProblemsProvider, citeCompletion, citeHover, takeSnapshot, listSnapshots };
