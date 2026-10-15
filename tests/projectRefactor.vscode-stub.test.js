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
class Uri { constructor(p, fragment) { this.fsPath = p; this.scheme = 'file'; this.fragment = fragment || ''; } static file(p) { return new Uri(p); } with(o) { return new Uri(this.fsPath, o.fragment); } toString() { return 'file://' + this.fsPath + (this.fragment ? '#' + this.fragment : ''); } }
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
let docSeq = 0;
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
// an untitled document that can be replaced as a whole (what "↻ Оновити звіт" does with a WorkspaceEdit)
const mkUntitled = (content) => {
  const id = 'untitled:Untitled-' + (++docSeq);
  const d = { content, uri: { toString: () => id, _doc: null }, isClosed: false, validateRange: (r) => r };
  d.setText = (t) => { const ls = t.split('\n'); d.content = t; d.lineCount = ls.length; d.lineAt = (i) => ({ text: ls[i] }); log.docs.at(-1).content = t; };
  d.uri._doc = d;
  d.setText(content);
  return d;
};
const orig = Module._load;
const treeItems = [];
const stub = {
  Uri, Range, WorkspaceEdit, DocumentLink, CodeLens,
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
    getConfiguration: () => ({ get: (k, d) => (k === 'mainFile' ? 'main.tex' : stub.conf && k in stub.conf ? stub.conf[k] : d) }),
    findFiles: async (pat) => {
      const base = typeof pat === 'string' ? proj : pat.base;
      const ext2 = typeof pat === 'string' ? /\.bib$/ : /\.(tex|tikz|cls|sty|bib)$/;
      return walk(base, []).filter((f) => ext2.test(f) && !f.includes('.archive')).map(Uri.file);
    },
    openTextDocument: async (a) => (a && a.content !== undefined ? (log.docs.push(a), mkUntitled(a.content)) : mkDoc(a.fsPath)),
    applyEdit: async (e) => {
      for (const op of e.ops) {
        if (op.uri && op.uri._doc) { op.uri._doc.setText(op.text); continue; }
        if (op.t === 'replace') fs.writeFileSync(op.uri.fsPath, op.text, 'utf8');
        else fs.renameSync(op.a.fsPath, op.b.fsPath);
      }
      return true;
    },
    saveAll: async () => true,
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidChange: () => ({}), onDidCreate: () => ({}), onDidDelete: () => ({}), dispose() {} })
  },
  window: {
    activeTextEditor: null,
    showInputBox: async (o) => { (log.inputs = log.inputs || []).push(o); const v = ans.input.shift(); if (v !== undefined && v !== null && o.validateInput) log.validation = o.validateInput(v); return v; },
    showQuickPick: async (items, o) => { const want = ans.pick.shift(); log.lastPick = { items, o }; return typeof want === 'function' ? want(items) : want; },
    showWarningMessage: async (m, ...b) => { log.warns.push(m); return ans.warn.shift(); },
    showInformationMessage: async (m, ...b) => { log.infos.push(m); return ans.info.shift(); },
    showTextDocument: async (d) => { stub._last = d; return d; },
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
    registerCodeLensProvider: (sel, prov) => { stub.lensProv = prov; stub.lensSel = sel; return { dispose() {} }; },
    registerDocumentLinkProvider: (sel, prov) => { stub.linkProv = prov; stub.linkSel = sel; return { dispose() {} }; },
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
    assert.deepStrictEqual(Object.keys(C).sort(), ['tssworkflow._refreshReport', 'tssworkflow.buildParts', 'tssworkflow.indexTerm', 'tssworkflow.makeSnapshot', 'tssworkflow.moveChapterDown', 'tssworkflow.moveChapterUp', 'tssworkflow.normalizeProject', 'tssworkflow.notationReport', 'tssworkflow.refreshProblems', 'tssworkflow.renameChapter', 'tssworkflow.replaceInProject', 'tssworkflow.restoreSnapshot', 'tssworkflow.termsReport']);
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

  await run('termsReport: used before defined; without the magic comment no index part; with it \\index is added after the definition', async () => {
    w('Charges/T1.tex', 'Тут вже є напруженість електричного поля.\nА \\emph{заряд} означено тут.\n');
    w('Magnet/T2.tex', 'Назвемо \\emph{напруженістю} векторну величину.\\index{заряд}\n');
    await C['tssworkflow.termsReport']();
    let md = log.docs.at(-1).content;
    assert.ok(md.includes('Вжито раніше, ніж означено') && md.includes('| напруженістю | Magnet/T2.tex:1 | Charges/T1.tex:1'), md);
    assert.ok(!md.includes('| заряд |'), 'a term used only after its definition is not reported');
    assert.ok(md.includes('Вимкнено') && md.includes('Записів `\\index` у проєкті: 1'), 'the index is off without the comment');
    assert.ok(!r('Magnet/T2.tex').includes('\\index{напруженістю}'), 'nothing is written without the comment');
    w('main.tex', '% !TEX indexprogram = upmendex\n' + MAIN);
    ans.warn = ['Додати'];
    const before = M._t.listSnapshots(proj).length;
    await C['tssworkflow.termsReport']();
    md = log.docs.at(-1).content;
    assert.ok(md.includes('Означені терміни без запису в покажчику') && md.includes('- напруженістю (Magnet/T2.tex:1)') && !md.includes('- заряд'), md);
    assert.strictEqual(r('Magnet/T2.tex'), 'Назвемо \\emph{напруженістю}\\index{напруженістю} векторну величину.\\index{заряд}\n');
    assert.strictEqual(M._t.listSnapshots(proj).length, before + 1, 'a snapshot before the change');
    ans.warn = [];
    await C['tssworkflow.termsReport']();
    assert.ok(log.docs.at(-1).content.includes('Немає: кожен означений термін є серед'), 'then every term has an entry');
    assert.strictEqual(log.warns.filter((m) => m.includes('Додати \\index')).length, 1, 'no second question');
    w('main.tex', MAIN);
  });

  await run('reports: path:line in the report is a link to the file at that line (only inside the project, only existing files)', async () => {
    assert.deepStrictEqual(stub.linkSel, { language: 'markdown', scheme: 'untitled' });
    w('Charges/T1.tex', 'Тут вже є напруженість електричного поля.\nА \\emph{заряд} означено тут.\n');
    w('Magnet/T2.tex', 'Назвемо \\emph{напруженістю} векторну величину.\n');
    await C['tssworkflow.termsReport']();
    const doc = stub._last;
    const links = stub.linkProv.provideDocumentLinks(doc);
    const targets = links.map((l) => path.relative(proj, l.target.fsPath).split(path.sep).join('/') + '#' + l.target.fragment);
    assert.ok(targets.includes('Magnet/T2.tex#L1') && targets.includes('Charges/T1.tex#L1'), targets.join(', '));
    const row = doc.lineAt(links[0].range.start.line).text;
    assert.strictEqual(row.slice(links[0].range.start.character, links[0].range.end.character), 'Magnet/T2.tex:1');
    assert.deepStrictEqual(stub.linkProv.provideDocumentLinks({ uri: { toString: () => 'untitled:other' }, lineCount: 1, lineAt: () => ({ text: 'Magnet/T2.tex:1' }) }), [], 'a document that is not a report has no links');
    const fake = { uri: doc.uri, lineCount: 2, lineAt: (i) => ({ text: ['../outside.tex:1', 'Magnet/missing.tex:2'][i] }) };
    assert.deepStrictEqual(stub.linkProv.provideDocumentLinks(fake), [], 'outside the project or missing: no link');
  });

  await run('reports: the list of matches of «Replace in project» has links too; each report keeps its own project; «Notation» lists places too', async () => {
    const REP = 'початок\n\\zzz x\nщось\n\\zzz y\n';
    w('Rep/Rep.tex', REP);
    await C['tssworkflow.termsReport']();
    const terms = stub._last;
    const termsBefore = stub.linkProv.provideDocumentLinks(terms).length;
    assert.ok(termsBefore > 0);
    ans.input = ['\\zzz', '\\yyy'];
    ans.pick = [(items) => items.filter((i) => i.picked)];
    ans.warn = ['Показати список'];
    ans.info = [undefined]; // do not replace after looking at the list
    await C['tssworkflow.replaceInProject']();
    const rep = stub._last;
    assert.notStrictEqual(rep, terms, 'a new document');
    assert.strictEqual(r('Rep/Rep.tex'), REP, 'nothing replaced');
    const links = stub.linkProv.provideDocumentLinks(rep);
    assert.deepStrictEqual(links.map((l) => path.relative(proj, l.target.fsPath).split(path.sep).join('/') + '#' + l.target.fragment), ['Rep/Rep.tex#L2', 'Rep/Rep.tex#L4']);
    assert.deepStrictEqual(links.map((l) => rep.lineAt(l.range.start.line).text.slice(l.range.start.character, l.range.end.character)), ['Rep/Rep.tex:2', 'Rep/Rep.tex:4'], 'the link covers exactly path:line; the \"Rep/Rep.tex (2)\" summary line has none');
    assert.ok(links[0].tooltip.includes('Rep/Rep.tex') && links[0].tooltip.includes('рядок 2'), links[0].tooltip);
    assert.strictEqual(stub.linkProv.provideDocumentLinks(terms).length, termsBefore, 'the first report still has its links');
    ans.pick = [undefined];
    await C['tssworkflow.notationReport']();
    const nrep = stub._last;
    const nlinks = stub.linkProv.provideDocumentLinks(nrep);
    assert.ok(nlinks.length > 0, 'the notation report names places ("напр. файл:рядок"): they are links');
    for (const l of nlinks) assert.ok(/^[^ ]+\.tex:\d+$/.test(nrep.lineAt(l.range.start.line).text.slice(l.range.start.character, l.range.end.character)));
    const colDoc = { uri: terms.uri, lineCount: 2, lineAt: (i) => ({ text: ['див. Magnet/T2.tex:1:7, далі', 'Magnet/T2.tex:1:'][i] }) };
    const cl = stub.linkProv.provideDocumentLinks(colDoc);
    assert.deepStrictEqual(cl.map((l) => l.target.fragment), ['L1,7', 'L1'], 'the column goes into the fragment (L1,7)');
    assert.strictEqual(colDoc.lineAt(0).text.slice(cl[0].range.start.character, cl[0].range.end.character), 'Magnet/T2.tex:1:7', 'and into the link');
    assert.ok(cl[0].tooltip.includes('рядок 1') && cl[0].tooltip.includes('стовпець 7'), cl[0].tooltip);
    const sib = path.join(tmp, 'proj-other', 'x.tex');
    fs.mkdirSync(path.dirname(sib), { recursive: true });
    fs.writeFileSync(sib, 'x\n', 'utf8');
    const fake = { uri: terms.uri, lineCount: 1, lineAt: () => ({ text: '../proj-other/x.tex:1' }) };
    assert.deepStrictEqual(stub.linkProv.provideDocumentLinks(fake), [], 'a sibling folder with the same beginning of the name is outside the project');
    fs.rmSync(path.join(proj, 'Rep'), { recursive: true, force: true });
    assert.strictEqual(stub.linkProv.provideDocumentLinks(rep).length, 0, 'the file is gone: no link');
  });

  await run('snapshots: two snapshots with the same label in one second are two snapshots (the id used to be the same and the second overwrote the first)', async () => {
    const n = M._t.listSnapshots(proj).length;
    const RealDate = Date, T0 = RealDate.now();
    global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [T0])); } static now() { return T0; } }; // the same second, for sure
    let first, all;
    try {
      await M._t.takeSnapshot(proj, 'same label');
      first = M._t.listSnapshots(proj).length;
      w('Snap/S.tex', 'one\n');
      await M._t.takeSnapshot(proj, 'same label');
      all = M._t.listSnapshots(proj);
    } finally { global.Date = RealDate; }
    assert.strictEqual(first, n + 1);
    assert.strictEqual(all.length, n + 2, 'both are kept');
    const ids = all.map((m) => m.id).filter((id) => id.includes('same-label'));
    assert.strictEqual(new Set(ids).size, 2, ids.join(', '));
    assert.ok(ids.some((id) => /-2$/.test(id)), 'the second one is numbered');
    fs.rmSync(path.join(proj, 'Snap'), { recursive: true, force: true });
  });

  await run('Terms: «Уточнити форми…» asks for the entry of every term (the written form is the default); empty skips a term, Esc cancels everything', async () => {
    const IDX = '% !TEX indexprogram = upmendex\n' + MAIN;
    w('main.tex', IDX);
    w('Charges/T1.tex', 'Тут \\emph{заряд}\\index{заряд} означено.\n'); // the terms of the earlier tests have their entries
    w('Magnet/T2.tex', 'Назвемо \\emph{напруженістю}\\index{напруженість} величину.\n');
    const FORMS = 'Тут \\emph{потоком} і \\emph{струмами} означено.\n';
    w('Forms/Forms.tex', FORMS);
    ans.warn = ['Уточнити форми…'];
    ans.input = ['потік', ''];
    const before = M._t.listSnapshots(proj).length, n0 = (log.inputs || []).length;
    await C['tssworkflow.termsReport']();
    const asked = log.inputs.slice(n0);
    assert.strictEqual(asked.length, 2, 'one question per term without an entry: ' + JSON.stringify(asked.map((o) => o.value)));
    assert.deepStrictEqual(asked.map((o) => o.value), ['потоком', 'струмами'], 'the written form is offered');
    assert.ok(asked[0].prompt.includes('Forms/Forms.tex:1') && asked[0].prompt.includes('Esc') && asked[0].ignoreFocusOut, asked[0].prompt);
    assert.strictEqual(r('Forms/Forms.tex'), 'Тут \\emph{потоком}\\index{потік} і \\emph{струмами} означено.\n', 'the typed form is written, the term with an empty answer is skipped');
    assert.strictEqual(M._t.listSnapshots(proj).length, before + 1);
    assert.ok(log.infos.at(-1).includes('Додано \\index до 1 термінів'), log.infos.at(-1));
    // Esc on a question: nothing is written, no snapshot
    const snaps = M._t.listSnapshots(proj).length;
    ans.warn = ['Уточнити форми…'];
    ans.input = [undefined];
    await C['tssworkflow.termsReport']();
    assert.strictEqual(r('Forms/Forms.tex'), 'Тут \\emph{потоком}\\index{потік} і \\emph{струмами} означено.\n');
    // Esc on the second question cancels the answer to the first too
    ans.warn = ['Уточнити форми…'];
    ans.input = ['дослівно', undefined];
    await C['tssworkflow.termsReport']();
    assert.ok(!r('Forms/Forms.tex').includes('дослівно'), 'nothing of a cancelled series is written');
    assert.strictEqual(M._t.listSnapshots(proj).length, snaps, 'cancelled: no snapshot');
    // without the setting the entry \index{потік} does not cover \emph{потоком} (the vowel of the stem changes): two terms are still asked about
    ans.warn = ['Уточнити форми…'];
    ans.input = ['', ''];
    const w0 = log.warns.length;
    await C['tssworkflow.termsReport']();
    assert.ok(log.warns[w0].includes('2 термінів'), log.warns[w0]);
    assert.ok(log.infos.at(-1).includes('Жодного запису не додано'), log.infos.at(-1));
    // the setting termsForms joins the forms: потоком is covered, one term is left
    stub.conf = { termsForms: [['потік', 'потоку', 'потоком']] };
    ans.warn = [undefined];
    const w1 = log.warns.length;
    await C['tssworkflow.termsReport']();
    assert.ok(log.warns[w1].includes('1 термінів'), log.warns[w1]);
    assert.ok(!/Означені терміни без запису в покажчику[\s\S]*потоком/.test(stub._last.content), 'the report does not list it either');
    stub.conf = null;
    // «Додати» is still the written form for all of them
    ans.warn = ['Додати'];
    await C['tssworkflow.termsReport']();
    assert.ok(r('Forms/Forms.tex').includes('\\emph{струмами}\\index{струмами}'));
    w('main.tex', MAIN);
    fs.rmSync(path.join(proj, 'Forms'), { recursive: true, force: true });
  });

  await run('reports: «↻ Оновити звіт» is a lens above the first line of a report that can be built again; it rewrites the same document and the links follow', async () => {
    assert.deepStrictEqual(stub.lensSel, { language: 'markdown', scheme: 'untitled' });
    assert.deepStrictEqual(stub.lensProv.provideCodeLenses({ uri: { toString: () => 'untitled:other' } }), [], 'not a report: no lens');
    const REP = 'початок\n\\zzz x\n';
    w('Rep/Rep.tex', REP);
    ans.input = ['\\zzz', '\\yyy'];
    ans.pick = [(items) => items.filter((i) => i.picked)];
    ans.warn = ['Показати список'];
    ans.info = [undefined];
    await C['tssworkflow.replaceInProject']();
    const doc = stub._last;
    const lens = stub.lensProv.provideCodeLenses(doc);
    assert.strictEqual(lens.length, 1);
    assert.deepStrictEqual([lens[0].range.start.line, lens[0].command.title, lens[0].command.command, lens[0].command.arguments], [0, '↻ Оновити звіт', 'tssworkflow._refreshReport', [doc.uri.toString()]]);
    assert.strictEqual(stub.linkProv.provideDocumentLinks(doc).length, 1);
    w('Rep/Rep.tex', REP + 'ще\n\\zzz y\n');
    await C['tssworkflow._refreshReport'](doc.uri.toString());
    assert.ok(doc.content.includes('Rep/Rep.tex:4') && doc.content.includes('Rep/Rep.tex (2)'), doc.content);
    assert.deepStrictEqual(stub.linkProv.provideDocumentLinks(doc).map((l) => l.target.fragment), ['L2', 'L4'], 'the links are computed from the new text');
    assert.ok(log.status.at(-1).includes('оновлено'));
    assert.strictEqual(stub.lensProv.provideCodeLenses(doc).length, 1, 'still a report after the refresh');
    // the pattern is gone from the project: the report says so and still has its lens
    w('Rep/Rep.tex', 'нічого\n');
    await C['tssworkflow._refreshReport'](doc.uri.toString());
    assert.ok(doc.content.includes('Збігів не знайдено'), doc.content);
    assert.strictEqual(stub.linkProv.provideDocumentLinks(doc).length, 0);
    // other reports are built again by their own command: Terms and Notation have a lens too
    await C['tssworkflow.termsReport']();
    assert.strictEqual(stub.lensProv.provideCodeLenses(stub._last).length, 1);
    const terms = stub._last;
    const old = terms.content;
    w('Charges/T3.tex', 'Назвемо \\emph{опором} величину.\n');
    await C['tssworkflow._refreshReport'](terms.uri.toString());
    const count = (t) => +/Означених термінів: (\d+)/.exec(t)[1];
    assert.strictEqual(count(terms.content), count(old) + 1, 'the new term is counted after the refresh');
    ans.pick = [undefined];
    await C['tssworkflow.notationReport']();
    assert.strictEqual(stub.lensProv.provideCodeLenses(stub._last).length, 1);
    fs.rmSync(path.join(proj, 'Rep'), { recursive: true, force: true });
    fs.rmSync(path.join(proj, 'Charges', 'T3.tex'), { force: true });
    // an unknown or already closed report is ignored
    await C['tssworkflow._refreshReport']('untitled:nothing');
    doc.isClosed = true;
    const keep = doc.content;
    await C['tssworkflow._refreshReport'](doc.uri.toString());
    assert.strictEqual(doc.content, keep, 'a closed document is not touched');
  });

  await run('indexTerm: \\index after the selection or the word under the cursor, hint without the magic comment', async () => {
    const line = 'Електричне поле створює заряд.';
    const edits = [];
    const mkEd = (sels) => ({
      document: { languageId: 'latex', getText: (rg) => line.slice(rg.start.character, rg.end.character), getWordRangeAtPosition: (p) => { const m = /[\p{L}]+/gu; let x; while ((x = m.exec(line))) if (x.index <= p.character && p.character <= x.index + x[0].length) return new Range(0, x.index, 0, x.index + x[0].length); return undefined; } },
      selections: sels,
      edit: async (fn) => { fn({ replace: (rg, t) => edits.push([rg.start.character, rg.end.character, t]) }); return true; }
    });
    const S = (a, b) => ({ isEmpty: a === b, active: { line: 0, character: b }, start: { line: 0, character: a }, end: { line: 0, character: b } });
    stub.window.activeTextEditor = mkEd([S(0, 15)]);
    await C['tssworkflow.indexTerm']();
    assert.deepStrictEqual(edits, [[15, 15, '\\index{Електричне поле}']], 'the selection');
    assert.ok(log.status.at(-1).includes('indexprogram'), 'no magic comment: the index will not be built');
    edits.length = 0;
    stub.window.activeTextEditor = mkEd([S(25, 25)]);
    await C['tssworkflow.indexTerm']();
    assert.deepStrictEqual(edits, [[29, 29, '\\index{заряд}']], 'the word under the cursor');
    edits.length = 0;
    stub.window.activeTextEditor = mkEd([S(30, 30)]);
    await C['tssworkflow.indexTerm']();
    assert.deepStrictEqual(edits, [], 'nothing under the cursor');
    stub.window.activeTextEditor = null;
  });

  console.log('\nprojectRefactor stub end-to-end: all ok');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
