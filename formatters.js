'use strict';
/* TSS Workflow 0.5.1:
 *   Format tblr            tblr / longtblr / talltblr: options one per line with "=" aligned, cells in a grid
 *   Format inline \\tikz     (0.6.1) one-line \\tikz[...]{...} -> one statement per line
 *   Renumber Beamer Slides "% ==== Слайд N ====" banners around frames, renumbered on every run
 * Both can also run on save (tssworkflow.tblr.formatOnSave, tssworkflow.beamer.autoRenumber).
 * The logic without VS Code is in formattersPure.js. */
const vscode = require('vscode');
const { tr } = require('./i18n');
const X = require('./formattersPure');
const { cfg, info, isTex, warn } = require('./util');


function docLines(doc) {
  const a = [];
  for (let i = 0; i < doc.lineCount; i++) a.push(doc.lineAt(i).text);
  return a;
}

function tblrOptions(ed) {
  const c = cfg();
  const o = (ed && ed.options) || {};
  const tabSize = typeof o.tabSize === 'number' ? o.tabSize : 2;
  const names = c.get('tblr.environments', ['tblr', 'longtblr', 'talltblr']);
  return {
    envs: Array.isArray(names) && names.length ? names : ['tblr', 'longtblr', 'talltblr'],
    maxWidth: Math.max(40, Number(c.get('tblr.maxWidth', 100)) || 100),
    sort: c.get('tblr.sortOptions', true) !== false,
    unit: o.insertSpaces === false ? '\t' : ' '.repeat(tabSize),
    tabSize
  };
}

function beamerOptions() {
  return { skipTitle: cfg().get('beamer.skipTitleFrame', true) !== false };
}

const reasons = (skipped) => skipped.slice(0, 4).map((s) => tr('рядок {0}: {1}', s.line, s.reason)).join('; ') + (skipped.length > 4 ? '; ...' : '');

// offsets of the normalized (\n) text for a (line, character) pair
function lineStarts(text) {
  const st = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') st.push(i + 1);
  return st;
}

async function formatTblrCmd(api) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info(tr('Відкрий .tex-файл із таблицею tblr.')); return; }
  const doc = ed.document;
  const text = doc.getText().replace(/\r\n/g, '\n');
  const o = tblrOptions(ed);
  const envs = X.findEnvs(text, o.envs);
  if (!envs.length) { info(tr('У файлі немає оточень {0}.', o.envs.join(', '))); return; }
  const st = lineStarts(text);
  const off = (p) => (st[p.line] === undefined ? text.length : st[p.line] + p.character);
  const a = off(ed.selection.start);
  const b = off(ed.selection.end);
  let chosen;
  let scope;
  if (!ed.selection.isEmpty) {
    chosen = envs.filter((e) => e.start < b && e.end > a);
    scope = tr('у виділенні');
  } else {
    const around = envs.filter((e) => e.start <= a && a <= e.end).sort((x, y) => (x.end - x.start) - (y.end - y.start));
    if (around.length) { chosen = [around[0]]; scope = tr('під курсором'); } else { chosen = envs; scope = tr('у файлі'); }
  }
  if (!chosen.length) { info(tr('У виділенні немає таблиці {0}.', o.envs.join(' / '))); return; }
  const res = X.formatTblr(text, Object.assign({}, o, { include: new Set(chosen.map((e) => e.start)) }));
  const oldL = text.split('\n');
  const newL = res.text.split('\n');
  const d = X.diffRange(oldL, newL);
  const skippedMsg = res.skipped.length ? tr(' Пропущено {0}: {1}.', res.skipped.length, reasons(res.skipped)) : '';
  if (!d) {
    if (res.skipped.length) warn(tr('Таблиці {0} не змінено.', scope) + skippedMsg);
    else info(tr('Таблиці {0} уже відформатовані.', scope));
    return;
  }
  const sum = tr('Таблиць відформатовано: {0} ({1}).', res.formatted, scope) + skippedMsg;
  const applied = await api.applyWithPreview(ed, d.s, d.e, d.lines, tr('Форматування tblr'), sum);
  if (applied) vscode.window.setStatusBarMessage(sum, 4000);
  if (res.skipped.length) warn(tr('Пропущено {0}: {1}.', res.skipped.length, reasons(res.skipped)));
}

// Format inline \tikz: one-line \tikz[...]{...} (selection, the one under the cursor, or all in the file) -> one statement per line
async function formatTikzCmd(api) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info(tr('Відкрий .tex-файл із \\tikz{…}.')); return; }
  const doc = ed.document;
  const text = doc.getText().replace(/\r\n/g, '\n');
  const st = lineStarts(text);
  const off = (p) => (st[p.line] === undefined ? text.length : st[p.line] + p.character);
  const o = tblrOptions(ed);
  const min = Number(cfg().get('tikzFormat.minLength', 100));
  const opts = { unit: o.unit, minLength: Number.isFinite(min) ? Math.max(0, min) : 100 };
  let scope = tr('у файлі');
  if (!ed.selection.isEmpty) { opts.only = [off(ed.selection.start), off(ed.selection.end)]; scope = tr('у виділенні'); }
  else {
    const c = off(ed.selection.active);
    const here = X.formatInlineTikz(text, Object.assign({}, opts, { only: [c, c] }));
    if (here.found) { opts.only = [c, c]; scope = tr('під курсором'); }
  }
  const res = X.formatInlineTikz(text, opts);
  const skippedMsg = res.skipped.length ? tr(' Пропущено {0}: {1}.', res.skipped.length, reasons(res.skipped)) : '';
  if (!res.found) { info(tr('Немає \\tikz{…} {0}.', scope)); return; }
  const oldL = text.split('\n');
  const d = X.diffRange(oldL, res.text.split('\n'));
  if (!d) {
    if (res.skipped.length) warn(tr('\\tikz {0} не змінено.', scope) + skippedMsg);
    else info(tr('Нічого розкладати {0}: код або вже в кілька рядків, або коротший за {1} символів (tssworkflow.tikzFormat.minLength).', scope, opts.minLength));
    return;
  }
  const sum = tr('Розкладено \\tikz: {0} ({1}).', res.formatted, scope) + skippedMsg;
  if (await api.applyWithPreview(ed, d.s, d.e, d.lines, tr('Форматування \\tikz'), sum)) vscode.window.setStatusBarMessage(sum, 4000);
}

async function renumberBeamerCmd(api) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info(tr('Відкрий .tex-файл презентації beamer.')); return; }
  const oldL = docLines(ed.document);
  const res = X.renumberBeamer(oldL, beamerOptions());
  if (!res.isBeamer) { info(tr('Це не презентація beamer (немає \\documentclass{beamer}), нічого не змінено.')); return; }
  if (!res.frames) { info(tr('У файлі немає \\begin{frame}, нічого не змінено.')); return; }
  const d = X.diffRange(oldL, res.lines);
  if (!d) { info(tr('Номери слайдів уже актуальні ({0} фреймів).', res.frames)); return; }
  const sum = tr('Слайди: вставлено рамок {0}, оновлено номерів {1}', res.inserted, res.renumbered) +
    (res.titleSkipped ? tr(', титульних пропущено {0}', res.titleSkipped) : '') + (res.skipped ? tr(', пропущено (фрейм не на початку рядка) {0}', res.skipped) : '') + '.';
  if (await api.applyWithPreview(ed, d.s, d.e, d.lines, tr('Нумерація слайдів'), sum)) vscode.window.setStatusBarMessage(sum, 4000);
}

// on save: the same changes without the preview, as one edit (one Ctrl+Z)
function onWillSave(e) {
  const doc = e.document;
  if (!isTex(doc)) return;
  const c = cfg();
  const doBeamer = c.get('beamer.autoRenumber', false) === true;
  const doTblr = c.get('tblr.formatOnSave', false) === true;
  if (!doBeamer && !doTblr) return;
  const oldL = docLines(doc);
  let lines = oldL;
  if (doBeamer) lines = X.renumberBeamer(lines, beamerOptions()).lines;
  if (doTblr) {
    const ed = vscode.window.visibleTextEditors.find((t) => t.document === doc);
    lines = X.formatTblr(lines.join('\n'), tblrOptions(ed)).text.split('\n');
  }
  const d = X.diffRange(oldL, lines);
  if (!d) return;
  const range = new vscode.Range(d.s, 0, d.e, oldL[d.e].length);
  e.waitUntil(Promise.resolve([vscode.TextEdit.replace(range, d.lines.join('\n'))]));
}

function register(context, api) {
  api = api || {};
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.formatTblr', () => formatTblrCmd(api)),
    vscode.commands.registerCommand('tssworkflow.formatTikz', () => formatTikzCmd(api)),
    vscode.commands.registerCommand('tssworkflow.renumberBeamer', () => renumberBeamerCmd(api)),
    vscode.workspace.onWillSaveTextDocument(onWillSave)
  );
}

exports.register = register;
exports._t = { formatTblrCmd, formatTikzCmd, renumberBeamerCmd, onWillSave, tblrOptions };
