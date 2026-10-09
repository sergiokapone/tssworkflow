'use strict';
/* wrapEnv.js: "Wrap selection in environment" (tssworkflow.wrapEnv, Ctrl+Alt+W).
 * The environment is picked from one list that holds: the ones used last, the ones defined in the project's
 * .cls/.sty, your own (tssworkflow.wrapEnv.extra), the others already used in this file and the standard ones.
 * Anything else can be typed, with arguments: minipage{0.5\linewidth}. The logic is in wrapEnvPure.js. */
const vscode = require('vscode');
const path = require('path');
const P = require('./wrapEnvPure');
const MP = require('./macrosPure');
const { cfg, info, warn } = require('./util');

const RECENT_KEY = 'tssworkflow.wrapEnv.recent';
const RECENT_MAX = 8;
let state = null; // the extension's globalState (recently used environments)

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
const item = (name, rest, extra) => Object.assign({ label: name, description: rest || undefined, env: { name, rest: rest || '' } }, extra);

async function projectEnvs(doc) {
  try {
    const { envs } = await require('./macros')._allMacros(doc);
    return [...envs.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { return []; }
}

// the groups of the list; a name stays in the first group where it appears
async function buildItems(doc) {
  const seen = new Set();
  const groups = [];
  const add = (title, list) => {
    const fresh = list.filter((it) => !seen.has(it.env.name));
    fresh.forEach((it) => seen.add(it.env.name));
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

  const std = new Map(P.STANDARD_ENVS.map((s) => [s.name, s]));
  const used = P.envNamesInText(doc.getText()).filter((n) => !std.has(n));
  add('Ще в цьому файлі', used.map((n) => item(n, '')));

  add('Стандартні', P.STANDARD_ENVS.map((s) => item(s.name, s.rest, { detail: s.desc })));
  return groups;
}

// QuickPick that also accepts a typed name with arguments
function pickEnv(base, placeHolder) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.placeholder = placeHolder;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = base;
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); qp.dispose(); };
    qp.onDidChangeValue((v) => {
      const p = P.parseEnvInput(v);
      if (!p) { qp.items = base; return; }
      const exact = base.some((b) => b.env && b.env.name === p.name);
      if (exact && !p.rest) { qp.items = base; return; }
      const typed = { label: '$(add) ' + p.name + p.rest, description: 'ввести як є', env: p, alwaysShow: true };
      // with arguments typed the typed entry is the one wanted; a bare name must not hide the usual matches
      qp.items = p.rest ? [typed, ...base] : [...base, typed];
    });
    qp.onDidAccept(() => { const sel = qp.selectedItems[0]; finish(sel && sel.env ? sel.env : undefined); });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

async function remember(env) {
  if (!state) return;
  const list = ((state.get(RECENT_KEY)) || []).filter((r) => r && r.name && r.name !== env.name);
  list.unshift({ name: env.name, rest: env.rest });
  await state.update(RECENT_KEY, list.slice(0, RECENT_MAX));
}

function snippetFor(env) {
  const k = env.rest.search(/\{\}|\[\]/);
  const s = new vscode.SnippetString();
  if (k >= 0) {
    s.appendText('\\begin{' + env.name + '}' + env.rest.slice(0, k + 1)).appendTabstop(1)
      .appendText(env.rest.slice(k + 1) + '\n\t').appendTabstop(0);
  } else {
    s.appendText('\\begin{' + env.name + '}' + env.rest + '\n\t').appendTabstop(0);
  }
  return s.appendText('\n\\end{' + env.name + '}');
}

async function wrapEnv() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  const sels = ed.selections.filter((s) => !s.isEmpty);

  const env = await pickEnv(await buildItems(doc),
    (sels.length ? 'Обгорнути виділене' : 'Вставити порожнє середовище') + ': вибери зі списку або введи своє, напр. minipage{0.5\\linewidth}');
  if (!env) return;

  if (!sels.length) {
    await ed.insertSnippet(snippetFor(env));
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
    .map((s) => P.wrapLines(lines, { line: s.start.line, character: s.start.character }, { line: s.end.line, character: s.end.character }, { name: env.name, rest: env.rest, unit, indent }));
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
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.wrapEnv', wrapEnv));
}

module.exports = { register };
