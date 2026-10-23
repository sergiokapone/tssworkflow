'use strict';
/* wordCount.js: the word count (split off filesAndLabels.js in 0.20.1).
 *   - the status bar item "N сл." (setting tssworkflow.wordCount): the document is counted once per version, and the words of the
 *     file with everything it includes (deepWords) are counted a moment after a pause in typing;
 *   - the command tssworkflow.projectWordCount: words per chapter and per file in a Quick Pick.
 * The counting itself is filesAndLabelsPure.countWords; the project helpers (the table of macros, the list of files, the order of
 * chapters) are those of filesAndLabels.js, which does not require this module (no cycle). */
const vscode = require('vscode');
const path = require('path');
const { tr } = require('./i18n');
const X = require('./filesAndLabelsPure');
const PI = require('./projectIndex');
const FL = require('./filesAndLabels');
const { cfg, debounce, info, openDocByPath } = require('./util');

// words of the file and of everything it includes (\\input, \\include, \\subfile, \\includechapter).
// What is read from one file (its words and the references in it, in the order of the text) is kept per file while the file is
// unchanged (projectIndex: the version of an open document, mtime and size of a closed one), so the walk after a pause in typing
// re-reads the one file that was edited and stat()s the rest; where a reference leads is resolved on every walk (a file may have
// appeared or gone). The root file is read from the text that is passed in (the open, maybe unsaved, document) and is not kept.
function deepWords(doc) {
  const root = FL.rootOf(doc.uri);
  const tbl = FL.table().filter((e) => !e.graphics && e.macro !== '\\localinput');
  const chapterMacro = String(cfg().get('chapterIncludeMacro', '\\includechapter')) || '\\includechapter';
  const chRe = new RegExp(chapterMacro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z@])\\s*\\{\\s*([^{}\\s]+)\\s*\\}', 'g');
  // the references depend on the table of macros, on the chapter macro and on the root: another setting is another cache
  const kind = 'words|' + JSON.stringify(tbl) + '|' + chapterMacro + '|' + (root || '');
  const compute = (text) => {
    const refs = [];
    for (const line of text.split(/\r?\n/)) {
      for (const r of X.findFileRefs(line, tbl)) refs.push({ entry: r.entry, name: r.name });
      if (root) {
        const code = X.codePart(line);
        chRe.lastIndex = 0;
        let m;
        while ((m = chRe.exec(code)) !== null) refs.push({ chapter: m[1] });
      }
    }
    return { words: X.countWords(text), refs };
  };
  const seen = new Set();
  let total = 0;
  const walk = (abs, depth, text) => {
    if (seen.has(abs) || depth > 6 || seen.size > 80) return;
    seen.add(abs);
    const got = text !== undefined ? compute(text) : PI.get(kind, abs, compute);
    total += got.words;
    const ctx = FL.ctxFor({ uri: vscode.Uri.file(abs) });
    const reachable = (p) => !!openDocByPath(p) || FL.existsFile(p);
    for (const r of got.refs) {
      if (r.entry) {
        const hit = X.resolveRef(r.entry, r.name, ctx);
        if (hit.found && /\.tex$/i.test(hit.abs) && reachable(hit.abs)) walk(hit.abs, depth + 1);
      } else {
        const p = path.join(root, r.chapter, r.chapter + '.tex');
        if (reachable(p)) walk(p, depth + 1);
      }
    }
  };
  walk(doc.uri.fsPath, 0, doc.getText());
  return { total, files: seen.size };
}

function setupWordCount(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.command = 'tssworkflow.projectWordCount';
  context.subscriptions.push(item);
  let deep = { key: '', total: 0, files: 0 };
  let counted = { key: '', big: false, all: 0 };
  const keyOf = (doc) => doc.uri.toString() + '@' + doc.version;
  const update = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !FL.isTexLike(ed.document) || !cfg().get('wordCount', true)) { item.hide(); return; }
    const doc = ed.document;
    // the document is counted once per version: a move of the cursor or of the selection does not read and count it again
    const key = keyOf(doc);
    if (counted.key !== key) {
      const text = doc.getText();
      const big = text.length > 3000000;
      counted = { key, big, all: big ? 0 : X.countWords(text) };
    }
    if (counted.big) { item.hide(); return; }
    const all = counted.all;
    const sel = ed.selection.isEmpty ? 0 : X.countWords(doc.getText(ed.selection));
    item.text = '$(pencil) ' + (sel ? tr('{0} із {1} сл.', sel, all) : tr('{0} сл.', all));
    const more = deep.key === keyOf(doc) && deep.files > 1 ? '\n' + tr('З підключеними файлами ({0}): {1}', deep.files, deep.total) : '';
    item.tooltip = tr('Слів у {0}: {1} (без команд, формул, коментарів, рисунків)', path.basename(doc.uri.fsPath), all) + (sel ? '\n' + tr('У виділенні: {0}', sel) : '') + more + '\n' + tr('Клік: слова в усіх файлах проєкту. Вимкнути: tssworkflow.wordCount');
    item.show();
    debounce('wordcount.deep', 1500, () => {
      const cur = vscode.window.activeTextEditor;
      if (!cur || cur.document !== doc || deep.key === keyOf(doc)) return;
      try { const d = deepWords(doc); deep = { key: keyOf(doc), total: d.total, files: d.files }; update(); } catch (e) { /* the status stays without the extra line */ }
    });
  };
  const later = () => debounce('wordcount.update', 300, update);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(later),
    vscode.window.onDidChangeTextEditorSelection(later),
    vscode.workspace.onDidChangeTextDocument((e) => { const ed = vscode.window.activeTextEditor; if (ed && e.document === ed.document) later(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow.wordCount')) update(); })
  );
  update();
}

async function projectWordCountCmd() {
  const root = (vscode.workspace.workspaceFolders || [])[0];
  if (!root) { info(tr('Відкрий папку проєкту.')); return; }
  const files = await FL.projectFiles(['.tex'], root.uri.fsPath);
  const rows = files.map((f) => ({ path: f.path, abs: f.abs, words: X.countWords(f.text) })).filter((r) => r.words > 0);
  if (!rows.length) { info(tr('У проєкті немає слів у .tex-файлах.')); return; }
  const total = rows.reduce((a, r) => a + r.words, 0);
  // per chapter (first folder)
  const byCh = new Map();
  for (const r of rows) { const k = r.path.includes('/') ? r.path.split('/')[0] : tr('(корінь)'); byCh.set(k, (byCh.get(k) || 0) + r.words); }
  const order = FL.chapterOrder();
  const sep = vscode.QuickPickItemKind && vscode.QuickPickItemKind.Separator;
  /** @type {Array<import('vscode').QuickPickItem & Record<string, any>>} */
  const items = [{ label: tr('$(pencil) Усього: {0} слів у {1} файлах', total, rows.length), description: tr('без команд, формул, коментарів, рисунків') }];
  if (sep) items.push({ label: tr('За розділами'), kind: sep });
  [...byCh].sort((a, b) => (FL.chapterRank(order, a[0] + '/x') - FL.chapterRank(order, b[0] + '/x')) || (a[0] < b[0] ? -1 : 1)).forEach(([k, n]) => items.push({ label: '$(folder) ' + k, description: tr('{0} сл. · {1}%', n, Math.round(100 * n / total)) }));
  if (sep) items.push({ label: tr('За файлами'), kind: sep });
  rows.sort((a, b) => b.words - a.words).forEach((r) => items.push({ label: r.path, description: tr('{0} сл.', r.words), abs: r.abs }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: tr('Слова в проєкті; вибери файл, щоб відкрити'), matchOnDescription: true });
  if (pick && pick.abs) vscode.window.showTextDocument(vscode.Uri.file(pick.abs));
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.projectWordCount', projectWordCountCmd));
  setupWordCount(context);
}

exports.register = register;
exports.deepWords = deepWords;
