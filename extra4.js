'use strict';
/* TSS Workflow 0.5.1:
 *   Format tblr            tblr / longtblr / talltblr: options one per line with "=" aligned, cells in a grid
 *   Format inline \\tikz     (0.6.1) one-line \\tikz[...]{...} -> one statement per line
 *   Renumber Beamer Slides "% ==== Слайд N ====" banners around frames, renumbered on every run
 * Both can also run on save (tssworkflow.tblr.formatOnSave, tssworkflow.beamer.autoRenumber).
 * The logic without VS Code is in extra4Pure.js. */
const vscode = require('vscode');
const X = require('./extra4Pure');

const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
const info = (m, ...b) => vscode.window.showInformationMessage(m, ...b);
const warn = (m, ...b) => vscode.window.showWarningMessage(m, ...b);
const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex');

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

const reasons = (skipped) => skipped.slice(0, 4).map((s) => 'рядок ' + s.line + ': ' + s.reason).join('; ') + (skipped.length > 4 ? '; ...' : '');

// offsets of the normalized (\n) text for a (line, character) pair
function lineStarts(text) {
  const st = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') st.push(i + 1);
  return st;
}

async function formatTblrCmd(api) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info('Відкрий .tex-файл із таблицею tblr.'); return; }
  const doc = ed.document;
  const text = doc.getText().replace(/\r\n/g, '\n');
  const o = tblrOptions(ed);
  const envs = X.findEnvs(text, o.envs);
  if (!envs.length) { info('У файлі немає оточень ' + o.envs.join(', ') + '.'); return; }
  const st = lineStarts(text);
  const off = (p) => (st[p.line] === undefined ? text.length : st[p.line] + p.character);
  const a = off(ed.selection.start);
  const b = off(ed.selection.end);
  let chosen;
  let scope;
  if (!ed.selection.isEmpty) {
    chosen = envs.filter((e) => e.start < b && e.end > a);
    scope = 'у виділенні';
  } else {
    const around = envs.filter((e) => e.start <= a && a <= e.end).sort((x, y) => (x.end - x.start) - (y.end - y.start));
    if (around.length) { chosen = [around[0]]; scope = 'під курсором'; } else { chosen = envs; scope = 'у файлі'; }
  }
  if (!chosen.length) { info('У виділенні немає таблиці ' + o.envs.join(' / ') + '.'); return; }
  const res = X.formatTblr(text, Object.assign({}, o, { include: new Set(chosen.map((e) => e.start)) }));
  const oldL = text.split('\n');
  const newL = res.text.split('\n');
  const d = X.diffRange(oldL, newL);
  const skippedMsg = res.skipped.length ? ' Пропущено ' + res.skipped.length + ': ' + reasons(res.skipped) + '.' : '';
  if (!d) {
    if (res.skipped.length) warn('Таблиці ' + scope + ' не змінено.' + skippedMsg);
    else info('Таблиці ' + scope + ' уже відформатовані.');
    return;
  }
  const sum = 'Таблиць відформатовано: ' + res.formatted + ' (' + scope + ').' + skippedMsg;
  const applied = await api.applyWithPreview(ed, d.s, d.e, d.lines, 'Форматування tblr', sum);
  if (applied) vscode.window.setStatusBarMessage(sum, 4000);
  if (res.skipped.length) warn('Пропущено ' + res.skipped.length + ': ' + reasons(res.skipped) + '.');
}

// Format inline \tikz: one-line \tikz[...]{...} (selection, the one under the cursor, or all in the file) -> one statement per line
async function formatTikzCmd(api) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info('Відкрий .tex-файл із \\tikz{…}.'); return; }
  const doc = ed.document;
  const text = doc.getText().replace(/\r\n/g, '\n');
  const st = lineStarts(text);
  const off = (p) => (st[p.line] === undefined ? text.length : st[p.line] + p.character);
  const o = tblrOptions(ed);
  const min = Number(cfg().get('tikzFormat.minLength', 100));
  const opts = { unit: o.unit, minLength: Number.isFinite(min) ? Math.max(0, min) : 100 };
  let scope = 'у файлі';
  if (!ed.selection.isEmpty) { opts.only = [off(ed.selection.start), off(ed.selection.end)]; scope = 'у виділенні'; }
  else {
    const c = off(ed.selection.active);
    const here = X.formatInlineTikz(text, Object.assign({}, opts, { only: [c, c] }));
    if (here.found) { opts.only = [c, c]; scope = 'під курсором'; }
  }
  const res = X.formatInlineTikz(text, opts);
  const skippedMsg = res.skipped.length ? ' Пропущено ' + res.skipped.length + ': ' + reasons(res.skipped) + '.' : '';
  if (!res.found) { info('Немає \\tikz{…} ' + scope + '.'); return; }
  const oldL = text.split('\n');
  const d = X.diffRange(oldL, res.text.split('\n'));
  if (!d) {
    if (res.skipped.length) warn('\\tikz ' + scope + ' не змінено.' + skippedMsg);
    else info('Нічого розкладати ' + scope + ': код або вже в кілька рядків, або коротший за ' + opts.minLength + ' символів (tssworkflow.tikzFormat.minLength).');
    return;
  }
  const sum = 'Розкладено \\tikz: ' + res.formatted + ' (' + scope + ').' + skippedMsg;
  if (await api.applyWithPreview(ed, d.s, d.e, d.lines, 'Форматування \\tikz', sum)) vscode.window.setStatusBarMessage(sum, 4000);
}

async function renumberBeamerCmd(api) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) { info('Відкрий .tex-файл презентації beamer.'); return; }
  const oldL = docLines(ed.document);
  const res = X.renumberBeamer(oldL, beamerOptions());
  if (!res.isBeamer) { info('Це не презентація beamer (немає \\documentclass{beamer}), нічого не змінено.'); return; }
  if (!res.frames) { info('У файлі немає \\begin{frame}, нічого не змінено.'); return; }
  const d = X.diffRange(oldL, res.lines);
  if (!d) { info('Номери слайдів уже актуальні (' + res.frames + ' фреймів).'); return; }
  const sum = 'Слайди: вставлено рамок ' + res.inserted + ', оновлено номерів ' + res.renumbered +
    (res.titleSkipped ? ', титульних пропущено ' + res.titleSkipped : '') + (res.skipped ? ', пропущено (фрейм не на початку рядка) ' + res.skipped : '') + '.';
  if (await api.applyWithPreview(ed, d.s, d.e, d.lines, 'Нумерація слайдів', sum)) vscode.window.setStatusBarMessage(sum, 4000);
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
