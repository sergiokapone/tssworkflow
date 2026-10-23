'use strict';
// Runs inside a real VS Code (tests/integration/run.js starts it): the extension against the API it is written for, where the stubs
// of tests/*.vscode-stub.test.js can only imitate it. The workspace is a copy of tests/integration/fixture.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

const ID = 'Sergiy.tssworkflow';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms) {
  const end = Date.now() + (ms || 15000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(200);
  }
}
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const file = (rel) => vscode.Uri.file(path.join(root(), rel));
const posOf = (doc, text, plus) => doc.positionAt(doc.getText().indexOf(text) + (plus || 0));

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('the extension activates on a .tex file and registers every command of package.json', async () => {
  const doc = await vscode.workspace.openTextDocument(file('Ch/Ch.tex'));
  await vscode.window.showTextDocument(doc);
  assert.strictEqual(doc.languageId, 'latex');
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, 'installed');
  await until('activation', () => ext.isActive);
  const have = new Set(await vscode.commands.getCommands(true));
  const missing = ext.packageJSON.contributes.commands.map((c) => c.command).filter((c) => !have.has(c));
  assert.deepStrictEqual(missing, []);
});

t('go to definition of \\ref: the \\label in the same file', async () => {
  const doc = await vscode.workspace.openTextDocument(file('Ch/Ch.tex'));
  const locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, posOf(doc, 'fig:plot}.', 2));
  const hit = (locs || []).map((l) => l.uri ? l : { uri: l.targetUri, range: l.targetRange }).find((l) => l.uri.fsPath === doc.uri.fsPath);
  assert.ok(hit, 'a location in Ch.tex: ' + JSON.stringify(locs));
  assert.strictEqual(hit.range.start.line, 6);
});

t('go to definition from main.tex finds the label in another file (the cached index of labels.js)', async () => {
  const main = await vscode.workspace.openTextDocument(file('main.tex'));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(main.uri, new vscode.Position(4, 0), 'См. \\ref{eq:gauss}.\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', main.uri, posOf(main, 'eq:gauss', 2));
  const l = (locs || []).map((x) => x.uri ? x : { uri: x.targetUri, range: x.targetRange })[0];
  assert.ok(l && l.uri.fsPath.endsWith(path.join('Ch', 'Ch.tex')) && l.range.start.line === 3, JSON.stringify(locs));
});

t('completion inside \\ref{ lists the labels of the project', async () => {
  const doc = await vscode.workspace.openTextDocument(file('Ch/Ch.tex'));
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, posOf(doc, 'eq:gauss}.', 0));
  const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  for (const k of ['eq:gauss', 'fig:plot', 'ch:field']) assert.ok(labels.includes(k), k + ' in ' + labels.slice(0, 30).join(', '));
});

t('hover on \\ref shows the label (its context)', async () => {
  const doc = await vscode.workspace.openTextDocument(file('Ch/Ch.tex'));
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, posOf(doc, 'fig:plot}.', 2));
  const text = (hovers || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
  assert.ok(/fig:plot/.test(text), text);
});

t('rename of a label changes the \\label and every \\ref', async () => {
  const doc = await vscode.workspace.openTextDocument(file('Ch/Ch.tex'));
  const we = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, posOf(doc, 'eq:gauss}.', 1), 'eq:maxwell');
  assert.ok(we, 'a WorkspaceEdit');
  const edits = we.entries().flatMap(([u, es]) => es.map((e) => path.basename(u.fsPath) + ':' + e.range.start.line + ':' + e.newText));
  assert.ok(edits.includes('Ch.tex:3:eq:maxwell') && edits.includes('Ch.tex:1:eq:maxwell') && edits.includes('Ch.tex:8:eq:maxwell'), edits.join(' | '));
});

t('a missing \\input file is a diagnostic of main.tex', async () => {
  const main = await vscode.workspace.openTextDocument(file('main.tex'));
  await vscode.window.showTextDocument(main);
  // the test before inserted a line above: the delayed check of the extension must move the diagnostic with the text
  const line = main.getText().split('\n').findIndex((l) => l.includes('Ch/missing'));
  await until('the diagnostic on line ' + line, () => vscode.languages.getDiagnostics(main.uri).find((x) => x.code === 'file-missing-input' && x.range.start.line === line));
});

t('tssworkflow.excludeFolders: the label of old/ leaves the completion as soon as the setting changes', async () => {
  const doc = await vscode.workspace.openTextDocument(file('Ch/Ch.tex'));
  const labelsNow = async () => (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, posOf(doc, 'fig:plot}.', 0)))
    .items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.ok((await labelsNow()).includes('old:only'), 'before: old/ is a part of the project');
  await vscode.workspace.getConfiguration('tssworkflow').update('excludeFolders', ['old'], vscode.ConfigurationTarget.Workspace);
  try {
    await until('old:only gone', async () => !(await labelsNow()).includes('old:only'));
  } finally { await vscode.workspace.getConfiguration('tssworkflow').update('excludeFolders', undefined, vscode.ConfigurationTarget.Workspace); }
});

async function run() {
  let n = 0;
  const failed = [];
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { failed.push(name); console.log('FAIL ' + name + '\n  ' + (e && e.stack || e)); }
  }
  console.log('\n' + n + ' of ' + tests.length + ' passed in VS Code ' + vscode.version);
  if (failed.length) throw new Error(failed.length + ' failed: ' + failed.join('; '));
}

module.exports = { run };
