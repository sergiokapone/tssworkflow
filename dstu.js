'use strict';
/* dstu.js: "Check .bib against ДСТУ 8302:2015". The .bib files of the project (tssworkflow.excludeFolders respected), all entries
 * or only the cited ones (\cite & co. in the .tex / .tikz files; \nocite{*} means all), checked by dstuPure.js; the report is a
 * document of projectRefactor.reportDoc: `file.bib:line` are links, "↻ Оновити звіт" checks again. */
const vscode = require('vscode');
const path = require('path');
const D = require('./dstuPure');
const P = require('./corePure');
const { tr } = require('./i18n');
const { excludeNow, projectRoot, texFiles, textOf, warn } = require('./util');

// the keys cited in the project, or null when \nocite{*} takes them all
async function citedKeys() {
  const keys = new Set();
  for (const u of await texFiles()) {
    const r = P.scanCites(await textOf(u));
    if (r.nociteAll) return null;
    for (const c of r.cites) keys.add(c.name);
  }
  return keys;
}

async function compute(root, cited) {
  const uris = await vscode.workspace.findFiles('**/*.bib', excludeNow(), 200);
  const files = [];
  for (const u of uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) files.push({ rel: path.relative(root, u.fsPath).replace(/\\/g, '/'), text: await textOf(u) });
  const only = cited ? await citedKeys() : null;
  return { files, r: D.dstuReport(files, { only }) };
}

async function dstuCmd() {
  const root = projectRoot();
  if (!root) { warn(tr('Відкрий папку проєкту (workspace).')); return; }
  const ALL = tr('Усі записи .bib'), CITED = tr('Лише цитовані в проєкті');
  const pick = await vscode.window.showQuickPick([CITED, ALL], { placeHolder: tr('ДСТУ 8302:2015: які записи перевірити?') });
  if (!pick) return;
  const cited = pick === CITED;
  const { files, r } = await compute(root, cited);
  if (!files.length) { warn(tr('У проєкті немає .bib файлів: перевіряти нічого.')); return; }
  await require('./projectRefactor').reportDoc(r.md, root, async () => (await compute(root, cited)).r.md);
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.dstuBib', dstuCmd));
}

module.exports = { register, _t: { compute, citedKeys } };
