'use strict';
/* TSS Workflow 0.3.9: figures by drag-and-drop / paste, new chapter, \iffalse toggle, Unicode -> LaTeX,
 * BibTeX from DOI, latexdiff against a git revision, stale-references indicator, quick fixes for the log
 * (missing .tikz file, pgf layers, lost characters). */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const X = require('./extra2Pure');

const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
const info = (m) => vscode.window.showInformationMessage(m);
const warn = (m) => vscode.window.showWarningMessage(m);
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif'];
const SEL = [{ language: 'latex' }, { language: 'tex' }];
const SRC_EXT = ['.tex', '.tikz', '.cls', '.sty', '.bib'];
const EOL = (doc) => (doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');

function workspaceRoot(doc) {
  const f = (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  return f ? f.uri.fsPath : null;
}
function listOf(v, fallback) {
  return Array.isArray(v) && v.length ? v.map(String) : fallback;
}
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, Object.assign({ maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, opts), (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}
const posix = (p) => p.split(path.sep).join('/');

/* ============================ figures: drop and paste ============================ */
function figureSnippet(doc, position, stem, tab) {
  const width = cfg().get('figureWidth', '0.6\\linewidth') || '0.6\\linewidth';
  const prefix = (cfg().get('labelPrefixes', {}) || {}).figure || 'pic:';
  const lines = [];
  for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
  const vars = { width, name: stem, label: prefix + X.stemLabel(stem), caption: '\u0000' };
  let text;
  if (X.insideFigure(lines, position.line)) text = '\\includegraphics[width=' + width + ']{' + stem + '}';
  else text = X.fillTemplate(listOf(cfg().get('figureTemplate'), X.DEFAULT_FIGURE_TEMPLATE), vars);
  const sn = new vscode.SnippetString();
  const parts = text.split('\u0000');
  parts.forEach((p, i) => {
    sn.appendText(p);
    if (i < parts.length - 1) sn.appendTabstop(tab || 1);
  });
  return sn;
}

// the picture folder of the document (Pictures next to the .tex file)
function picDir(doc) { return path.join(path.dirname(doc.uri.fsPath), 'Pictures'); }

function existingNames(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

// puts the file into Pictures/ (copies it if it is elsewhere); returns the name for \includegraphics
function placeImage(doc, srcPath) {
  const dir = picDir(doc);
  const ext = path.extname(srcPath);
  const stem = path.basename(srcPath, ext);
  const rel = path.relative(dir, srcPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep)) return stem; // already there
  fs.mkdirSync(dir, { recursive: true });
  const unique = X.uniqueStem(existingNames(dir), stem, ext);
  fs.copyFileSync(srcPath, path.join(dir, unique + ext));
  return unique;
}

async function imageUrisOf(dataTransfer) {
  const out = [];
  const item = dataTransfer.get('text/uri-list');
  if (item) {
    const v = await item.asString();
    for (const l of String(v).split(/\r?\n/)) {
      if (!l || l.startsWith('#')) continue;
      try { out.push(vscode.Uri.parse(l.trim())); } catch (e) { /* skip */ }
    }
  }
  dataTransfer.forEach((it) => {
    const f = it.asFile && it.asFile();
    if (f && f.uri) out.push(f.uri);
  });
  const seen = new Set();
  return out.filter((u) => u.scheme === 'file' && IMG_EXT.includes(path.extname(u.fsPath).toLowerCase()) &&
    !seen.has(u.fsPath) && seen.add(u.fsPath));
}

function editKind() {
  return vscode.DocumentDropOrPasteEditKind ? vscode.DocumentDropOrPasteEditKind.Empty.append('latex', 'figure') : undefined;
}

const dropProvider = {
  async provideDocumentDropEdits(doc, position, dataTransfer) {
    try {
      const uris = await imageUrisOf(dataTransfer);
      if (!uris.length) return undefined;
      const sn = new vscode.SnippetString();
      uris.forEach((u, i) => {
        if (i) sn.appendText('\n\n');
        const stem = placeImage(doc, u.fsPath);
        const one = figureSnippet(doc, position, stem, i + 1);
        sn.value += one.value; // already escaped
      });
      const k = editKind();
      return k ? new vscode.DocumentDropEdit(sn, 'Вставити як рисунок', k) : new vscode.DocumentDropEdit(sn);
    } catch (err) {
      warn('Не вдалося вставити рисунок: ' + (err && err.message ? err.message : err));
      return undefined;
    }
  }
};

const pasteProvider = {
  async provideDocumentPasteEdits(doc, ranges, dataTransfer) {
    try {
      let bytes = null;
      let ext = '.png';
      for (const [mime, e] of [['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif']]) {
        const it = dataTransfer.get(mime);
        const f = it && it.asFile && it.asFile();
        if (f) { bytes = await f.data(); ext = e; break; }
      }
      if (!bytes || !bytes.length) return undefined;
      const dir = picDir(doc);
      fs.mkdirSync(dir, { recursive: true });
      const stem = X.uniqueStem(existingNames(dir), X.pasteName(new Date()), ext);
      fs.writeFileSync(path.join(dir, stem + ext), Buffer.from(bytes));
      const sn = figureSnippet(doc, ranges[0].start, stem);
      return [new vscode.DocumentPasteEdit(sn, 'Вставити як рисунок', editKind())];
    } catch (err) {
      warn('Не вдалося вставити рисунок з буфера: ' + (err && err.message ? err.message : err));
      return undefined;
    }
  }
};

/* ================================ new chapter ================================== */
async function newChapter() {
  const ed = vscode.window.activeTextEditor;
  const root = workspaceRoot(ed && ed.document);
  if (!root) { warn('Відкрий папку проєкту.'); return; }
  const name = await vscode.window.showInputBox({
    prompt: 'Імʼя розділу: назва папки й файла (латиниця, цифри, - і _)',
    validateInput: (v) => (/^[A-Za-z][A-Za-z0-9_-]*$/.test(v || '') ? (fs.existsSync(path.join(root, v)) ? 'Така папка вже є' : null) : 'Лише латиниця, цифри, - і _; починати з літери')
  });
  if (!name) return;
  const title = await vscode.window.showInputBox({ prompt: 'Заголовок розділу (\\chapter{…})', value: name });
  if (title === undefined) return;
  const mainFile = cfg().get('mainFile', 'main.tex') || 'main.tex';
  const vars = { name, title: title || name, root: '../' + mainFile };
  let body;
  // tssworkflow.chapterTemplateName: a template of the "New from template" list is the content of the new chapter
  const tplName = String(cfg().get('chapterTemplateName', '') || '').trim();
  if (tplName) {
    const t = require('./templates').findTemplate(tplName);
    if (t && !t.multi) {
      const TP = require('./templatesPure');
      body = TP.applyTemplate(t.body, Object.assign(TP.builtinVars(new Date(), String(cfg().get('templateAuthor', '') || '')), vars)).text;
    } else {
      warn('Шаблон розділу «' + tplName + '» не знайдено або це шаблон із кількох файлів: узято chapterTemplate з налаштувань.');
    }
  }
  if (body === undefined) body = X.fillTemplate(listOf(cfg().get('chapterTemplate'), X.DEFAULT_CHAPTER_TEMPLATE), vars);
  const dir = path.join(root, name);
  const file = path.join(dir, name + '.tex');
  try {
    fs.mkdirSync(path.join(dir, 'Pictures'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tikz'), { recursive: true });
    for (const sub of ['Pictures', 'tikz']) fs.writeFileSync(path.join(dir, sub, '.gitkeep'), '');
    fs.writeFileSync(file, body.replace(/\r?\n/g, '\n'), 'utf8');
  } catch (err) {
    warn('Не вдалося створити розділ: ' + (err && err.message ? err.message : err));
    return;
  }
  const macro = cfg().get('chapterIncludeMacro', '\\includechapter') || '\\includechapter';
  const mainPath = path.join(root, mainFile);
  let note = '';
  if (fs.existsSync(mainPath)) {
    const mdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainPath));
    const r = X.addIncludeLine(mdoc.getText(), macro, name);
    if (r.ok && !r.already) {
      const we = new vscode.WorkspaceEdit();
      we.replace(mdoc.uri, new vscode.Range(0, 0, mdoc.lineCount, 0), r.text);
      await vscode.workspace.applyEdit(we);
      await mdoc.save();
      note = ' і додано ' + macro + '{' + name + '} у ' + mainFile;
    } else if (!r.ok) {
      // no `\includechapter{…}` lines: the chapters may be in comma lists, `\multiinclude{A, B}[]` (chapterListMacros)
      const CP = require('./chaptersPure');
      const lists = cfg().get('chapterListMacros', ['\\multiinclude']);
      const text = mdoc.getText();
      const slots = CP.listSlots(text, Array.isArray(lists) ? lists : []);
      let slot = null;
      if (slots.length === 1) slot = slots[0];
      else if (slots.length > 1) {
        const pick = await vscode.window.showQuickPick(
          slots.map((sl) => ({ label: sl.part || 'Без частини', description: sl.macro + ' · розділів: ' + sl.names.length, detail: sl.names.length ? 'останній: ' + sl.names[sl.names.length - 1] : 'список порожній', sl })),
          { placeHolder: 'У який список додати розділ «' + name + '»? (Esc: лише створити файли)' });
        slot = pick ? pick.sl : null;
      }
      if (slot) {
        const we = new vscode.WorkspaceEdit();
        we.replace(mdoc.uri, new vscode.Range(0, 0, mdoc.lineCount, 0), CP.addToListAt(text, slot, name));
        await vscode.workspace.applyEdit(we);
        await mdoc.save();
        note = ' і додано в кінець списку ' + slot.macro + (slot.part ? ' (частина «' + slot.part + '»)' : '') + ' у ' + mainFile;
      } else {
        await vscode.env.clipboard.writeText(macro + '{' + name + '}');
        note = '; у ' + mainFile + (slots.length ? ' розділ не додано до жодного списку' : ' немає рядків ' + macro + '{…} і списків') + ', тому рядок «' + macro + '{' + name + '}» скопійовано в буфер';
      }
    }
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc);
  info('Розділ «' + name + '» створено' + note + '.');
}

/* ================================== \iffalse =================================== */
async function toggleIffalse() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  const sel = ed.selection;
  let s = sel.start.line;
  let e = sel.end.line;
  if (!sel.isEmpty && sel.end.character === 0 && e > s) e--;
  const lines = [];
  for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
  const t = X.toggleIffalse(lines, s, e);
  const eol = EOL(doc);
  if (t.kind === 'unwrap') {
    const delLine = (b, n) => {
      if (n + 1 < doc.lineCount) b.delete(new vscode.Range(n, 0, n + 1, 0));
      else if (n > 0) b.delete(new vscode.Range(n - 1, doc.lineAt(n - 1).text.length, n, doc.lineAt(n).text.length));
      else b.delete(new vscode.Range(n, 0, n, doc.lineAt(n).text.length));
    };
    await ed.edit((b) => { delLine(b, t.close); delLine(b, t.open); });
    return;
  }
  if (sel.isEmpty) {
    // no selection: the paragraph around the cursor
    while (s > 0 && lines[s - 1].trim() !== '') s--;
    while (e + 1 < lines.length && lines[e + 1].trim() !== '') e++;
  }
  const indent = /^\s*/.exec(lines[s])[0];
  const bal = X.ifBalance(lines.slice(s, e + 1));
  if (bal !== 0) {
    const pick = await vscode.window.showWarningMessage(
      'У виділеному ' + (bal > 0 ? 'є \\if без \\fi' : 'є \\fi без \\if') + ': \\iffalse може зламати збірку. Усе одно обгорнути?', 'Усе одно', 'Скасувати');
    if (pick !== 'Усе одно') return;
  }
  await ed.edit((b) => {
    b.insert(new vscode.Position(e, doc.lineAt(e).text.length), eol + indent + X.IF_CLOSE);
    b.insert(new vscode.Position(s, 0), indent + X.IF_OPEN + eol);
  });
}

/* ================================ Unicode -> LaTeX ============================== */
async function unicodeToLatex() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  const range = ed.selection.isEmpty ? doc.lineAt(ed.selection.active.line).range : new vscode.Range(ed.selection.start, ed.selection.end);
  const full = doc.getText();
  const from = doc.offsetAt(range.start);
  const to = doc.offsetAt(range.end);
  const r = X.unicodeToLatex(full, from, to);
  if (!r.count) { info('Unicode-символів для заміни не знайдено.'); return; }
  await ed.edit((b) => b.replace(range, r.text));
  vscode.window.setStatusBarMessage('Unicode → LaTeX: замінено ' + r.count + (r.chem ? ' (з них \\ce: ' + r.chem + ')' : ''), 3000);
  if (r.chem && !unicodeToLatex.warned && !/mhchem/.test(full)) {
    unicodeToLatex.warned = true;
    info('Хімічні формули огорнуто в \\ce{}: у преамбулі має бути \\usepackage[version=4]{mhchem}.');
  }
}

/* ================================= BibTeX / DOI ================================= */
function fetchBibtex(doi) {
  return new Promise((resolve, reject) => {
    const get = (url, n) => {
      if (n > 6) { reject(new Error('забагато перенаправлень')); return; }
      const lib = url.startsWith('http:') ? require('http') : require('https');
      const req = lib.get(url, { headers: { Accept: 'application/x-bibtex; charset=utf-8', 'User-Agent': 'tssworkflow-vscode' }, timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(new URL(res.headers.location, url).toString(), n + 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + (res.statusCode === 404 ? ' (DOI не знайдено)' : ''))); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('тайм-аут')));
    };
    get('https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/'), 0);
  });
}

async function bibFromDoi() {
  const ed = vscode.window.activeTextEditor;
  const root = workspaceRoot(ed && ed.document);
  if (!root) { warn('Відкрий папку проєкту.'); return; }
  const input = await vscode.window.showInputBox({ prompt: 'DOI або посилання doi.org', placeHolder: '10.1002/andp.19053221004' });
  if (!input) return;
  const doi = X.normalizeDoi(input);
  if (!doi) { warn('Не схоже на DOI (очікується 10.xxxx/…).'); return; }
  let raw;
  try {
    raw = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DOI → BibTeX…' }, () => fetchBibtex(doi));
  } catch (err) {
    warn('Не вдалося отримати запис: ' + (err && err.message ? err.message : err));
    return;
  }
  // which .bib file
  let bibUri;
  if (ed && ed.document.uri.fsPath.toLowerCase().endsWith('.bib')) bibUri = ed.document.uri;
  else {
    const found = await vscode.workspace.findFiles('**/*.bib', '{**/node_modules/**,**/.git/**,**/build/**}', 20);
    if (found.length === 1) bibUri = found[0];
    else if (found.length > 1) {
      const pick = await vscode.window.showQuickPick(found.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: 'У який .bib додати запис?' });
      if (!pick) return;
      bibUri = pick.uri;
    } else {
      bibUri = vscode.Uri.file(path.join(root, 'references.bib'));
      fs.writeFileSync(bibUri.fsPath, '', 'utf8');
    }
  }
  const bdoc = await vscode.workspace.openTextDocument(bibUri);
  const entry0 = X.formatBibtex(raw);
  const key0 = X.bibKeyOf(entry0);
  if (!key0) { warn('Відповідь не схожа на запис BibTeX:\n' + raw.slice(0, 200)); return; }
  const existing = X.bibKeys(bdoc.getText());
  if (bdoc.getText().toLowerCase().includes(doi.toLowerCase())) {
    warn('Запис з цим DOI вже є в ' + vscode.workspace.asRelativePath(bibUri) + '.');
    return;
  }
  const key = X.uniqueKey(key0, existing);
  const entry = key === key0 ? entry0 : X.setBibKey(entry0, key);
  const eol = EOL(bdoc);
  const text = bdoc.getText();
  const sep = text.trim() ? (text.endsWith('\n') ? eol : eol + eol) : '';
  const we = new vscode.WorkspaceEdit();
  we.insert(bibUri, bdoc.positionAt(text.length), sep + entry.replace(/\n/g, eol));
  await vscode.workspace.applyEdit(we);
  await bdoc.save();
  if (ed && ed.document.uri.fsPath !== bibUri.fsPath && /^(latex|tex)$/.test(ed.document.languageId)) {
    await ed.edit((b) => b.replace(ed.selection, '\\cite{' + key + '}'));
  }
  info('Додано ' + key + ' у ' + vscode.workspace.asRelativePath(bibUri) + (key !== key0 ? ' (ключ змінено, бо ' + key0 + ' уже є)' : '') + '.');
}

/* ================================== latexdiff ==================================== */
async function latexdiffCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !/^(latex|tex)$/.test(ed.document.languageId)) { warn('Відкрий .tex файл розділу.'); return; }
  const doc = ed.document;
  if (doc.isDirty) await doc.save();
  const root = workspaceRoot(doc);
  const rel = posix(path.relative(root, doc.uri.fsPath));
  let log;
  try { log = await run('git', ['log', '-n', '40', '--format=%h%x09%s%x09%cr', '--', rel], { cwd: root }); } catch (err) {
    warn('git недоступний або це не репозиторій: ' + (err && err.message ? err.message : err));
    return;
  }
  const items = [{ label: 'HEAD', description: 'останній коміт', rev: 'HEAD' }]
    .concat(X.parseGitLog(log).map((c) => ({ label: c.hash, description: c.subject, detail: c.when, rev: c.hash })));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'З якою ревізією порівняти ' + path.basename(doc.uri.fsPath) + '?' });
  if (!pick) return;
  let oldText;
  try { oldText = await run('git', ['show', pick.rev + ':' + rel], { cwd: root }); } catch (err) {
    warn('У ревізії ' + pick.rev + ' цього файла немає: ' + ((err && err.stderr) || err.message || err));
    return;
  }
  const tmp = path.join(os.tmpdir(), 'tss-old-' + path.basename(doc.uri.fsPath));
  fs.writeFileSync(tmp, oldText, 'utf8');
  const cmd = cfg().get('latexdiffCommand', 'latexdiff') || 'latexdiff';
  const args = listOf(cfg().get('latexdiffArgs'), ['--type=UNDERLINE']).concat([tmp, doc.uri.fsPath]);
  let diff;
  try {
    diff = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'latexdiff…' }, () => run(cmd, args, { cwd: root }));
  } catch (err) {
    warn('latexdiff не спрацював (' + (err && err.code === 'ENOENT' ? 'не знайдено «' + cmd + '», він є в TeX Live' : (err.stderr || err.message || err).toString().slice(0, 300)) + ').');
    return;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
  const dir = path.dirname(doc.uri.fsPath);
  const stem = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  const isChapter = path.basename(dir) === stem && path.dirname(dir) === root;
  const mainFile = cfg().get('mainFile', 'main.tex') || 'main.tex';
  const outStem = stem + '-diff';
  const outDir = isChapter ? path.join(root, outStem) : dir;
  fs.mkdirSync(outDir, { recursive: true });
  const header = isChapter ? X.latexdiffHeader(stem, pick.rev, '../' + mainFile) : '';
  const outPath = path.join(outDir, outStem + '.tex');
  fs.writeFileSync(outPath, header + diff, 'utf8');
  const od = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
  await vscode.window.showTextDocument(od, { preview: false });
  if (isChapter) {
    info('Зміни від ' + pick.rev + ' записано в ' + outStem + '/' + outStem + '.tex. Збираю як розділ…');
    vscode.commands.executeCommand('tssworkflow.compilePdf');
  } else {
    info('latexdiff записано в ' + vscode.workspace.asRelativePath(outPath) + '. Це не розділ-папка, тому збирати його треба самому.');
  }
}

/* ============================== stale references ================================ */
let staleItem = null;
let lastSave = 0;
function refreshStale() {
  if (!staleItem) return;
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!cfg().get('staleRefsIndicator', true) || !folder || !lastSave) { staleItem.hide(); return; }
  const job = cfg().get('jobname', 'main') || 'main';
  let auxM = 0;
  try { auxM = fs.statSync(path.join(folder.uri.fsPath, job + '.aux')).mtimeMs; } catch (e) { staleItem.hide(); return; }
  if (!X.isStale(auxM, lastSave)) { staleItem.hide(); return; }
  const t = new Date(auxM);
  const hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  staleItem.text = '$(history) refs застарілі';
  staleItem.tooltip = 'Посилання (\\ref), зміст і номери беруться з ' + job + '.aux, оновленого о ' + hhmm +
    ', а файли змінено пізніше. Клік: зібрати весь документ.';
  staleItem.command = 'tssworkflow.compileMain';
  staleItem.show();
}

/* ================================== quick fixes ================================= */
const QF = vscode.CodeActionKind.QuickFix;

async function findSetLayersFile(root) {
  const files = await vscode.workspace.findFiles('**/*.{cls,sty,tex}', '{**/node_modules/**,**/.git/**,**/build/**}', 400);
  for (const u of files) {
    try {
      if (/\\pgfsetlayers\{/.test(fs.readFileSync(u.fsPath, 'utf8'))) return u;
    } catch (e) { /* skip */ }
  }
  return null;
}

const logFixes = {
  async provideCodeActions(doc, range, ctx) {
    const out = [];
    for (const d of ctx.diagnostics) {
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      // 1) \localinput{x.tikz} without the file: create it from the template
      if (d.source === 'TSS Workflow' && code === 'file-missing-tikz') {
        const name0 = doc.getText(d.range).trim();
        if (!name0) continue;
        const name = /\.[A-Za-z0-9]+$/.test(name0) ? name0 : name0 + '.tikz';
        const target = vscode.Uri.file(path.join(path.dirname(doc.uri.fsPath), 'tikz', name));
        const tpl = X.fillTemplate(listOf(cfg().get('newTikzTemplate'), [
          '% Рисунок «${name}»: створено автоматично, заповни', '\\begin{tikzpicture}', '\t', '\\end{tikzpicture}', ''
        ]), { name: name0 });
        const we = new vscode.WorkspaceEdit();
        we.createFile(target, { ignoreIfExists: true });
        we.insert(target, new vscode.Position(0, 0), tpl);
        const a = new vscode.CodeAction('Створити tikz/' + name + ' із заготовки', QF);
        a.diagnostics = [d];
        a.edit = we;
        out.push(a);
        continue;
      }
      const msg = String(d.message || '');
      // 2) pgf layer that is not declared / not in \pgfsetlayers
      const lm = /graphics layer [`'‘]([^`'’]+)['’]/.exec(msg) || (/pgf@layerbox(?:saved)?@pre main/.test(msg) ? [null, 'pre main'] : null);
      if (lm) {
        const root = workspaceRoot(doc);
        const u = root && await findSetLayersFile(root);
        if (u) {
          const target = await vscode.workspace.openTextDocument(u);
          const fix = X.layerFix(target.getText(), lm[1]);
          if (fix) {
            const we = new vscode.WorkspaceEdit();
            we.replace(u, new vscode.Range(target.positionAt(fix.start), target.positionAt(fix.end)), fix.replacement);
            const a = new vscode.CodeAction('Оголосити шар «' + lm[1] + '» і додати в \\pgfsetlayers (' + vscode.workspace.asRelativePath(u) + ')', QF);
            a.diagnostics = [d];
            a.edit = we;
            a.isPreferred = true;
            out.push(a);
          }
        }
        continue;
      }
      // 3) lost characters: make TeX stop with a real line number
      if (/^Немає гліфів/.test(msg)) {
        const root = workspaceRoot(doc);
        const mainPath = root && path.join(root, cfg().get('mainFile', 'main.tex') || 'main.tex');
        if (mainPath && fs.existsSync(mainPath)) {
          const mdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainPath));
          if (!/\\tracinglostchars\s*=\s*[3-9]/.test(mdoc.getText())) {
            let at = -1;
            for (let i = 0; i < mdoc.lineCount; i++) if (/^\s*\\begin\{document\}/.test(mdoc.lineAt(i).text)) { at = i; break; }
            if (at >= 0) {
              const we = new vscode.WorkspaceEdit();
              we.insert(mdoc.uri, new vscode.Position(at, 0), '\\tracinglostchars=3 % TSS: тимчасово, прибрати після пошуку' + EOL(mdoc));
              const a = new vscode.CodeAction('Додати \\tracinglostchars=3 у ' + path.basename(mainPath) + ' (помилка з реальним рядком)', QF);
              a.diagnostics = [d];
              a.edit = we;
              out.push(a);
            }
          }
        }
      }
    }
    return out;
  }
};

/* ================================== register ==================================== */
function register(context) {
  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    cmd('tssworkflow.newChapter', newChapter),
    cmd('tssworkflow.toggleIffalse', toggleIffalse),
    cmd('tssworkflow.unicodeToLatex', unicodeToLatex),
    cmd('tssworkflow.bibFromDoi', bibFromDoi),
    cmd('tssworkflow.latexdiff', latexdiffCmd),
    vscode.languages.registerCodeActionsProvider([{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }], logFixes, { providedCodeActionKinds: [QF] })
  );
  // drag and drop / paste of pictures need a recent VS Code; on an old one the rest still works
  try {
    if (vscode.languages.registerDocumentDropEditProvider) {
      const k = editKind();
      context.subscriptions.push(vscode.languages.registerDocumentDropEditProvider(SEL, dropProvider,
        k ? { providedDropEditKinds: [k], dropMimeTypes: ['text/uri-list', 'files'] } : undefined));
    }
    if (vscode.languages.registerDocumentPasteEditProvider && editKind()) {
      context.subscriptions.push(vscode.languages.registerDocumentPasteEditProvider(SEL, pasteProvider,
        { providedPasteEditKinds: [editKind()], pasteMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }));
    }
  } catch (err) { /* the API of this VS Code differs: no picture drop / paste */ }
  staleItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  context.subscriptions.push(staleItem);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (SRC_EXT.includes(path.extname(doc.uri.fsPath).toLowerCase())) { lastSave = Date.now(); refreshStale(); }
    })
  );
  const w = vscode.workspace.createFileSystemWatcher('**/*.aux');
  context.subscriptions.push(w, w.onDidChange(refreshStale), w.onDidCreate(refreshStale), w.onDidDelete(refreshStale));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow')) refreshStale(); }));
}

module.exports = { register, _t: { logFixes, figureSnippet } };
