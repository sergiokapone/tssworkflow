'use strict';
/* Tests of wrapEnvPure.js (pure) and of wrapEnv.js (with a stub of the vscode module).
 * Run from the repository root: node tests/wrapEnv.test.js */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const P = require(path.join(EXT, 'wrapEnvPure.js'));
const MP = require(path.join(EXT, 'macrosPure.js'));

let n = 0;
const t = (name, fn) => { fn(); n++; };
const apply = (lines, edit) => lines.slice(0, edit.startLine).concat(edit.lines, lines.slice(edit.endLine + 1));
const W = (lines, a, b, o) => P.wrapLines(lines, { line: a[0], character: a[1] }, { line: b[0], character: b[1] }, Object.assign({ name: 'center', rest: '', unit: '\t', indent: true }, o));

t('parseEnvInput', () => {
  assert.deepStrictEqual(P.parseEnvInput('center'), { name: 'center', rest: '' });
  assert.deepStrictEqual(P.parseEnvInput(' equation* '), { name: 'equation*', rest: '' });
  assert.deepStrictEqual(P.parseEnvInput('minipage{0.5\\linewidth}'), { name: 'minipage', rest: '{0.5\\linewidth}' });
  assert.deepStrictEqual(P.parseEnvInput('figure [h!]'), { name: 'figure', rest: '[h!]' });
  assert.deepStrictEqual(P.parseEnvInput('\\begin{tabular}{ll}'), { name: 'tabular', rest: '{ll}' });
  assert.strictEqual(P.parseEnvInput(''), null);
  assert.strictEqual(P.parseEnvInput('1abc'), null);
  assert.strictEqual(P.parseEnvInput('two words'), null);
  assert.strictEqual(P.parseEnvInput('\\begin{a b}'), null);
});

t('catalogue is sane', () => {
  const names = P.STANDARD_ENVS.map((e) => e.name);
  assert.strictEqual(new Set(names).size, names.length, 'duplicate names');
  for (const e of P.STANDARD_ENVS) assert.deepStrictEqual(P.parseEnvInput(e.name + e.rest), { name: e.name, rest: e.rest }, e.name);
});

t('envNamesInText', () => {
  const txt = '\\begin{document}\n\\begin{tblr}{ll}\n% \\begin{hidden}\n\\begin{problem} \\begin{tblr}\\end{tblr}\n100\\% \\begin{figure*}\n';
  assert.deepStrictEqual(P.envNamesInText(txt), ['tblr', 'problem', 'figure*']);
});

t('argsOfMacro', () => {
  const src = '\\newenvironment{one}{}{}\n\\newenvironment{two}[2]{}{}\n\\newenvironment{opt}[2][x]{}{}\n' +
    '\\NewDocumentEnvironment{xp}{O{a} m m}{}{}\n\\newtheorem{thm}{Теорема}\n';
  const envs = new Map(MP.scanMacros(src).filter((e) => e.kind === 'env').map((e) => [e.name, e]));
  assert.strictEqual(P.argsOfMacro(envs.get('one')), '');
  assert.strictEqual(P.argsOfMacro(envs.get('two')), '{}{}');
  assert.strictEqual(P.argsOfMacro(envs.get('opt')), '{}');
  assert.strictEqual(P.argsOfMacro(envs.get('xp')), '{}{}');
  assert.strictEqual(P.argsOfMacro(envs.get('thm')), '');
});

t('wrap whole lines, indentation kept, body indented', () => {
  const L = ['text', '  a', '    b', '', '  c', 'tail'];
  const e = W(L, [1, 2], [4, 3]);
  assert.deepStrictEqual(apply(L, e), ['text', '  \\begin{center}', '\t  a', '\t    b', '', '\t  c', '  \\end{center}', 'tail']);
  assert.deepStrictEqual(e.cursor, { line: 1, character: '  \\begin{center}'.length });
});

t('selection that ends at column 0 leaves the next line alone', () => {
  const L = ['a', 'b', 'c'];
  const e = W(L, [0, 0], [2, 0]);
  assert.deepStrictEqual(apply(L, e), ['\\begin{center}', '\ta', '\tb', '\\end{center}', 'c']);
});

t('selection inside a line splits it', () => {
  const L = ['Before WORD after'];
  const e = W(L, [0, 7], [0, 11], { name: 'quote' });
  assert.deepStrictEqual(apply(L, e), ['Before', '\\begin{quote}', '\tWORD', '\\end{quote}', 'after']);
  assert.deepStrictEqual(e.cursor, { line: 1, character: '\\begin{quote}'.length });
});

t('only the start or only the end is in the middle of a line', () => {
  const L = ['  one two', '  three four'];
  assert.deepStrictEqual(apply(L, W(L, [0, 6], [1, 12])), ['  one', '  \\begin{center}', '\t  two', '\t  three four', '  \\end{center}']);
  assert.deepStrictEqual(apply(L, W(L, [0, 0], [1, 7])), ['  \\begin{center}', '\t  one two', '\t  three', '  \\end{center}', '  four']);
});

t('verbatim and indent=false do not indent', () => {
  const L = ['  x = 1', '  y = 2'];
  assert.deepStrictEqual(apply(L, W(L, [0, 0], [1, 7], { name: 'verbatim' })), ['  \\begin{verbatim}', '  x = 1', '  y = 2', '  \\end{verbatim}']);
  assert.deepStrictEqual(apply(L, W(L, [0, 0], [1, 7], { indent: false })), ['  \\begin{center}', '  x = 1', '  y = 2', '  \\end{center}']);
  assert.deepStrictEqual(apply(['ab cd'], W(['ab cd'], [0, 3], [0, 5], { name: 'verbatim' })), ['ab', '\\begin{verbatim}', 'cd', '\\end{verbatim}']);
});

t('spaces as the indentation unit; arguments; caret in the first {}', () => {
  const L = ['x'];
  const e = W(L, [0, 0], [0, 1], { name: 'minipage', rest: '{}', unit: '    ' });
  assert.deepStrictEqual(apply(L, e), ['\\begin{minipage}{}', '    x', '\\end{minipage}']);
  assert.deepStrictEqual(e.cursor, { line: 0, character: '\\begin{minipage}{'.length });
  const f = W(L, [0, 0], [0, 1], { name: 'figure', rest: '[h!]' });
  assert.deepStrictEqual(f.cursor, { line: 0, character: '\\begin{figure}[h!]'.length });
  const g = W(['  x'], [0, 0], [0, 3], { name: 'tabularx', rest: '{\\linewidth}{}' });
  assert.deepStrictEqual(g.cursor, { line: 0, character: '  \\begin{tabularx}{\\linewidth}{'.length });
});

t('overlaps', () => {
  const L = ['a b', 'c', 'd'];
  const a = W(L, [0, 0], [0, 1]);
  const b = W(L, [0, 2], [0, 3]);
  const c = W(L, [2, 0], [2, 1]);
  assert.strictEqual(P.overlaps([a, b]), true);
  assert.strictEqual(P.overlaps([a, c]), false);
});

/* ---- wrapEnv.js with a stub of vscode ---- */
class Position { constructor(l, c) { this.line = l; this.character = c; } compareTo(o) { return this.line - o.line || this.character - o.character; } }
class Range { constructor(a, b, c, d) { if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } } }
class Selection extends Range { constructor(a, b, c, d) { super(a, b, c, d); this.isEmpty = this.start.compareTo(this.end) === 0; } }
class SnippetString { constructor() { this.v = ''; } appendText(s) { this.v += s; return this; } appendTabstop(n) { this.v += '$' + n; return this; } }

function makeVscode(text, selections, pickName, cfgValues) {
  const store = {};
  const doc = {
    eol: 1,
    getText: () => doc.lines.join('\n'),
    get lineCount() { return doc.lines.length; },
    lineAt: (i) => ({ text: doc.lines[i] }),
    lines: text.split('\n')
  };
  const ed = {
    document: doc, options: { insertSpaces: false, tabSize: 4 },
    selections: selections.map((s) => new Selection(s[0], s[1], s[2], s[3])), snippet: null, revealed: null,
    async edit(fn) {
      const reps = [];
      fn({ replace: (r, s) => reps.push([r, s]) });
      reps.sort((a, b) => b[0].start.line - a[0].start.line);
      for (const [r, s] of reps) doc.lines.splice(r.start.line, r.end.line - r.start.line + 1, ...s.split('\n'));
      return true;
    },
    async insertSnippet(s) { ed.snippet = s.v; return true; },
    revealRange(r) { ed.revealed = r; }
  };
  const handlers = {};
  const vs = {
    Position, Range, Selection, SnippetString,
    EndOfLine: { LF: 1, CRLF: 2 },
    QuickPickItemKind: { Separator: -1 },
    window: {
      activeTextEditor: ed, shown: null,
      createQuickPick() {
        const qp = { items: [], selectedItems: [], _v: [], _a: [], _h: [], show() { vs.window.shown = qp; setImmediate(() => { qp.selectedItems = [qp.items.find((i) => i.env && i.env.name === pickName.name) || qp.typedPick]; if (pickName.typed) { qp._v.forEach((f) => f(pickName.typed)); qp.selectedItems = [qp.items.find((i) => i.env)]; } qp._a.forEach((f) => f()); }); },
          onDidChangeValue(f) { qp._v.push(f); }, onDidAccept(f) { qp._a.push(f); }, onDidHide(f) { qp._h.push(f); }, dispose() {} };
        return qp;
      },
      showWarningMessage(m) { vs.warned = m; }, showInformationMessage() {}
    },
    workspace: { getConfiguration: () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d) }), workspaceFolders: [] },
    commands: { registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; } },
    languages: {}, Uri: { file: (f) => f }
  };
  return { vs, ed, doc, handlers, store };
}

(async () => {
  const origLoad = Module._load;
  const run = async (text, sels, pick, cfgValues) => {
    const h = makeVscode(text, sels, pick, cfgValues || {});
    Module._load = function (req, ...rest) {
      if (req === 'vscode') return h.vs;
      if (/\/macros$/.test(req) || req === './macros') return { _allMacros: async () => ({ cmds: new Map(), envs: new Map([['problem', { name: 'problem', kind: 'env', tokens: [{ t: 'm', open: '{', close: '}', optional: false }], file: '/p/C.cls', line: 3 }]]) }) };
      return origLoad.call(this, req, ...rest);
    };
    for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && /(wrapEnv|util)\.js$/.test(k)) delete require.cache[k];
    const mod = require(path.join(EXT, 'wrapEnv.js'));
    const mem = {};
    mod.register({ subscriptions: [], globalState: { get: (k) => mem[k], update: async (k, v) => { mem[k] = v; } } });
    await h.handlers['tssworkflow.wrapEnv']();
    Module._load = origLoad;
    return { h, mem };
  };

  let r = await run('a\nb\nc', [[0, 0, 1, 1]], { name: 'center' });
  assert.deepStrictEqual(r.h.doc.lines, ['\\begin{center}', '\ta', '\tb', '\\end{center}', 'c']);
  assert.deepStrictEqual(r.mem['tssworkflow.wrapEnv.recent'], [{ name: 'center', rest: '' }]);
  const labels = r.h.vs.window.shown.items.map((i) => (i.kind === -1 ? '--' + i.label : i.label));
  assert.ok(labels.indexOf('--Проєкт (.cls / .sty)') >= 0 && labels.indexOf('problem') > labels.indexOf('--Проєкт (.cls / .sty)'), 'project group');
  assert.ok(labels.indexOf('equation') > labels.indexOf('--Стандартні'), 'standard group');
  assert.strictEqual(r.h.vs.window.shown.items.find((i) => i.label === 'problem').env.rest, '{}');

  r = await run('a\nb', [[0, 0, 0, 0]], { name: 'minipage' });
  assert.strictEqual(r.h.ed.snippet, '\\begin{minipage}{0.48\\linewidth}\n\t$0\n\\end{minipage}', 'snippet without a field');
  r = await run('a\nb', [[0, 0, 0, 0]], { name: 'tabular' });
  assert.strictEqual(r.h.ed.snippet, '\\begin{tabular}{$1}\n\t$0\n\\end{tabular}', 'snippet with a field inside {}');

  r = await run('a b c', [[0, 0, 0, 1], [0, 2, 0, 3]], { name: 'center' });
  assert.ok(r.h.vs.warned && r.h.doc.lines.join('|') === 'a b c', 'overlapping selections are refused');

  r = await run('x\n\ny', [[0, 0, 0, 1], [2, 0, 2, 1]], { name: 'quote' });
  assert.deepStrictEqual(r.h.doc.lines, ['\\begin{quote}', '\tx', '\\end{quote}', '', '\\begin{quote}', '\ty', '\\end{quote}']);
  assert.deepStrictEqual(r.h.ed.selections.map((s) => s.start.line), [0, 4]);

  r = await run('x', [[0, 0, 0, 1]], { name: 'center' }, { 'wrapEnv.indent': false });
  assert.deepStrictEqual(r.h.doc.lines, ['\\begin{center}', 'x', '\\end{center}']);

  r = await run('x', [[0, 0, 0, 1]], { typed: 'minipage{0.3\\linewidth}' });
  assert.deepStrictEqual(r.h.doc.lines, ['\\begin{minipage}{0.3\\linewidth}', '\tx', '\\end{minipage}']);
  console.log('wrapEnv: ' + (n + 7) + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
