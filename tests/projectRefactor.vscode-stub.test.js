'use strict';
// node tests/projectRefactor.vscode-stub.test.js [path/to/extension]  - projectRefactor.js end to end on a real temp folder with a vscode stub
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss3-'));
const proj = path.join(tmp, 'proj');
const store = path.join(tmp, 'store');
const w = (rel, text) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, 'utf8'); };
const r = (rel) => fs.readFileSync(path.join(proj, rel), 'utf8');
const MAIN = '\\begin{document}\n\\part{A}\n\\multiinclude{Charges, Field}[]\n\\part{B}\n\\includechapter{Magnet}\n\\end{document}\n';
w('main.tex', MAIN);
w('Charges/Charges.tex', '\\chapter{Заряди}\\label{\\currfilebase}\n\\vect a $\\epsilon$ \\vect b');
w('Charges/tikz/f.tikz', 'x');
w('Field/Field.tex', 'див. \\ref{Charges} \\vec c $\\varepsilon$ \\varepsilon');
w('Magnet/Magnet.tex', 'M \\input{Charges/Charges}');
w('refs.bib', '@book{landau,\n author={Landau, L. and Lifshitz, E.},\n title={Fields},\n year=1960\n}\n');

const ans = { input: [], pick: [], warn: [], info: [] };
const log = { infos: [], warns: [], cmds: [], status: [], docs: [] };
class Uri { constructor(p) { this.fsPath = p; this.scheme = 'file'; } static file(p) { return new Uri(p); } }
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
class WorkspaceEdit {
  constructor() { this.ops = []; }
  replace(uri, range, text) { this.ops.push({ t: 'replace', uri, range, text }); }
  renameFile(a, b) { this.ops.push({ t: 'rename', a, b }); }
}
const walk = (dir, out) => { for (const n of fs.readdirSync(dir)) { const f = path.join(dir, n); if (fs.statSync(f).isDirectory()) walk(f, out); else out.push(f); } return out; };
const mkDoc = (fsPath) => {
  const text = fs.readFileSync(fsPath, 'utf8');
  const lines = text.split('\n');
  return { uri: Uri.file(fsPath), fileName: fsPath, isDirty: false, lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }), getText: () => text, save: async () => true };
};
const orig = Module._load;
const treeItems = [];
const stub = {
  Uri, Range, WorkspaceEdit,
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(l, s) { this.label = l; this.collapsibleState = s; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: Object.assign(class { constructor(id) { this.id = id; } }, { File: { id: 'file' } }),
  MarkdownString: class { constructor() { this.v = ''; } appendMarkdown(s) { this.v += s; } },
  Hover: class { constructor(c, r2) { this.contents = c; this.range = r2; } },
  CompletionItem: class { constructor(l, k) { this.label = l; this.kind = k; } },
  CompletionItemKind: { Reference: 17 },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(proj) }],
    getWorkspaceFolder: () => ({ uri: Uri.file(proj) }),
    textDocuments: [],
    getConfiguration: () => ({ get: (k, d) => (k === 'mainFile' ? 'main.tex' : d) }),
    findFiles: async (pat) => {
      const base = typeof pat === 'string' ? proj : pat.base;
      const ext2 = typeof pat === 'string' ? /\.bib$/ : /\.(tex|tikz|cls|sty|bib)$/;
      return walk(base, []).filter((f) => ext2.test(f) && !f.includes('.archive')).map(Uri.file);
    },
    openTextDocument: async (a) => (a && a.content !== undefined ? (log.docs.push(a), { content: a.content }) : mkDoc(a.fsPath)),
    applyEdit: async (e) => {
      for (const op of e.ops) {
        if (op.t === 'replace') fs.writeFileSync(op.uri.fsPath, op.text, 'utf8');
        else fs.renameSync(op.a.fsPath, op.b.fsPath);
      }
      return true;
    },
    saveAll: async () => true,
    onDidSaveTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidChange: () => ({}), onDidCreate: () => ({}), onDidDelete: () => ({}), dispose() {} })
  },
  window: {
    activeTextEditor: null,
    showInputBox: async (o) => { const v = ans.input.shift(); if (v !== undefined && v !== null && o.validateInput) log.validation = o.validateInput(v); return v; },
    showQuickPick: async (items, o) => { const want = ans.pick.shift(); log.lastPick = { items, o }; return typeof want === 'function' ? want(items) : want; },
    showWarningMessage: async (m, ...b) => { log.warns.push(m); return ans.warn.shift(); },
    showInformationMessage: async (m, ...b) => { log.infos.push(m); return ans.info.shift(); },
    showTextDocument: async (d) => d,
    setStatusBarMessage: (m) => { log.status.push(m); },
    createTreeView: (id) => { stub.view = { id }; return { dispose() {} }; }
  },
  commands: {
    registerCommand: (id, fn) => { stub._cmds[id] = fn; return { dispose() {} }; },
    executeCommand: async (...a) => { log.cmds.push(a); }
  },
  languages: {
    onDidChangeDiagnostics: () => ({ dispose() {} }),
    registerCompletionItemProvider: () => ({ dispose() {} }),
    registerHoverProvider: () => ({ dispose() {} }),
    getDiagnostics: () => stub._diags
  },
  _cmds: {}, _diags: []
};
Module._load = function (rq, ...a) { return rq === 'vscode' ? stub : orig.call(this, rq, ...a); };
const M = require(path.join(ext, 'projectRefactor.js'));
M.register({ subscriptions: [], globalStorageUri: { fsPath: store } }, { frameSettings: () => null });
const C = stub._cmds;
const run = async (name, fn) => { await fn(); console.log('ok  ' + name); };

(async () => {
  await run('commands are registered', async () => {
    assert.deepStrictEqual(Object.keys(C).sort(), ['tssworkflow.buildParts', 'tssworkflow.makeSnapshot', 'tssworkflow.moveChapterDown', 'tssworkflow.moveChapterUp', 'tssworkflow.normalizeProject', 'tssworkflow.notationReport', 'tssworkflow.refreshProblems', 'tssworkflow.renameChapter', 'tssworkflow.replaceInProject', 'tssworkflow.restoreSnapshot']);
    assert.strictEqual(stub.view.id, 'tssworkflow.problemsView');
  });

  await run('moveChapterDown / Up swaps names in the main file', async () => {
    await C['tssworkflow.moveChapterDown']({ kind: 'chapter', name: 'Charges' });
    assert.ok(r('main.tex').includes('\\multiinclude{Field, Charges}[]'));
    await C['tssworkflow.moveChapterUp']({ kind: 'chapter', name: 'Charges' });
    assert.strictEqual(r('main.tex'), MAIN);
    await C['tssworkflow.moveChapterUp']({ kind: 'chapter', name: 'Charges' });
    assert.ok(log.infos.at(-1).includes('уже перший'));
  });

  await run('renameChapter: folder, file, lists, paths, refs, snapshot; restore brings everything back', async () => {
    ans.input = ['Electro'];
    ans.warn = ['Перейменувати'];
    await C['tssworkflow.renameChapter']({ kind: 'chapter', name: 'Charges' });
    assert.ok(fs.existsSync(path.join(proj, 'Electro', 'Electro.tex')) && !fs.existsSync(path.join(proj, 'Charges')));
    assert.ok(fs.existsSync(path.join(proj, 'Electro', 'tikz', 'f.tikz')));
    assert.ok(r('main.tex').includes('\\multiinclude{Electro, Field}[]'));
    assert.ok(r('Field/Field.tex').includes('\\ref{Electro}'));
    assert.ok(r('Magnet/Magnet.tex').includes('\\input{Electro/Electro}'));
    assert.ok(log.infos.at(-1).includes('Charges → Electro'));
    const snaps = M._t.listSnapshots(proj);
    assert.strictEqual(snaps.length, 1);
    assert.deepStrictEqual(snaps[0].moves.map((m) => m.to), ['Electro', 'Electro/Electro.tex']);
    ans.pick = [(items) => items[0]];
    ans.warn = ['Відновити'];
    await C['tssworkflow.restoreSnapshot']();
    assert.ok(fs.existsSync(path.join(proj, 'Charges', 'Charges.tex')) && !fs.existsSync(path.join(proj, 'Electro')));
    assert.strictEqual(r('main.tex'), MAIN);
    assert.ok(r('Field/Field.tex').includes('\\ref{Charges}'));
    assert.ok(M._t.listSnapshots(proj).length >= 2, 'the state before restoring is a snapshot too');
  });

  await run('renameChapter: invalid and existing names are rejected by validation', async () => {
    ans.input = ['Bad name'];
    await C['tssworkflow.renameChapter']({ kind: 'chapter', name: 'Field' });
    assert.ok(/латинські/.test(log.validation));
    ans.input = ['Magnet'];
    await C['tssworkflow.renameChapter']({ kind: 'chapter', name: 'Field' });
    assert.ok(/уже є/.test(log.validation));
    assert.ok(fs.existsSync(path.join(proj, 'Field', 'Field.tex')));
  });

  await run('replaceInProject: replaces in code only, takes a snapshot', async () => {
    const before = M._t.listSnapshots(proj).length;
    ans.input = ['\\vect', '\\vec'];
    ans.pick = [(items) => items.filter((i) => i.picked)];
    ans.warn = ['Замінити'];
    await C['tssworkflow.replaceInProject']();
    assert.strictEqual(r('Charges/Charges.tex').split('\n')[1], '\\vec a $\\epsilon$ \\vec b');
    assert.strictEqual(M._t.listSnapshots(proj).length, before + 1);
    assert.ok(log.infos.at(-1).includes('Замінено 2'));
  });

  await run('notationReport: report is opened, unify makes \\epsilon -> \\varepsilon', async () => {
    ans.pick = [(items) => items.find((i) => i.label.startsWith('ε')), (items) => items.find((i) => i.label === '\\varepsilon')];
    ans.warn = ['Замінити'];
    await C['tssworkflow.notationReport']();
    assert.ok(log.docs.at(-1).content.includes('⚠️ ε'));
    assert.ok(r('Charges/Charges.tex').includes('$\\varepsilon$') && !r('Charges/Charges.tex').includes('\\epsilon'));
  });

  await run('normalizeProject: nothing to do on clean text, otherwise confirms', async () => {
    await C['tssworkflow.normalizeProject']();
    assert.ok(log.infos.at(-1).startsWith('Нормалізація проєкту') || log.warns.at(-1).includes('Нормалізувати'));
  });

  await run('buildParts: writes main-parts.tex with the chosen part and asks to compile it', async () => {
    ans.pick = [(items) => items.filter((i) => i.label === 'B')];
    await C['tssworkflow.buildParts']();
    const t = r('main-parts.tex');
    assert.ok(t.includes('\\includechapter{Magnet}') && !t.includes('Charges') && !t.includes('\\part{A}'));
    assert.strictEqual(t.split('\n').length, MAIN.split('\n').length);
    assert.deepStrictEqual(log.cmds.at(-1), ['tssworkflow._compileFile', { file: 'main-parts.tex', openPdf: true }]);
  });

  await run('cite completion and hover from the .bib file', async () => {
    const doc = { lineAt: () => ({ text: 'див. \\cite{lan' }), uri: Uri.file(path.join(proj, 'x.tex')) };
    const items = await M._t.citeCompletion.provideCompletionItems(doc, { line: 0, character: 14 });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].label.label, 'landau');
    assert.strictEqual(items[0].label.description, 'Landau, Lifshitz 1960');
    assert.strictEqual(items[0].detail, 'Fields');
    assert.ok(/landau/.test(items[0].filterText) && /Lifshitz/.test(items[0].filterText));
    const none = await M._t.citeCompletion.provideCompletionItems({ lineAt: () => ({ text: 'текст { ' }) }, { line: 0, character: 6 });
    assert.strictEqual(none, undefined);
    const h = await M._t.citeHover.provideHover({ lineAt: () => ({ text: 'див. \\cite{landau}' }) }, { line: 0, character: 13 });
    assert.ok(h.contents.v.includes('**landau**') && h.contents.v.includes('*Fields*') && h.contents.v.includes('(1960)'));
    assert.strictEqual(await M._t.citeHover.provideHover({ lineAt: () => ({ text: 'див. \\cite{landau}' }) }, { line: 0, character: 2 }), undefined);
  });

  await run('problems panel: groups, files, badge, empty message', async () => {
    const mk = (f, line, sev, msg, src) => [Uri.file(path.join(proj, f)), [{ range: { start: { line } }, severity: sev, message: msg, source: src }]];
    stub._diags = [mk('main.tex', 3, 0, 'Undefined control sequence', 'LaTeX log'), mk('Field/Field.tex', 1, 1, 'Overfull \\hbox (2pt)', 'LaTeX log'),
      mk('Field/Field.tex', 5, 1, 'Мітка не визначена', 'TSS Workflow'), [Uri.file(path.join(proj, 'main.tex')), [{ range: { start: { line: 0 } }, severity: 0, message: 'other', source: 'ltex' }]]];
    const p = new M._t.ProblemsProvider();
    p.view = {};
    const top = p.getChildren();
    assert.deepStrictEqual(top.map((x) => x.item.label), ['Помилки (1)', 'Попередження (1)', 'Overfull / underfull (1)']);
    const file = p.getChildren(top[0])[0];
    assert.strictEqual(p.getTreeItem(file).label, 'main.tex');
    const leaf = p.getChildren(file)[0].item;
    assert.strictEqual(leaf.label, '4: Undefined control sequence');
    assert.strictEqual(leaf.command.command, 'vscode.open');
    assert.deepStrictEqual(p.view.badge, { value: 3, tooltip: 'Помилок і попереджень: 3' });
    stub._diags = [];
    assert.deepStrictEqual(p.getChildren(), []);
    assert.ok(/немає/.test(p.view.message));
  });

  console.log('\nprojectRefactor stub end-to-end: all ok');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
