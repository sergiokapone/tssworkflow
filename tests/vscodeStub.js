'use strict';
/* A small stand-in for the `vscode` module: documents, an editor with edit/insertSnippet, a QuickPick that
 * picks by itself, configuration. Enough to run the wrapEnv and wrapCmd commands without VS Code. */
const Module = require('module');

class Position {
  constructor(l, c) { this.line = l; this.character = c; }
  compareTo(o) { return this.line - o.line || this.character - o.character; }
  translate(dl, dc) { return new Position(this.line + (dl || 0), this.character + (dc || 0)); }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; }
  }
  get isEmpty() { return this.start.compareTo(this.end) === 0; }
}
class Selection extends Range {
  constructor(a, b, c, d) { super(a, b, c, d); this.active = this.end; }
}
class SnippetString {
  constructor() { this.v = ''; }
  appendText(s) { this.v += s; return this; }
  appendTabstop(n) { this.v += '$' + n; return this; }
}

/* pick: { name } picks the item with that name; { typed } types the text and takes the first real item */
function makeVscode(text, selections, pick, cfgValues, files) {
  const doc = {
    eol: 1, lines: text.split('\n'),
    get lineCount() { return doc.lines.length; },
    lineAt: (i) => ({ text: doc.lines[i] }),
    offsetAt(p) { let o = 0; for (let i = 0; i < p.line; i++) o += doc.lines[i].length + 1; return o + p.character; },
    positionAt(o) { let l = 0; while (l < doc.lines.length - 1 && o > doc.lines[l].length) { o -= doc.lines[l].length + 1; l++; } return new Position(l, o); },
    getText(r) { const all = doc.lines.join('\n'); return r ? all.slice(doc.offsetAt(r.start), doc.offsetAt(r.end)) : all; },
    getWordRangeAtPosition(p, re) {
      const t = doc.lines[p.line]; const g = new RegExp(re.source, 'gu'); let m;
      while ((m = g.exec(t))) if (m.index <= p.character && p.character <= m.index + m[0].length) return new Range(p.line, m.index, p.line, m.index + m[0].length);
      return undefined;
    },
    uri: { fsPath: '/stub/main.tex' }
  };
  const ed = {
    document: doc, options: { insertSpaces: false, tabSize: 4 }, snippet: null, revealed: null,
    selections: selections.map((s) => new Selection(s[0], s[1], s[2], s[3])),
    async edit(fn) {
      const reps = [];
      fn({ replace: (r, s) => reps.push([doc.offsetAt(r.start), doc.offsetAt(r.end), s]) });
      reps.sort((a, b) => b[0] - a[0]);
      let all = doc.lines.join('\n');
      for (const [a, b, s] of reps) all = all.slice(0, a) + s + all.slice(b);
      doc.lines = all.split('\n');
      return true;
    },
    async insertSnippet(s) { ed.snippet = s.v; return true; },
    revealRange(r) { ed.revealed = r; }
  };
  const handlers = {};
  const vs = {
    Position, Range, Selection, SnippetString,
    EndOfLine: { LF: 1, CRLF: 2 }, QuickPickItemKind: { Separator: -1 }, warned: null,
    window: {
      activeTextEditor: ed, shown: null,
      createQuickPick() {
        const qp = {
          items: [], selectedItems: [], _v: [], _a: [],
          show() {
            vs.window.shown = qp;
            setImmediate(() => {
              if (pick.typed) { qp._v.forEach((f) => f(pick.typed)); qp.selectedItems = [qp.items.find((i) => i.pick)]; } else { qp.selectedItems = [qp.items.find((i) => i.pick && i.pick.name === pick.name)]; }
              qp._a.forEach((f) => f());
            });
          },
          onDidChangeValue(f) { qp._v.push(f); }, onDidAccept(f) { qp._a.push(f); }, onDidHide() {}, dispose() {}
        };
        return qp;
      },
      showWarningMessage(m) { vs.warned = m; }, showInformationMessage() {}
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d) }),
      workspaceFolders: [], textDocuments: [],
      findFiles: async () => (files || []).map((f) => ({ fsPath: f })),
      onDidSaveTextDocument: () => ({ dispose() {} })
    },
    commands: { registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; } },
    languages: {}, Uri: { file: (f) => f }
  };
  return { vs, ed, doc, handlers };
}

/* loads <ext>/<module>.js against the stub (fresh copy), registers it and runs the command `id` */
async function runCommand({ ext, module, id, text, selections, pick, cfg, files, envs, cmds }) {
  const path = require('path');
  const h = makeVscode(text, selections, pick, cfg || {}, files);
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return h.vs;
    if (req === './macros') return { _allMacros: async () => ({ cmds: cmds || new Map(), envs: envs || new Map() }) };
    return orig.call(this, req, ...rest);
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(ext) && /\.js$/.test(k)) delete require.cache[k];
  const mem = {};
  require(path.join(ext, module)).register({ subscriptions: [], globalState: { get: (k) => mem[k], update: async (k, v) => { mem[k] = v; } } });
  try { await h.handlers[id](); } finally { Module._load = orig; }
  return { h, mem };
}

module.exports = { makeVscode, runCommand, Position, Range, Selection };
