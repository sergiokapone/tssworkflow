'use strict';
/* wrapCmd.js: "Wrap selection in command" (tssworkflow.wrapCmd, Ctrl+Alt+K): \emph{...}, \mathrm{...}, \vect{...}.
 * One list: the commands used last, the ones defined in the project's .cls/.sty (with at least one mandatory
 * argument), your own (tssworkflow.wrapCmd.extra) and the standard ones; a command can be typed with the arguments
 * that stand before the wrapped one: textcolor{red}. Without a selection the word at the caret is wrapped (the caret
 * on \alpha wraps the whole \alpha), and with no word a command with an empty argument is inserted. */
const vscode = require('vscode');
const P = require('./wrapCmdPure');
const { pickTyped, sep } = require('./pickTyped');
const { cfg, isTex } = require('./util');

const RECENT_KEY = 'tssworkflow.wrapCmd.recent';
const RECENT_MAX = 8;
let state = null;

const describe = (o) => (o.pre || '') + o.open + '…' + o.close + (o.post || '');
const item = (spec, extra) => {
  const pick = P.fill(spec);
  return Object.assign({ label: '\\' + pick.name, description: describe(pick), pick }, extra);
};

async function projectCmds(doc) {
  try {
    const { cmds } = await require('./macros')._allMacros(doc);
    return [...cmds.values()].map(P.partsOfMacro).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { return []; }
}

async function buildItems(doc) {
  const seen = new Set();
  const groups = [];
  const add = (title, list) => {
    const fresh = list.filter((it) => !seen.has(it.pick.name));
    fresh.forEach((it) => seen.add(it.pick.name));
    if (fresh.length) groups.push(sep(title), ...fresh);
  };
  add('Останні', ((state && state.get(RECENT_KEY)) || []).filter((r) => r && r.name).map((r) => item(r)));
  add('Проєкт (.cls / .sty)', (await projectCmds(doc)).map((c) => item(c)));
  add('Мої (tssworkflow.wrapCmd.extra)', (cfg().get('wrapCmd.extra', []) || []).map(P.parseCmdInput).filter(Boolean).map((c) => item(c)));
  add('Стандартні', P.STANDARD_CMDS.map((c) => item(c, { detail: c.desc })));
  return groups;
}

async function remember(spec) {
  if (!state) return;
  const list = ((state.get(RECENT_KEY)) || []).filter((r) => r && r.name && r.name !== spec.name);
  list.unshift({ name: spec.name, pre: spec.pre, open: spec.open, close: spec.close, post: spec.post });
  await state.update(RECENT_KEY, list.slice(0, RECENT_MAX));
}

const parseTyped = (v) => {
  const p = P.parseCmdInput(v);
  return p && { pick: p, name: p.name, label: '\\' + p.name + p.pre, withArgs: !!p.pre };
};

// the word at a caret, a backslash before it belongs to it (\alpha)
function wordAt(doc, pos) {
  const r = doc.getWordRangeAtPosition(pos, /[\p{L}\p{N}]+/u);
  if (!r) return null;
  if (r.start.character > 0 && doc.getText(new vscode.Range(r.start.translate(0, -1), r.start)) === '\\') {
    return new vscode.Range(r.start.translate(0, -1), r.end);
  }
  return r;
}

// an empty command at the caret: Tab goes through the {} fields and the argument, the end is after the command
function snippetFor(spec) {
  const o = P.fill(spec);
  const s = new vscode.SnippetString();
  let n = 0;
  const field = (text) => {
    for (let i = 0; i < text.length;) {
      const m = /\{\}|\[\]/.exec(text.slice(i));
      if (!m) { s.appendText(text.slice(i)); return; }
      s.appendText(text.slice(i, i + m.index + 1)).appendTabstop(++n);
      i += m.index + 1;
    }
  };
  s.appendText('\\' + o.name);
  field(o.pre);
  s.appendText(o.open).appendTabstop(++n).appendText(o.close);
  field(o.post);
  return s.appendTabstop(0);
}

// puts `spec` round every range (sorted copies of them), places the carets and remembers the choice
async function applySpec(ed, ranges, spec) {
  const doc = ed.document;
  ranges = ranges.slice().sort((a, b) => a.start.compareTo(b.start));
  const jobs = ranges.map((r) => ({ range: r, from: doc.offsetAt(r.start), old: doc.getText(r).length, w: P.wrapInline(doc.getText(r), spec) }));
  const ok = await ed.edit((b) => { for (const j of jobs) b.replace(j.range, j.w.text); });
  if (!ok) return false;
  let delta = 0;
  const cursors = jobs.map((j) => {
    const p = ed.document.positionAt(j.from + delta + j.w.cursor);
    delta += j.w.text.length - j.old;
    return new vscode.Selection(p, p);
  });
  ed.selections = cursors;
  ed.revealRange(cursors[0]);
  await remember(spec);
  return true;
}

// what a command acts on: the selections, else the words at the carets
function targets(ed) {
  const sel = ed.selections.filter((s) => !s.isEmpty).map((s) => new vscode.Range(s.start, s.end));
  if (sel.length) return { ranges: sel, words: false };
  return { ranges: ed.selections.map((s) => wordAt(ed.document, s.active)).filter(Boolean), words: true };
}

async function wrapCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  const { ranges, words } = targets(ed);

  const spec = await pickTyped(await buildItems(doc),
    (words ? (ranges.length ? 'Обгорнути слово біля курсора' : 'Вставити команду') : 'Обгорнути виділене') + ' в команду: вибери зі списку або введи, напр. textcolor{red}', parseTyped);
  if (!spec) return;

  if (!ranges.length) { await ed.insertSnippet(snippetFor(spec)); await remember(spec); return; }
  await applySpec(ed, ranges, spec);
}

/* ---------------- the menu "Format" (above a selection, in the light bulb, in the command palette) ---------------- */
const hintMode = () => String(cfg().get('wrapCmd.selectionHint', 'codelens'));
const SEL = [{ language: 'latex' }, { language: 'tex' }];

// tssworkflow.formatSelection(name?): the command of the menu round the selection; without a name the menu is shown
async function formatSelection(name) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const { ranges } = targets(ed);
  if (!ranges.length) { vscode.window.showInformationMessage('Виділи текст (або постав курсор на слово), який треба оформити.'); return; }
  let spec = typeof name === 'string' ? P.formatSpec(name) : null;
  if (!spec) {
    const items = [];
    let group = '';
    for (const f of P.FORMAT_MENU) {
      if (f.group !== group) { group = f.group; items.push(sep(group)); }
      items.push({ label: f.label, description: '\\' + f.name + '{…}', spec: P.formatSpec(f.name) });
    }
    items.push(sep(''), { label: '$(list-selection) Інша команда…', description: 'увесь список', other: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Оформити виділене', matchOnDescription: true });
    if (!pick) return;
    if (pick.other) { await vscode.commands.executeCommand('tssworkflow.wrapCmd'); return; }
    spec = pick.spec;
  }
  await applySpec(ed, ranges, spec);
}

// the buttons above the first line of a non-empty selection: bold, italic, underline, the menu
const lensChanged = new vscode.EventEmitter();
const selectionLens = {
  onDidChangeCodeLenses: lensChanged.event,
  provideCodeLenses(doc) {
    const ed = vscode.window.activeTextEditor;
    if (!['codelens', 'both'].includes(hintMode()) || !ed || ed.document !== doc || ed.selection.isEmpty) return [];
    const at = new vscode.Range(ed.selection.start.line, 0, ed.selection.start.line, 0);
    const quick = P.FORMAT_MENU.filter((f) => f.quick).sort((a, b) => a.quick - b.quick);
    const icon = { textbf: '$(bold) ', textit: '$(italic) ' };
    return quick.map((f) => new vscode.CodeLens(at, { title: (icon[f.name] || '') + f.label, command: 'tssworkflow.formatSelection', arguments: [f.name], tooltip: '\\' + f.name + '{…}' }))
      .concat(new vscode.CodeLens(at, { title: '$(chevron-down) Формат', command: 'tssworkflow.formatSelection', tooltip: 'Оформити виділене: список команд' }));
  }
};

// the light bulb (Ctrl+.) on a selection: the same entries
const selectionActions = {
  provideCodeActions(doc, range) {
    if (!['lightbulb', 'both'].includes(hintMode()) || !range || range.isEmpty) return [];
    const kind = vscode.CodeActionKind.RefactorRewrite.append('tssworkflow');
    const out = P.FORMAT_MENU.filter((f) => f.quick || f.name === 'emph').map((f) => {
      const a = new vscode.CodeAction('TSS: ' + f.label + ' \\' + f.name + '{…}', kind);
      a.command = { title: f.label, command: 'tssworkflow.formatSelection', arguments: [f.name] };
      return a;
    });
    const more = new vscode.CodeAction('TSS: Оформити виділене…', kind);
    more.command = { title: 'Формат', command: 'tssworkflow.formatSelection' };
    return out.concat(more);
  }
};

let lensTimer = null;
function register(context) {
  state = context.globalState;
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.wrapCmd', wrapCmd),
    vscode.commands.registerCommand('tssworkflow.formatSelection', formatSelection),
    vscode.languages.registerCodeLensProvider(SEL, selectionLens),
    vscode.languages.registerCodeActionsProvider(SEL, selectionActions, { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] }),
    // the buttons follow the selection, a moment after it stopped changing (they move the lines below down while shown)
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!['codelens', 'both'].includes(hintMode()) || !isTex(e.textEditor.document)) return;
      clearTimeout(lensTimer);
      lensTimer = setTimeout(() => lensChanged.fire(), e.textEditor.selection.isEmpty ? 0 : 400);
    }),
    lensChanged
  );
}

module.exports = { register };
