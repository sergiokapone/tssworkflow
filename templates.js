'use strict';
/* TSS Workflow 0.4.4: document templates in the style of TeXstudio.
 *   New from template...     a new document made of a template (a file in the clicked folder or in the open workspace folder;
 *                            untitled only when no folder is open);
 *                            a template can be a folder of several files (.tex + .bib + ...)
 *   Insert template fragment a short template (figure, table, ...) inserted at the caret
 *   Make template...         saves the current document (or the selection, as a fragment) as a template
 *   Manage templates...      open, rename, delete, copy a built-in template, show in the file manager
 *   Open templates folder    the folder with the user's templates
 * Templates live in three places: the project (.vscode/templates), the user's folder (all projects)
 * and the extension itself (templates/, read only). The logic without VS Code is in templatesPure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const T = require('./templatesPure');
const { cfg, errText, info, warn } = require('./util');


let ctx = null;

const SOURCE_LABEL = { project: 'Проєкт', user: 'Мої шаблони', builtin: 'Вбудовані' };

/* ================================= folders ================================== */
function expandHome(p) {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

function workspaceRoot() {
  const ed = vscode.window.activeTextEditor;
  const f = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  return f ? f.uri.fsPath : null;
}

function userDir() {
  const v = String(cfg().get('templatesDir', '') || '').trim();
  if (v) return path.resolve(expandHome(v));
  const base = ctx.globalStorageUri ? ctx.globalStorageUri.fsPath : ctx.globalStoragePath;
  return path.join(base, 'templates');
}

function projectDir() {
  const v = String(cfg().get('projectTemplatesDir', '.vscode/templates') || '').trim();
  if (!v) return null;
  const e = expandHome(v);
  if (path.isAbsolute(e)) return e;
  const root = workspaceRoot();
  return root ? path.join(root, e) : null;
}

const builtinDir = () => path.join(ctx.extensionPath, 'templates');

/* ================================== listing ================================= */
// relative paths (with /) of the files of a template folder; bounded, no .git / node_modules
function listFilesRec(dir, rel, out) {
  if (out.length > 300) return;
  let names;
  try { names = fs.readdirSync(path.join(dir, rel)); } catch (e) { return; }
  for (const n of names) {
    if (n === '.git' || n === 'node_modules') continue;
    const r = rel ? rel + '/' + n : n;
    let st;
    try { st = fs.statSync(path.join(dir, r)); } catch (e) { continue; }
    if (st.isDirectory()) { if (r.split('/').length < 5) listFilesRec(dir, r, out); } else out.push(r);
  }
}

function readDir(dir, source) {
  const out = [];
  if (!dir) return out;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const f of names) {
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && T.isTemplateFile(f)) {
        const p = T.parseTemplate(fs.readFileSync(file, 'utf8'), f);
        out.push({ name: p.name, description: p.description, kind: p.kind, body: p.body, source, file, ext: path.extname(f).toLowerCase(), stem: path.basename(f, path.extname(f)), multi: false });
      } else if (st.isDirectory()) {
        const files = [];
        listFilesRec(file, '', files);
        const main = T.pickMainFile(files, f);
        if (!main) continue;
        const mainPath = path.join(file, main);
        const p = T.parseTemplate(fs.readFileSync(mainPath, 'utf8'), f + '.tex');
        out.push({ name: p.name, description: p.description, kind: 'document', body: p.body, source, file: mainPath, dir: file, files, mainRel: main, ext: path.extname(main).toLowerCase(), stem: f, multi: true });
      }
    } catch (e) { /* an unreadable entry is skipped */ }
  }
  return out;
}

function listTemplates() {
  return T.sortTemplates([].concat(readDir(projectDir(), 'project'), readDir(userDir(), 'user'), readDir(builtinDir(), 'builtin')));
}

// a template by its name or file name (project, then user, then built-in); null when there is none
function findTemplate(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return listTemplates().find((t) => t.name.toLowerCase() === want || t.stem.toLowerCase() === want) || null;
}

// quick pick items; with a VS Code that has separators the groups are headed, otherwise the group is in `description`
function pickItems(list) {
  const sep = vscode.QuickPickItemKind && vscode.QuickPickItemKind.Separator;
  const items = [];
  let last = null;
  for (const t of list) {
    if (sep !== undefined && t.source !== last) items.push({ label: SOURCE_LABEL[t.source], kind: sep });
    last = t.source;
    const what = (t.multi ? 'папка' : t.ext) + (t.kind === 'fragment' ? ' · фрагмент' : '');
    items.push({
      label: t.name,
      description: sep !== undefined ? what : SOURCE_LABEL[t.source] + ' · ' + what,
      detail: t.description || undefined,
      t
    });
  }
  return items;
}

async function pickTemplate(list, placeHolder) {
  const pick = await vscode.window.showQuickPick(pickItems(list), { placeHolder, matchOnDescription: true, matchOnDetail: true });
  return pick ? pick.t : null;
}

/* ============================== placeholder values ========================== */
// the values of ${date}, ${author}, ${title} and of the ${ask:name[:default]} variables of `texts`;
// null when the user pressed Esc
async function collectVars(texts) {
  const vars = T.builtinVars(new Date(), String(cfg().get('templateAuthor', '') || ''));
  const all = texts.join('\n');
  if (T.usesVar(all, 'title')) {
    const title = await vscode.window.showInputBox({ prompt: 'Заголовок документа (підставляється замість ${title})' });
    if (title === undefined) return null;
    vars.title = title;
  }
  for (const a of T.askSpecs(all)) {
    const v = await vscode.window.showInputBox({ prompt: 'Значення для ${' + a.name + '}', value: a.def });
    if (v === undefined) return null;
    vars[a.name] = v;
  }
  return vars;
}

const fill = (body, vars) => T.applyTemplate(T.resolveAsks(body), vars);

/* =============================== new from template ========================== */
async function targetFolder(arg) {
  if (!(arg && arg.fsPath)) return null;
  try {
    const st = fs.statSync(arg.fsPath);
    return st.isDirectory() ? arg.fsPath : path.dirname(arg.fsPath);
  } catch (e) { return null; }
}

function placeCursor(ed, cur) {
  if (!cur) return;
  const pos = new vscode.Position(cur.line, cur.character);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function newFromTemplate(arg) {
  const list = listTemplates().filter((t) => t.kind !== 'fragment');
  if (!list.length) {
    const pick = await vscode.window.showWarningMessage('Шаблонів документів немає. Збережи поточний документ командою «Make template».', 'Відкрити теку шаблонів');
    if (pick) await openTemplatesFolder();
    return;
  }
  // a folder clicked in the Explorer, else (0.4.4) the folder VS Code is open in, so the file is created right there
  // and no Save As dialog is needed; with no folder open (or newFromTemplateInWorkspace = false) the document is untitled
  const dir = (await targetFolder(arg)) || (cfg().get('newFromTemplateInWorkspace', true) ? workspaceRoot() : null);
  const t = await pickTemplate(list, dir ? 'Шаблон нового файла в ' + dir : 'Шаблон нового документа');
  if (!t) return;
  if (t.multi) return newFromFolderTemplate(t, dir);

  const vars = await collectVars([t.body]);
  if (!vars) return;
  const res = fill(t.body, vars);

  let ed;
  if (dir) {
    const name = await vscode.window.showInputBox({
      prompt: 'Ім’я нового файла без розширення (' + t.ext + ' додасться саме)',
      validateInput: (v) => {
        const s = T.sanitizeName(v);
        if (!s) return 'Порожнє або недопустиме ім’я';
        return fs.existsSync(path.join(dir, s + t.ext)) ? 'Такий файл уже є' : null;
      }
    });
    if (!name) return;
    const file = path.join(dir, T.sanitizeName(name) + t.ext);
    try {
      fs.writeFileSync(file, res.text, 'utf8');
    } catch (e) { warn('Не вдалося створити файл: ' + errText(e)); return; }
    ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  } else {
    const doc = await vscode.workspace.openTextDocument({ language: 'latex', content: res.text });
    ed = await vscode.window.showTextDocument(doc);
  }
  placeCursor(ed, res.cursor);
}

// a folder template: the main file gets the new name, the other files keep their relative paths
async function newFromFolderTemplate(t, dirArg) {
  const dir = dirArg || workspaceRoot();
  if (!dir) { warn('Шаблон із кількох файлів потребує папки: відкрий папку проєкту або клікни папку в Провіднику.'); return; }
  const plan = T.planCopy(t.files, t.mainRel, 'x');
  const texts = [];
  for (const p of plan) {
    if (!p.text) continue;
    try { texts.push(p.main ? t.body : T.parseTemplate(fs.readFileSync(path.join(t.dir, p.from), 'utf8'), p.from).body); } catch (e) { /* skipped below */ }
  }
  const vars = await collectVars(texts);
  if (!vars) return;
  const name = await vscode.window.showInputBox({
    prompt: 'Ім’я головного файла без розширення (' + t.ext + ' додасться саме); решта файлів шаблона в ' + dir,
    validateInput: (v) => {
      const s = T.sanitizeName(v);
      if (!s) return 'Порожнє або недопустиме ім’я';
      return fs.existsSync(path.join(dir, s + t.ext)) ? 'Такий файл уже є' : null;
    }
  });
  if (!name) return;
  const stem = T.sanitizeName(name);
  let created = 0;
  const skipped = [];
  let mainFile = null;
  let cursor = null;
  try {
    for (const p of T.planCopy(t.files, t.mainRel, stem)) {
      const dest = path.join(dir, p.to);
      if (!p.main && fs.existsSync(dest)) { skipped.push(p.to); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const srcPath = path.join(t.dir, p.from);
      if (p.text) {
        const body = T.parseTemplate(fs.readFileSync(srcPath, 'utf8'), p.from).body;
        const res = fill(body, vars);
        fs.writeFileSync(dest, res.text, 'utf8');
        if (p.main) { mainFile = dest; cursor = res.cursor; }
      } else {
        fs.copyFileSync(srcPath, dest);
      }
      created++;
    }
  } catch (e) { warn('Не вдалося створити файли шаблона: ' + errText(e)); return; }
  if (mainFile) placeCursor(await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(mainFile))), cursor);
  info('Створено файлів: ' + created + (skipped.length ? '. Пропущено, бо вже є: ' + skipped.join(', ') : '') + '.');
}

/* ============================ insert a template fragment ==================== */
async function insertTemplate() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { warn('Відкрий документ, у який вставити фрагмент.'); return; }
  const list = listTemplates().filter((t) => t.kind === 'fragment' && !t.multi);
  if (!list.length) { warn('Фрагментів немає. Виділи текст і збережи командою «Make template»: виділене стає фрагментом.'); return; }
  const t = await pickTemplate(list, 'Фрагмент для вставки');
  if (!t) return;
  const vars = await collectVars([t.body]);
  if (!vars) return;
  const res = fill(t.body, vars);

  const sel = ed.selection;
  const lineText = ed.document.lineAt(sel.start.line).text;
  const indent = /^[ \t]*/.exec(lineText.slice(0, sel.start.character))[0];
  const ins = T.insertResult(res.text, res.cursor, { line: sel.start.line, character: sel.start.character }, indent);
  const ok = await ed.edit((b) => b.replace(sel, ins.text));
  if (!ok) return;
  let cur = ins.cursor;
  if (!cur) {
    const lines = ins.text.split('\n');
    cur = lines.length === 1
      ? { line: sel.start.line, character: sel.start.character + lines[0].length }
      : { line: sel.start.line + lines.length - 1, character: lines[lines.length - 1].length };
  }
  placeCursor(ed, cur);
}

/* ================================ make template ============================= */
async function makeTemplate() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { warn('Відкрий документ, з якого зробити шаблон.'); return; }
  const doc = ed.document;
  const fromSelection = !ed.selection.isEmpty;
  const text = fromSelection ? doc.getText(ed.selection) : doc.getText();
  if (!text.trim()) { warn('Документ порожній: шаблон не створено.'); return; }
  const kind = fromSelection ? 'fragment' : 'document';

  const ext = T.TEMPLATE_EXT.includes(path.extname(doc.uri.fsPath).toLowerCase()) ? path.extname(doc.uri.fsPath).toLowerCase() : '.tex';
  const base = doc.isUntitled ? '' : path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  const name0 = await vscode.window.showInputBox({
    prompt: 'Назва шаблону' + (fromSelection ? ' (фрагмент із виділеного)' : ' (документ з усього файла)'),
    value: base,
    validateInput: (v) => (T.sanitizeName(v) ? null : 'Порожнє або недопустиме ім’я (без / \\ : * ? " < > |)')
  });
  if (!name0) return;
  const name = T.sanitizeName(name0);
  const description = await vscode.window.showInputBox({ prompt: 'Короткий опис (можна залишити порожнім)' });
  if (description === undefined) return;

  const places = [{ label: SOURCE_LABEL.user, detail: userDir(), dir: userDir() }];
  const pd = projectDir();
  if (pd) places.push({ label: SOURCE_LABEL.project, detail: pd, dir: pd });
  let place = places[0];
  if (places.length > 1) {
    place = await vscode.window.showQuickPick(places, { placeHolder: 'Де зберегти шаблон' });
    if (!place) return;
  }

  const file = path.join(place.dir, name + ext);
  if (fs.existsSync(file)) {
    const pick = await vscode.window.showWarningMessage('Шаблон «' + name + '» уже є. Замінити?', { modal: true }, 'Замінити');
    if (pick !== 'Замінити') return;
  }
  try {
    fs.mkdirSync(place.dir, { recursive: true });
    fs.writeFileSync(file, T.buildTemplate(text, description, kind), 'utf8');
  } catch (e) { warn('Не вдалося зберегти шаблон: ' + errText(e)); return; }
  info('Шаблон «' + name + '»' + (kind === 'fragment' ? ' (фрагмент)' : '') + ' збережено: ' + file);
}

/* ============================== manage templates ============================ */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) {
    const a = path.join(from, n);
    const b = path.join(to, n);
    if (fs.statSync(a).isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

async function manageTemplates() {
  const list = listTemplates();
  if (!list.length) { warn('Шаблонів немає.'); return; }
  const t = await pickTemplate(list, 'Шаблон для керування');
  if (!t) return;

  const builtin = t.source === 'builtin';
  const actions = builtin
    ? ['Переглянути', 'Скопіювати до моїх шаблонів']
    : ['Відкрити для редагування', 'Перейменувати', 'Видалити', 'Показати у файловому менеджері'];
  const act = await vscode.window.showQuickPick(actions, { placeHolder: t.name + ' · ' + SOURCE_LABEL[t.source] });
  if (!act) return;
  const location = t.multi ? t.dir : t.file; // what is renamed, deleted, shown

  try {
    if (act === 'Переглянути' || act === 'Відкрити для редагування') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(t.file)));
    } else if (act === 'Скопіювати до моїх шаблонів') {
      const dir = userDir();
      fs.mkdirSync(dir, { recursive: true });
      const have = readDir(dir, 'user').map((x) => x.stem);
      const name = T.uniqueName(have, t.multi ? t.stem : (T.sanitizeName(t.name) || t.stem));
      if (t.multi) copyDir(t.dir, path.join(dir, name));
      else fs.writeFileSync(path.join(dir, name + t.ext), T.buildTemplate(t.body, t.description, t.kind), 'utf8');
      info('Скопійовано як «' + name + '». Тепер його можна змінювати.');
    } else if (act === 'Перейменувати') {
      const dir = path.dirname(location);
      const name0 = await vscode.window.showInputBox({
        prompt: t.multi ? 'Нова назва папки шаблона' : 'Нова назва шаблону',
        value: t.stem,
        validateInput: (v) => {
          const s = T.sanitizeName(v);
          if (!s) return 'Порожнє або недопустиме ім’я';
          return s.toLowerCase() !== t.stem.toLowerCase() && fs.existsSync(path.join(dir, s + (t.multi ? '' : t.ext))) ? 'Шаблон з такою назвою вже є' : null;
        }
      });
      if (!name0) return;
      const s = T.sanitizeName(name0);
      if (t.multi) {
        // the folder is renamed; the main file inside keeps its name (and the name from its `% !TSS name:` line)
        fs.renameSync(t.dir, path.join(dir, s));
      } else {
        const target = path.join(dir, s + t.ext);
        // the rewritten file keeps the description and the kind and drops an explicit `% !TSS name:` line, so the file name is the name
        const text = T.buildTemplate(t.body, t.description, t.kind);
        if (target !== t.file) fs.renameSync(t.file, target);
        fs.writeFileSync(target, text, 'utf8');
      }
      info('Шаблон перейменовано: «' + s + '».');
    } else if (act === 'Видалити') {
      const pick = await vscode.window.showWarningMessage('Видалити шаблон «' + t.name + '»? ' + (t.multi ? 'Папка ' : 'Файл ') + location + ' зникне.', { modal: true }, 'Видалити');
      if (pick !== 'Видалити') return;
      if (t.multi) fs.rmSync(t.dir, { recursive: true, force: true }); else fs.unlinkSync(t.file);
      info('Шаблон «' + t.name + '» видалено.');
    } else if (act === 'Показати у файловому менеджері') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(location));
    }
  } catch (e) { warn('Не вдалося виконати дію: ' + errText(e)); }
}

/* ============================ open templates folder ========================= */
async function openTemplatesFolder() {
  const dir = userDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(dir));
  } catch (e) { warn('Не вдалося відкрити теку шаблонів ' + dir + ': ' + errText(e)); }
}

/* ================================== register ================================ */
function register(context) {
  ctx = context;
  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    cmd('tssworkflow.newFromTemplate', newFromTemplate),
    cmd('tssworkflow.insertTemplate', insertTemplate),
    cmd('tssworkflow.makeTemplate', makeTemplate),
    cmd('tssworkflow.manageTemplates', manageTemplates),
    cmd('tssworkflow.openTemplatesFolder', openTemplatesFolder)
  );
}

exports.register = register;
exports.findTemplate = findTemplate;
