'use strict';
/* keyFormulas.js: key formulas for the chapter summary.
 *   tssworkflow.markKeyFormula    sets / removes the mark  %! key  of the formula under the cursor
 *   tssworkflow.keyFormulasDraft  a draft of "Підсумки" from the marked formulas: of the open file when it has any, else of the whole
 *                                 project (a block per chapter, in the order of main.tex); opens in a new LaTeX document
 * The logic is in keyFormulasPure.js. */
const vscode = require('vscode');
const FL = require('./filesAndLabels');
const { tr } = require('./i18n');
const K = require('./keyFormulasPure');
const { isTex } = require('./util');

const info = (m) => vscode.window.showInformationMessage(m);

async function markCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info(tr('Постав курсор у формулу (equation, align, …) файла .tex.')); return; }
  const doc = ed.document;
  const lines = doc.getText().split(/\r?\n/);
  const r = K.toggleKey(lines, ed.selection.active.line);
  if (!r) { info(tr('Курсор не в формулі (equation, align, gather, multline, …).')); return; }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  await ed.edit((b) => {
    if (r.type === 'insert') b.replace(new vscode.Range(r.line, 0, r.line, 0), r.text + eol);
    else if (r.type === 'delete') b.replace(new vscode.Range(r.line, 0, r.line + 1, 0), '');
    else b.replace(new vscode.Range(r.line, 0, r.line, doc.lineAt(r.line).text.length), r.text);
  });
  vscode.window.setStatusBarMessage(r.marked ? tr('Формулу позначено як ключову (%! key)') : tr('Позначку ключової формули знято'), 3000);
}

async function draftCmd() {
  const root = (vscode.workspace.workspaceFolders || [])[0];
  if (!root) { info(tr('Відкрий теку проєкту.')); return; }
  const ed = vscode.window.activeTextEditor;
  let files = null;
  if (ed && isTex(ed.document) && K.keyFormulas(ed.document.getText().split(/\r?\n/)).length) {
    files = [{ path: vscode.workspace.asRelativePath(ed.document.uri, false), text: ed.document.getText() }]; // unsaved edits count
  } else {
    files = (await FL.projectFiles(['.tex'], root.uri.fsPath)).sort(FL.byChapter(FL.chapterOrder()));
  }
  const r = K.draftSummary(files, {});
  if (!r.count) { info(tr('Немає формул з позначкою «%! key». Постав курсор у формулу й виконай «Mark / unmark the formula under the cursor as key».')); return; }
  const d = await vscode.workspace.openTextDocument({ language: 'latex', content: r.text });
  await vscode.window.showTextDocument(d, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  vscode.window.setStatusBarMessage(tr('Чернетка «Підсумки»: {0} формул у {1} файлах', r.count, r.files), 5000);
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.markKeyFormula', () => markCmd().catch(() => {})),
    vscode.commands.registerCommand('tssworkflow.keyFormulasDraft', () => draftCmd().catch(() => {}))
  );
}
exports.register = register;
