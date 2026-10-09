'use strict';
/* wrapEnv.js: "Wrap selection in environment" (tssworkflow.wrapEnv, Ctrl+Alt+W).
 * The environment is picked from one list that holds: the ones used last, the ones defined in the project's
 * .cls/.sty, your own (tssworkflow.wrapEnv.extra), the others used in the project and the standard ones.
 * Anything else can be typed, with arguments: minipage{0.5\linewidth}. The logic is in wrapEnvPure.js.
 * An environment that has a prefix in tssworkflow.labelPrefixes gets a \label{prefix} (wrapEnv.label). */
const vscode = require('vscode');
const path = require('path');
const P = require('./wrapEnvPure');
const MP = require('./macrosPure');
const { pickTyped, sep } = require('./pickTyped');
const { cfg, info, warn, texFiles, textOfPath } = require('./util');

const RECENT_KEY = 'tssworkflow.wrapEnv.recent';
const RECENT_MAX = 8;
const PROJECT_TTL = 60000;
let state = null; // the extension's globalState (recently used environments)
let projectCache = null; // { at, counts }: how often each environment is used in the project's files

const item = (name, rest, extra) => Object.assign({ label: name, description: rest || undefined, pick: { name, rest: rest || '' } }, extra);

async function projectEnvs(doc) {
  try {
    const { envs } = await require('./macros')._allMacros(doc);
    return [...envs.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { return []; }
}

// Map name -> uses in all .tex/.tikz files of the workspace (cached for a minute, dropped on save)
async function projectCounts() {
  if (projectCache && Date.now() - projectCache.at < PROJECT_TTL) return projectCache.counts;
  const counts = new Map();
  try {
    for (const u of await texFiles()) {
      const text = textOfPath(u.fsPath);
      if (!text) continue;
      for (const [n, c] of P.countEnvs(text)) counts.set(n, (counts.get(n) || 0) + c);
    }
  } catch (e) { /* no workspace: only the open file counts */ }
  projectCache = { at: Date.now(), counts };
  return counts;
}

// the groups of the list; a name stays in the first group where it appears
async function buildItems(doc) {
  const seen = new Set();
  const groups = [];
  const add = (title, list) => {
    const fresh = list.filter((it) => !seen.has(it.pick.name));
    fresh.forEach((it) => seen.add(it.pick.name));
    if (fresh.length) groups.push(sep(title), ...fresh);
  };

  const recent = ((state && state.get(RECENT_KEY)) || []).filter((r) => r && r.name);
  add('Останні', recent.map((r) => item(r.name, r.rest)));

  const proj = await projectEnvs(doc);
  add('Проєкт (.cls / .sty)', proj.map((e) => item(e.name, P.argsOfMacro(e), {
    detail: (e.doc ? e.doc.split('\n')[0] + ' · ' : '') + MP.signature(e).slice(e.name.length) + (e.file ? '  ' + path.basename(e.file) + ':' + (e.line + 1) : '')
  })));

  const mine = (cfg().get('wrapEnv.extra', []) || []).map((s) => P.parseEnvInput(s)).filter(Boolean);
  add('Мої (tssworkflow.wrapEnv.extra)', mine.map((p) => item(p.name, p.rest)));

  // used in the project (and in the open buffer, which may be newer than the cache), most used first
  const std = new Map(P.STANDARD_ENVS.map((s) => [s.name, s]));
  const counts = new Map(await projectCounts());
  for (const [n, c] of P.countEnvs(doc.getText())) if (!counts.has(n)) counts.set(n, c);
  const used = [...counts].filter(([n]) => !std.has(n)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  add('Ще в проєкті', used.map(([n, c]) => item(n, '', { detail: c + '×' })));

  add('Стандартні', P.STANDARD_ENVS.map((s) => item(s.name, s.rest, { detail: s.desc })));
  return groups;
}

async function remember(env) {
  if (!state) return;
  const list = ((state.get(RECENT_KEY)) || []).filter((r) => r && r.name && r.name !== env.name);
  list.unshift({ name: env.name, rest: env.rest });
  await state.update(RECENT_KEY, list.slice(0, RECENT_MAX));
}

// an empty environment at the caret: Tab goes {} of the arguments -> \label -> body
function snippetFor(env, label) {
  const s = new vscode.SnippetString();
  let n = 0;
  const k = env.rest.search(/\{\}|\[\]/);
  if (k >= 0) {
    s.appendText('\\begin{' + env.name + '}' + env.rest.slice(0, k + 1)).appendTabstop(++n).appendText(env.rest.slice(k + 1));
  } else {
    s.appendText('\\begin{' + env.name + '}' + env.rest);
  }
  const lab = () => s.appendText('\n\t\\label{' + label.prefix).appendTabstop(label.where === 'end' ? 0 : ++n).appendText('}');
  if (label && label.where !== 'end') lab();
  s.appendText('\n\t');
  if (label && label.where === 'end') { s.appendTabstop(++n); lab(); } else s.appendTabstop(0);
  return s.appendText('\n\\end{' + env.name + '}');
}

const parseTyped = (v) => {
  const p = P.parseEnvInput(v);
  return p && { pick: p, name: p.name, label: p.name + p.rest, withArgs: !!p.rest };
};

async function wrapEnv() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  const sels = ed.selections.filter((s) => !s.isEmpty);

  const env = await pickTyped(await buildItems(doc),
    (sels.length ? 'Обгорнути виділене' : 'Вставити порожнє середовище') + ': вибери зі списку або введи своє, напр. minipage{0.5\\linewidth}', parseTyped);
  if (!env) return;

  const prefixes = cfg().get('wrapEnv.label', true) ? cfg().get('labelPrefixes', {}) : {};

  if (!sels.length) {
    await ed.insertSnippet(snippetFor(env, P.labelFor(env.name, prefixes, '')));
    await remember(env);
    return;
  }

  const lines = [];
  for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
  const unit = ed.options.insertSpaces ? ' '.repeat(Number(ed.options.tabSize) || 4) : '\t';
  const indent = cfg().get('wrapEnv.indent', true);
  const edits = sels
    .slice()
    .sort((a, b) => a.start.compareTo(b.start))
    .map((s) => P.wrapLines(lines, { line: s.start.line, character: s.start.character }, { line: s.end.line, character: s.end.character },
      { name: env.name, rest: env.rest, unit, indent, label: P.labelFor(env.name, prefixes, doc.getText(s)) }));
  if (P.overlaps(edits)) { warn('Два виділення на одному рядку: обгорнути їх окремо не вийде. Виділи кожне на своїх рядках.'); return; }

  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const ok = await ed.edit((b) => {
    for (const e of edits) {
      b.replace(new vscode.Range(e.startLine, 0, e.endLine, lines[e.endLine].length), e.lines.join(eol));
    }
  });
  if (!ok) { info('Не вдалося змінити документ.'); return; }

  // the lines of the earlier edits move the later ones
  let shift = 0;
  const cursors = edits.map((e) => {
    const p = new vscode.Position(e.cursor.line + shift, e.cursor.character);
    shift += e.lines.length - (e.endLine - e.startLine + 1);
    return new vscode.Selection(p, p);
  });
  ed.selections = cursors;
  ed.revealRange(cursors[0]);
  await remember(env);
}

function register(context) {
  state = context.globalState;
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.wrapEnv', wrapEnv),
    vscode.workspace.onDidSaveTextDocument(() => { projectCache = null; })
  );
}

module.exports = { register };
