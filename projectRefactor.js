'use strict';
/* TSS Workflow 0.5.0:
 *   Rename chapter / Move chapter up, down   a chapter folder X/X.tex is renamed with the main file, paths and references
 *   Replace in project                       LaTeX-aware search and replace (not in comments and verbatim), with a snapshot
 *   Snapshots                                Make snapshot / Restore snapshot (also taken before every project-wide change)
 *   Normalize project                        "Normalize file" for every file of the project
 *   Notation consistency                     \varepsilon / \epsilon, \le / \leq, ... across the project, with unify
 *   Build parts                              only the chosen \part's of the main file
 *   \cite completion and hover               author, year, title from the .bib files
 *   Panel "Проблеми"                         errors, warnings and overfull boxes of the project as a tree
 * The logic without VS Code is in projectRefactorPure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const X = require('./projectRefactorPure');
const C = require('./chaptersPure');
const P = require('./corePure');
const { EXCLUDE, SEL_ANY, cfg, errText, info, projectRoot, textOfPath, warn } = require('./util');
const { posix } = require('./corePure');

const SRC_GLOB = '**/*.{tex,tikz,cls,sty,bib}';

let ctx = null;


function needRoot() {
  const r = projectRoot();
  if (!r) warn('Відкрий папку проєкту (workspace).');
  return r;
}

const mainSettings = () => ({
  mainFile: cfg().get('mainFile', 'main.tex') || 'main.tex',
  macro: cfg().get('chapterIncludeMacro', '\\includechapter') || '\\includechapter',
  listMacros: (() => { const l = cfg().get('chapterListMacros', ['\\multiinclude']); return Array.isArray(l) ? l : []; })()
});


// the source files of the project: [{ path: 'rel/with/slashes', abs, text }]; `exts` limits the extensions
async function projectFiles(root, exts) {
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, SRC_GLOB), EXCLUDE, 5000);
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
  for (const d of docs) { try { await d.save(); } catch (e) { /* the file stays modified in the editor */ } }
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
  const id = X.snapshotId(new Date(), label);
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
  const label = await vscode.window.showInputBox({ prompt: 'Назва знімка (можна порожню)', value: '' });
  if (label === undefined) return;
  const m = await takeSnapshot(root, label.trim());
  info('Знімок збережено: ' + m.files.length + ' файлів (' + m.id + '). Відновити: «Restore snapshot».');
}

async function restoreSnapshotCmd() {
  const root = needRoot();
  if (!root) return;
  const list = listSnapshots(root);
  if (!list.length) { info('Знімків цього проєкту ще немає. Вони створюються перед перейменуванням розділу, заміною по проєкту, нормалізацією проєкту й командою «Make snapshot».'); return; }
  const pick = await vscode.window.showQuickPick(list.map((m) => ({
    label: m.label || '(без назви)',
    description: new Date(m.date).toLocaleString(),
    detail: m.files.length + ' файлів' + (m.moves && m.moves.length ? ' · з перейменуванням папок' : ''),
    m
  })), { placeHolder: 'Який знімок відновити?' });
  if (!pick) return;
  const m = pick.m;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) {
    const s = await warn('Є незбережені файли. Їх треба зберегти перед відновленням.', 'Зберегти все');
    if (s !== 'Зберегти все') return;
    await vscode.workspace.saveAll(false);
  }
  const go = await warn('Відновити знімок «' + (m.label || m.id) + '»? ' + m.files.length + ' файлів буде перезаписано' +
    (m.moves && m.moves.length ? ', папки повернуться на старі місця' : '') + '. Поточний стан теж збережеться як знімок.', { modal: true }, 'Відновити');
  if (go !== 'Відновити') return;
  await takeSnapshot(root, 'перед відновленням ' + m.id);
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
  } catch (e) { warn('Не вдалося відновити знімок: ' + errText(e)); return; }
  await vscode.commands.executeCommand('tssworkflow.refreshChapters');
  info('Знімок відновлено: ' + m.files.length + ' файлів.');
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
  if (!names.length) { warn('У проєкті немає папок розділів X/X.tex.'); return null; }
  const p = await vscode.window.showQuickPick(names, { placeHolder: title });
  return p || null;
}

async function renameChapterCmd(arg) {
  const root = needRoot();
  if (!root) return;
  const oldName = await chapterFromArg(root, arg, 'Який розділ перейменувати?');
  if (!oldName) return;
  const folders = fs.readdirSync(root).map((d) => d.toLowerCase());
  const newName = await vscode.window.showInputBox({
    prompt: 'Нова назва розділу «' + oldName + '» (папка, файл, списки в головному файлі, посилання)',
    value: oldName,
    validateInput: (v) => {
      if (!X.validChapterName(v)) return 'Лише латинські літери, цифри, _ і -, починати з літери';
      if (v === oldName) return 'Те саме ім’я';
      if (folders.includes(v.toLowerCase())) return 'Така папка чи файл уже є';
      return null;
    }
  });
  if (!newName || newName === oldName) return;
  const ms = mainSettings();
  const files = await projectFiles(root, TEXT_EXTS);
  const plan = X.renameChapterTexts(files, oldName, newName, ms);
  const list = [...plan.changes.keys()];
  const ok = await warn('Перейменувати розділ «' + oldName + '» → «' + newName + '»? Папка ' + oldName + '/ і файл ' + oldName + '.tex перейменуються; ' +
    'змін у ' + list.length + ' файлах' + (list.length ? ' (' + list.slice(0, 4).join(', ') + (list.length > 4 ? ', …' : '') + ')' : '') +
    ': у списках головного файла ' + plan.stat.main + ', шляхів ' + plan.stat.paths + ', посилань ' + plan.stat.refs + '. Знімок проєкту збережеться.', { modal: true }, 'Перейменувати');
  if (ok !== 'Перейменувати') return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  const snap = await takeSnapshot(root, 'перед перейменуванням ' + oldName + ' → ' + newName);
  try {
    if (!(await applyChanges(root, plan.changes))) throw new Error('VS Code не прийняв правки тексту');
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
    warn('Перейменування не завершено: ' + errText(e) + '. Стан можна повернути командою «Restore snapshot».');
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
  info('Розділ перейменовано: ' + oldName + ' → ' + newName + '.' +
    (left.length ? ' Слово «' + oldName + '» лишилось у коді: ' + left.slice(0, 3).join(', ') + (left.length > 3 ? ', …' : '') + ' (перевір).' : '') +
    (others.length ? ' У папці є файли з старою назвою: ' + others.slice(0, 3).join(', ') + '.' : ''));
}

async function moveChapterCmd(arg, dir) {
  const root = needRoot();
  if (!root) return;
  const name = await chapterFromArg(root, arg, 'Який розділ пересунути?');
  if (!name) return;
  const ms = mainSettings();
  const abs = path.join(root, ms.mainFile);
  const text = textOfPath(abs);
  if (text === null) { warn('Не знайдено ' + ms.mainFile + ' (налаштування tssworkflow.mainFile).'); return; }
  const r = X.moveChapter(text, name, dir, ms.macro, ms.listMacros);
  if (r.error === 'notfound') { warn('Розділу «' + name + '» немає у списках головного файла (він не підключений).'); return; }
  if (r.error === 'first') { info('«' + name + '» уже перший.'); return; }
  if (r.error === 'last') { info('«' + name + '» уже останній.'); return; }
  if (r.error) return;
  if (!(await applyChanges(root, new Map([[ms.mainFile, r.text]])))) { warn('Не вдалося змінити ' + ms.mainFile); return; }
  await vscode.commands.executeCommand('tssworkflow.refreshChapters');
  vscode.window.setStatusBarMessage('«' + name + '» ' + (dir < 0 ? 'вище' : 'нижче') + ' за «' + r.with + '»', 4000);
}

/* ============================= replace in project =========================== */
function reportDoc(md) {
  return vscode.workspace.openTextDocument({ language: 'markdown', content: md }).then((d) => vscode.window.showTextDocument(d, { preview: false }));
}

async function replaceInProjectCmd() {
  const root = needRoot();
  if (!root) return;
  const ed = vscode.window.activeTextEditor;
  const sel = ed && !ed.selection.isEmpty && ed.selection.isSingleLine ? ed.document.getText(ed.selection) : '';
  const find = await vscode.window.showInputBox({ prompt: 'Що замінити в проєкті (коментарі й verbatim не чіпаються)', value: sel });
  if (!find) return;
  const repl = await vscode.window.showInputBox({ prompt: 'На що замінити (у режимі регулярного виразу: $1, $2, $&)', value: '' });
  if (repl === undefined) return;
  const opts = await vscode.window.showQuickPick([
    { label: 'Регулярний вираз', key: 'regex', picked: false },
    { label: 'Макрос цілком (\\vect не збігається з \\vectX)', key: 'wholeMacro', picked: true },
    { label: 'Враховувати регістр', key: 'caseSensitive', picked: true }
  ], { canPickMany: true, placeHolder: 'Параметри пошуку' });
  if (!opts) return;
  const has = (k) => opts.some((o) => o.key === k);
  const o = { regex: has('regex'), wholeMacro: has('wholeMacro'), caseSensitive: has('caseSensitive') };
  const files = await projectFiles(root, TEXT_EXTS);
  const changes = new Map();
  const per = [];
  let total = 0;
  const hits = [];
  for (const f of files) {
    const r = X.replaceInText(f.text, find, repl, o);
    if (r.error) { warn('Некоректний вираз: ' + r.error); return; }
    if (r.count) {
      changes.set(f.path, r.text);
      per.push(f.path + ' (' + r.count + ')');
      total += r.count;
      const lines = f.text.split('\n');
      for (const h of r.hits.slice(0, 30)) hits.push(f.path + ':' + (h.line + 1) + '  ' + lines[h.line].trim().slice(0, 110));
    }
  }
  if (!total) { info('Збігів не знайдено.'); return; }
  const msg = 'Знайдено ' + total + ' збігів у ' + changes.size + ' файлах (' + per.slice(0, 3).join(', ') + (per.length > 3 ? ', …' : '') + '). Замінити? Знімок проєкту збережеться.';
  const pick = await warn(msg, 'Замінити', 'Показати список');
  if (pick === 'Показати список') {
    await reportDoc('# Збіги «' + find + '» → «' + repl + '»\n\n' + per.join('\n') + '\n\n```\n' + hits.slice(0, 200).join('\n') + '\n```\n');
    if ((await info('Замінити ' + total + ' збігів?', 'Замінити')) !== 'Замінити') return;
  } else if (pick !== 'Замінити') return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  await takeSnapshot(root, 'перед заміною ' + find + ' → ' + repl);
  if (!(await applyChanges(root, changes))) { warn('VS Code не прийняв правки.'); return; }
  info('Замінено ' + total + ' у ' + changes.size + ' файлах. Повернути: «Restore snapshot».');
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
  if (!changes.size) { info('Нормалізація проєкту: змін немає (' + files.length + ' файлів перевірено).'); return; }
  const list = [...changes.keys()];
  const go = await warn('Нормалізувати ' + changes.size + ' з ' + files.length + ' файлів (' + list.slice(0, 3).join(', ') + (list.length > 3 ? ', …' : '') +
    ') кроками з налаштувань «Normalize file»? Знімок проєкту збережеться.', { modal: true }, 'Нормалізувати');
  if (go !== 'Нормалізувати') return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  await takeSnapshot(root, 'перед нормалізацією проєкту');
  if (!(await applyChanges(root, changes))) { warn('VS Code не прийняв правки.'); return; }
  info('Нормалізовано ' + changes.size + ' файлів. Повернути: «Restore snapshot».');
}

/* ============================== notation consistency ======================== */
async function notationCmd() {
  const root = needRoot();
  if (!root) return;
  const custom = cfg().get('notationGroups', []);
  const groups = Array.isArray(custom) && custom.length ? custom : X.NOTATION_DEFAULT;
  const files = await projectFiles(root, ['.tex', '.tikz', '.sty', '.cls']);
  const rep = X.notationReport(files, groups);
  await reportDoc(X.formatNotationReport(rep, { folder: path.basename(root) }));
  const mixed = rep.filter((r) => r.mixed);
  if (!mixed.length) return;
  const g = await vscode.window.showQuickPick(mixed.map((r) => ({
    label: r.name, description: r.variants.map((v) => v.label + ' ' + v.count).join(' · '), r
  })), { placeHolder: 'Уніфікувати позначення? (Esc: лише звіт)' });
  if (!g) return;
  const best = g.r.variants.slice().sort((a, b) => b.count - a.count)[0];
  const t = await vscode.window.showQuickPick(g.r.variants.map((v) => ({
    label: v.label, description: v.count + ' разів' + (v === best ? ' · найчастіше' : ''), v
  })), { placeHolder: 'До якого запису привести решту?' });
  if (!t) return;
  const plan = X.notationUnify(files, g.r.group, t.v.label);
  if (!plan.count) { info('Нічого міняти.'); return; }
  const go = await warn('Замінити ' + plan.count + ' записів на ' + t.v.label + ' у ' + plan.changes.size + ' файлах? Знімок проєкту збережеться.', { modal: true }, 'Замінити');
  if (go !== 'Замінити') return;
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && !d.isUntitled)) await vscode.workspace.saveAll(false);
  await takeSnapshot(root, 'перед уніфікацією ' + t.v.label);
  if (!(await applyChanges(root, plan.changes))) { warn('VS Code не прийняв правки.'); return; }
  info('Уніфіковано: ' + plan.count + ' замін у ' + plan.changes.size + ' файлах.');
}

/* ================================== build parts ============================= */
async function buildPartsCmd() {
  const root = needRoot();
  if (!root) return;
  const ms = mainSettings();
  const abs = path.join(root, ms.mainFile);
  const text = textOfPath(abs);
  if (text === null) { warn('Не знайдено ' + ms.mainFile + ' (налаштування tssworkflow.mainFile).'); return; }
  const parts = C.chapterStructure(text, ms.macro, ms.listMacros);
  if (parts.length < 2) { info('У ' + ms.mainFile + ' менше двох частин (\\part): збирай розділ чи весь документ.'); return; }
  const picks = await vscode.window.showQuickPick(parts.map((p, i) => ({
    label: p.title || '(розділи до першої \\part)', description: p.names.length + ' розд.: ' + p.names.slice(0, 4).join(', ') + (p.names.length > 4 ? ', …' : ''), i
  })), { canPickMany: true, placeHolder: 'Які частини зібрати?' });
  if (!picks || !picks.length) return;
  const base = path.basename(ms.mainFile, path.extname(ms.mainFile));
  const outRel = base + '-parts.tex';
  const filtered = X.filterMainForParts(text, ms.macro, ms.listMacros, picks.map((p) => p.i));
  try { fs.writeFileSync(path.join(root, outRel), filtered, 'utf8'); } catch (e) { warn('Не вдалося записати ' + outRel + ': ' + errText(e)); return; }
  vscode.window.setStatusBarMessage('Збірка частин: ' + picks.map((p) => p.label).join(', '), 5000);
  await vscode.commands.executeCommand('tssworkflow._compileFile', { file: outRel, openPdf: true });
}

/* ============================== \cite: completion, hover =================== */
let bibCache = null;
async function bibEntries() {
  if (bibCache) return bibCache;
  const out = [];
  const found = await vscode.workspace.findFiles('**/*.bib', EXCLUDE, 200);
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
            ii.command = { command: 'vscode.open', title: 'Відкрити', arguments: [vscode.Uri.file(d.abs), { selection: new vscode.Range(d.line, 0, d.line, 0), preview: false }] };
            return { item: ii };
          })
        };
      });
      return { item, children };
    });
    if (this.view) {
      const n = list.filter((d) => d.severity === 'error' || d.severity === 'warning').length;
      this.view.badge = n ? { value: n, tooltip: 'Помилок і попереджень: ' + n } : undefined;
      this.view.message = list.length ? undefined : '✓ Проблем (TSS Workflow, лог LaTeX) немає';
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
  const view = vscode.window.createTreeView('tssworkflow.problemsView', { treeDataProvider: problems, showCollapseAll: true });
  problems.view = view;
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => problems.refresh(), 300); };
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
    cmd('tssworkflow.buildParts', buildPartsCmd),
    vscode.languages.registerCompletionItemProvider(SEL_ANY, citeCompletion, '{', ','),
    vscode.languages.registerHoverProvider(SEL_ANY, citeHover)
  );
  if (vscode.workspace.createFileSystemWatcher) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.bib');
    context.subscriptions.push(w, w.onDidChange(() => { bibCache = null; }), w.onDidCreate(() => { bibCache = null; }), w.onDidDelete(() => { bibCache = null; }));
  }
}

exports.register = register;
exports._t = { collectProblems, ProblemsProvider, citeCompletion, citeHover, takeSnapshot, listSnapshots };
