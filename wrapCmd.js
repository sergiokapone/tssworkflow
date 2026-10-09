'use strict';
/* wrapCmd.js: "Wrap selection in command" (tssworkflow.wrapCmd, Ctrl+Alt+K): \emph{...}, \mathrm{...}, \vect{...}.
 * One list: the commands used last, the ones defined in the project's .cls/.sty (with at least one mandatory
 * argument), your own (tssworkflow.wrapCmd.extra) and the standard ones; a command can be typed with the arguments
 * that stand before the wrapped one: textcolor{red}. Without a selection the word at the caret is wrapped (the caret
 * on \alpha wraps the whole \alpha), and with no word a command with an empty argument is inserted. */
const vscode = require('vscode');
const P = require('./wrapCmdPure');
const { pickTyped, sep } = require('./pickTyped');
const { cfg } = require('./util');

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

async function wrapCmd() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  let ranges = ed.selections.filter((s) => !s.isEmpty).map((s) => new vscode.Range(s.start, s.end));
  const wordMode = !ranges.length;
  if (wordMode) ranges = ed.selections.map((s) => wordAt(doc, s.active)).filter(Boolean);

  const spec = await pickTyped(await buildItems(doc),
    (wordMode ? (ranges.length ? 'Обгорнути слово біля курсора' : 'Вставити команду') : 'Обгорнути виділене') + ' в команду: вибери зі списку або введи, напр. textcolor{red}', parseTyped);
  if (!spec) return;

  if (!ranges.length) { await ed.insertSnippet(snippetFor(spec)); await remember(spec); return; }

  ranges.sort((a, b) => a.start.compareTo(b.start));
  const jobs = ranges.map((r) => ({ range: r, from: doc.offsetAt(r.start), old: doc.getText(r).length, w: P.wrapInline(doc.getText(r), spec) }));
  const ok = await ed.edit((b) => { for (const j of jobs) b.replace(j.range, j.w.text); });
  if (!ok) return;
  let delta = 0;
  const cursors = jobs.map((j) => {
    const p = ed.document.positionAt(j.from + delta + j.w.cursor);
    delta += j.w.text.length - j.old;
    return new vscode.Selection(p, p);
  });
  ed.selections = cursors;
  ed.revealRange(cursors[0]);
  await remember(spec);
}

function register(context) {
  state = context.globalState;
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.wrapCmd', wrapCmd));
}

module.exports = { register };
