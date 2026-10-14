'use strict';
// node tests/projectIndex.vscode-stub.test.js [path/to/extension]
// util.js caches (open documents by a Map, lists of files until the watcher reports a change), projectIndex.js (per-file cache,
// diagnostics by diff), labels.js / settingsCitations.js on top of them, the lazy labels panel, the pure label index.
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-pi-'));

/* ------------------------------- the stub ------------------------------- */
const handler = { get: (t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const events = {};
const ev = (name) => (fn) => { (events[name] = events[name] || []).push(fn); return { dispose() {} }; };
const fire = (name, arg) => (events[name] || []).forEach((f) => f(arg));
const state = { docs: [], findCalls: [], files: {} };
const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }) };
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
const colls = {};
const cfgv = {};
const cfg = { get: (k, d) => (k in cfgv ? cfgv[k] : d), update: async () => {}, has: () => false, inspect: () => ({}) };
const vscode = mk({
  Uri, Range, Diagnostic, EventEmitter,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  languages: mk({
    createDiagnosticCollection: (name) => {
      const c = { name, sets: [], deletes: [], clears: 0, set(u, d) { this.sets.push([u.fsPath, d]); }, delete(u) { this.deletes.push(u.fsPath); }, clear() { this.clears++; }, dispose() {} };
      colls[name] = c;
      return c;
    }
  }),
  workspace: mk({
    get textDocuments() { return state.docs; },
    findFiles: async (glob, ex) => { state.findCalls.push([glob, String(ex)]); return (state.files[glob] || []).map(Uri.file); },
    createFileSystemWatcher: () => ({ onDidCreate: ev('create'), onDidDelete: ev('delete'), dispose() {} }),
    onDidOpenTextDocument: ev('open'),
    onDidCloseTextDocument: ev('close'),
    workspaceFolders: [{ uri: Uri.file(tmp) }],
    getWorkspaceFolder: () => ({ uri: Uri.file(tmp) }),
    getConfiguration: () => cfg
  }),
  window: mk({ activeTextEditor: undefined })
});
const load = Module._load;
Module._load = function (req, ...a) { return req === 'vscode' ? vscode : load.call(this, req, ...a); };
const req = (f) => require(path.join(ext, f));

/* ------------------------------ helpers ------------------------------ */
let tick = 0;
function write(p, text) { fs.writeFileSync(p, text); const d = new Date(1e12 + (++tick) * 5000); fs.utimesSync(p, d, d); }
const f = (n) => path.join(tmp, n);
const doc = (p, version, text, scheme) => ({ uri: Object.assign(Uri.file(p), { scheme: scheme || 'file' }), version, getText: () => text, lineCount: text.split('\n').length });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const TEX = '**/*.{tex,tikz}';

/* ------------------------------ pure parts ------------------------------ */
t('syntaxDelay: 700 ms up to 3000 lines, then longer, at most 2000 ms', () => {
  const P = req('corePure.js');
  assert.deepStrictEqual([0, 100, 3000, 3500, 8000, 9500, 100000].map(P.syntaxDelay), [700, 700, 700, 800, 1700, 2000, 2000]);
  assert.strictEqual(P.syntaxDelay(undefined), 700);
});

t('buildLabelIndex on labelFileData / combineLabelIndex gives the old result (reference implementation inside)', () => {
  const X = req('filesAndLabelsPure.js');
  const reference = (files) => {
    const refs = new Map();
    for (const x of files) X.scanRefs(x.lines, refs);
    const groups = []; let total = 0; let unused = 0;
    for (const x of files) {
      const labels = X.scanLabels(x.lines).map((l) => Object.assign(l, { uses: refs.get(l.name) || 0, kind: X.labelKind(l.name) }));
      if (!labels.length) continue;
      total += labels.length; unused += labels.filter((l) => !l.uses).length; groups.push({ path: x.path, labels });
    }
    return { groups, total, unused };
  };
  const files = [
    { path: 'a.tex', lines: ['\\section{A}\\label{sec:a}', 'see \\ref{eq:b}, \\cref{eq:b,pic:z}', '% \\label{commented}', '\\label{eq:a}'] },
    { path: 'b/b.tex', lines: ['\\begin{equation}\\label{eq:b}', 'x', '\\end{equation}', '\\hyperref[sec:a]{go}', '\\label{ pic:z }'] },
    { path: 'c.tex', lines: ['no labels here', '\\eqref{eq:a}'] }
  ];
  const want = reference(files.map((x) => ({ path: x.path, lines: x.lines })));
  assert.deepStrictEqual(X.buildLabelIndex(files), want);
  // the cached data is not modified by combining it
  const items = files.map((x) => Object.assign({ path: x.path }, X.labelFileData(x.lines, true)));
  const snap = JSON.stringify(items.map((i) => [i.labels, [...i.refs]]));
  const r1 = X.combineLabelIndex(items);
  r1.groups[0].labels[0].uses = 999;
  assert.strictEqual(JSON.stringify(items.map((i) => [i.labels, [...i.refs]])), snap, 'combine must copy the labels');
  assert.strictEqual(X.combineLabelIndex(items).groups[0].labels[0].uses, want.groups[0].labels[0].uses);
  assert.ok(items[0].labels.every((l) => typeof l.ctx === 'string'), 'ctx is filled with withCtx');
});

/* ------------------------------ util caches ------------------------------ */
t('docLines: one getText split (CRLF, CR, LF); falls back to lineAt without getText', () => {
  const U = req('util.js');
  assert.deepStrictEqual(U.docLines({ getText: () => 'a\r\nb\nc\rd' }), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(U.docLines({ lineCount: 2, lineAt: (i) => ({ text: 'x' + i }) }), ['x0', 'x1']);
  assert.deepStrictEqual(U.docLines({ getText: () => '' }), ['']);
});

t('without initCaches every findCached call goes to findFiles, and openDocByPath searches textDocuments', async () => {
  const U = req('util.js');
  assert.strictEqual(U.cachingOn(), false);
  state.files[TEX] = [f('a.tex')];
  state.findCalls.length = 0;
  await U.findCached(TEX, 3000); await U.findCached(TEX, 3000);
  assert.strictEqual(state.findCalls.length, 2);
  state.docs = [doc(f('a.tex'), 1, 'X')];
  assert.strictEqual(U.openDocByPath(f('a.tex')), state.docs[0]);
  state.docs = [];
});

t('initCaches: file lists are cached, copies are independent, create/delete events and another exclude refetch', async () => {
  const U = req('util.js');
  assert.strictEqual(U.initCaches({ subscriptions: [] }), true);
  assert.strictEqual(U.cachingOn(), true);
  state.findCalls.length = 0;
  const a = await U.texFiles();
  a.push('junk');                         // callers (labels.js rename) push into the array
  const b = await U.texFiles();
  await U.texFiles();
  assert.strictEqual(state.findCalls.length, 1, 'one findFiles for three calls');
  assert.strictEqual(b.length, 1, 'the cache is not changed by the caller');
  await U.findCached(TEX, 3000, '{**/x/**}');
  assert.strictEqual(state.findCalls.length, 2, 'another exclude is another entry');
  fire('create');
  await U.texFiles();
  assert.strictEqual(state.findCalls.length, 3, 'a created file drops the lists');
  await U.texFiles();
  fire('delete');
  await U.texFiles();
  assert.strictEqual(state.findCalls.length, 4, 'a deleted file drops the lists');
});

t('openDocByPath: Map of open documents (the file one wins over a git: copy), updated by open/close events', () => {
  const U = req('util.js');
  const p = f('a.tex');
  const git = doc(p, 1, 'OLD', 'git');
  const real = doc(p, 5, 'NEW', 'file');
  state.docs = [git, real];
  fire('open');
  assert.strictEqual(U.openDocByPath(p), real);
  assert.strictEqual(U.textOf({ fsPath: p }), 'NEW');
  assert.strictEqual(U.textOfPath(p), 'NEW');
  const other = doc(f('b.tex'), 1, 'B');
  state.docs.push(other);
  assert.strictEqual(U.openDocByPath(f('b.tex')), undefined, 'the Map is rebuilt on events, not on every call');
  fire('open');
  assert.strictEqual(U.openDocByPath(f('b.tex')), other);
  state.docs = [];
  fire('close');
  assert.strictEqual(U.openDocByPath(p), undefined);
});

/* ------------------------------ projectIndex ------------------------------ */
t('PI.get: recomputed only when the file changes (disk mtime, document version, a reopened document)', () => {
  const PI = req('projectIndex.js');
  const p = f('p1.tex');
  write(p, 'disk 1');
  let calls = 0;
  const compute = (text) => { calls++; return text; };
  assert.strictEqual(PI.get('k', p, compute), 'disk 1');
  assert.strictEqual(PI.get('k', p, compute), 'disk 1');
  assert.strictEqual(calls, 1);
  write(p, 'disk 2');
  assert.strictEqual(PI.get('k', p, compute), 'disk 2');
  assert.strictEqual(calls, 2);
  const d1 = doc(p, 1, 'doc v1');
  state.docs = [d1]; fire('open');
  assert.strictEqual(PI.get('k', p, compute), 'doc v1');
  assert.strictEqual(PI.get('k', p, compute), 'doc v1');
  assert.strictEqual(calls, 3, 'an open document is stamped by its version');
  const d2 = doc(p, 2, 'doc v2'); state.docs = [d2]; fire('open');
  assert.strictEqual(PI.get('k', p, compute), 'doc v2');
  assert.strictEqual(calls, 4);
  const d3 = doc(p, 2, 'doc v2, reopened'); state.docs = [d3]; fire('open');
  assert.strictEqual(PI.get('k', p, compute), 'doc v2, reopened', 'same version number, another document object: not a hit');
  assert.strictEqual(calls, 5);
  state.docs = []; fire('close');
  assert.strictEqual(PI.get('k', p, compute), 'disk 2', 'back to the disk text');
  assert.strictEqual(calls, 6);
  const gone = f('missing.tex');
  assert.strictEqual(PI.get('k', gone, compute), '');
  PI.get('k', gone, compute);
  assert.strictEqual(calls, 8, 'a missing file is computed from "" and never cached');
});

t('PI.mapOver forgets the files that are not in the list any more; drop clears a kind', () => {
  const PI = req('projectIndex.js');
  const a = f('m1.tex'); const b = f('m2.tex');
  write(a, 'a'); write(b, 'b');
  const r = PI.mapOver('mk', [{ fsPath: a }, { fsPath: b }], (x) => x.toUpperCase());
  assert.deepStrictEqual([...r], [[a, 'A'], [b, 'B']]);
  assert.strictEqual(PI.size('mk'), 2);
  PI.mapOver('mk', [{ fsPath: a }], (x) => x);
  assert.strictEqual(PI.size('mk'), 1);
  PI.drop('mk');
  assert.strictEqual(PI.size('mk'), 0);
});

t('PI.diagSetter writes only the files whose diagnostics changed, deletes the files that got clean, clear() resets', () => {
  const PI = req('projectIndex.js');
  const c = { sets: [], deletes: [], clears: 0, set(u, d) { this.sets.push([u.fsPath, d]); }, delete(u) { this.deletes.push(u.fsPath); }, clear() { this.clears++; } };
  const s = PI.diagSetter(c);
  const e = (line, msg) => ({ line, col: 2, len: 3, message: msg, severity: 1, code: 'x' });
  const m1 = () => new Map([['/a', [e(0, 'one'), e(1, 'two')]], ['/b', [e(4, 'b')]]]);
  assert.strictEqual(s.set(m1()), 2);
  assert.strictEqual(c.sets.length, 2);
  const d = c.sets[0][1][0];
  assert.deepStrictEqual([d.range.start.line, d.range.start.character, d.range.end.character, d.message, d.severity, d.code, d.source], [0, 2, 5, 'one', 1, 'x', 'TSS Workflow']);
  assert.strictEqual(s.set(m1()), 0, 'nothing changed: nothing written');
  const m2 = m1(); m2.get('/a')[1] = e(1, 'two!');
  assert.strictEqual(s.set(m2), 1);
  assert.strictEqual(c.sets.at(-1)[0], '/a');
  m2.delete('/b');
  assert.strictEqual(s.set(m2), 1);
  assert.deepStrictEqual(c.deletes, ['/b']);
  s.clear();
  assert.strictEqual(c.clears, 1);
  assert.strictEqual(s.set(m2), 1, 'after clear() the file is written again');
});

/* --------------------------------- labels --------------------------------- */
t('labels.buildIndex: a file is scanned once per change, unsaved edits are seen at once, deleted files drop out', async () => {
  const L = req('labels.js');
  const P = req('corePure.js');
  const a = f('a.tex'); const b = f('b.tex'); const c = f('c.tex');
  write(a, '\\label{eq:a}\n\\ref{eq:b}'); write(b, '\\label{eq:b}'); write(c, '\\label{eq:b}');
  state.files[TEX] = [a, b, c];
  fire('create');
  let scans = 0;
  const orig = P.scanLabelsAndRefs;
  P.scanLabelsAndRefs = (...x) => { scans++; return orig(...x); };
  try {
    const i1 = await L.buildIndex();
    assert.strictEqual(scans, 3);
    assert.deepStrictEqual([...i1.keys()], [a, b, c]);
    await L.buildIndex(); await L.buildIndex(false); await L.buildIndex(true);
    assert.strictEqual(scans, 3, 'nothing changed: nothing rescanned (also with the old force argument)');
    write(b, '\\label{eq:b2}');
    const i2 = await L.buildIndex();
    assert.strictEqual(scans, 4, 'one changed file, one scan');
    assert.deepStrictEqual(i2.get(b).labels.map((l) => l.name), ['eq:b2']);
    state.docs = [doc(a, 3, '\\label{eq:a}\n\\label{eq:typed}\n\\ref{eq:b}')]; fire('open');
    const i3 = await L.buildIndex();
    assert.strictEqual(scans, 5);
    assert.deepStrictEqual(i3.get(a).labels.map((l) => l.name), ['eq:a', 'eq:typed'], 'an unsaved edit is in the index');
    state.docs = []; fire('close');
    state.files[TEX] = [a, b];
    fire('delete');
    const i4 = await L.buildIndex();
    assert.deepStrictEqual([...i4.keys()], [a, b]);
  } finally { P.scanLabelsAndRefs = orig; }
});

t('checkLabels writes Problems only for the files that changed', async () => {
  const L = req('labels.js');
  const a = f('la.tex'); const b = f('lb.tex');
  write(a, '\\label{eq:a}'); write(b, '\\label{eq:b}\n\\ref{eq:a}');
  state.files[TEX] = [a, b]; state.docs = []; fire('create'); fire('close');
  const c = colls['tssworkflow-labels'];
  c.sets.length = 0; c.deletes.length = 0;
  await L.checkLabels(false);
  assert.deepStrictEqual(c.sets.map((x) => x[0]), [b], 'only lb.tex has a problem (eq:b is never referred to)');
  assert.ok(c.sets[0][1][0].message.includes('eq:b'));
  await L.checkLabels(false);
  assert.strictEqual(c.sets.length, 1, 'a second check without changes writes nothing');
  write(a, '\\label{eq:a}\n\\label{eq:z}');
  await L.checkLabels(false);
  assert.deepStrictEqual(c.sets.slice(1).map((x) => x[0]), [a], 'only the changed file is rewritten');
  write(b, '\\ref{eq:a}');
  await L.checkLabels(false);
  assert.deepStrictEqual(c.deletes, [b], 'a file that got clean is deleted from Problems');
  assert.strictEqual(c.clears, 0, 'the collection is never cleared as a whole');
});

t('refCompletion takes the labels of the current document from the index', async () => {
  const L = req('labels.js');
  const P = req('corePure.js');
  const a = f('ca.tex'); const b = f('cb.tex');
  write(a, '\\label{eq:one}'); write(b, '\\label{eq:two}');
  state.files[TEX] = [a, b]; fire('create');
  const d = doc(a, 7, '\\label{eq:one}\n\\label{eq:typed}\n\\ref{eq:');
  d.lineAt = (i) => ({ text: d.getText().split('\n')[i] });
  d.uri = Object.assign(Uri.file(a), { scheme: 'file' });
  state.docs = [d]; fire('open');
  await L.buildIndex();
  let scans = 0;
  const orig = P.scanLabelsAndRefs;
  P.scanLabelsAndRefs = (...x) => { scans++; return orig(...x); };
  try {
    vscode.CompletionItem = class { constructor(l) { this.label = l; } };
    vscode.CompletionItemKind = { Reference: 17 };
    const items = await L.refCompletion.provideCompletionItems(d, { line: 2, character: 'ref{eq:'.length + 1 });
    assert.strictEqual(scans, 0, 'no rescan of the current document');
    assert.deepStrictEqual(items.map((i) => i.label).sort(), ['eq:one', 'eq:two', 'eq:typed'].sort());
  } finally { P.scanLabelsAndRefs = orig; state.docs = []; fire('close'); }
});

/* -------------------------------- citations -------------------------------- */
t('checkCitations: scans cached per file, Problems rewritten only where something changed', async () => {
  const S = req('settingsCitations.js');
  const tex = f('ct.tex'); const bib = f('refs.bib');
  write(bib, '@article{k1,\n  title = {One}\n}\n@article{k2,\n  title = {Two}\n}\n');
  write(tex, 'text \\cite{k1,k3}\n');
  state.files[TEX] = [tex]; state.files['**/*.bib'] = [bib]; state.docs = []; fire('create'); fire('close');
  const c = colls['tssworkflow-cites'];
  c.sets.length = 0; c.deletes.length = 0;
  await S.checkCitations(false);
  const byFile = Object.fromEntries(c.sets.map((x) => [path.basename(x[0]), x[1].map((d) => d.code)]));
  assert.deepStrictEqual(byFile, { 'ct.tex': ['cite-undefined'], 'refs.bib': ['bib-unused'] });
  await S.checkCitations(false);
  assert.strictEqual(c.sets.length, 2, 'unchanged: nothing written');
  write(tex, 'text \\cite{k1,k2}\n');
  await S.checkCitations(false);
  assert.deepStrictEqual(c.deletes.map((x) => path.basename(x)).sort(), ['ct.tex', 'refs.bib'], 'both files are clean now');
  assert.strictEqual(c.clears, 0);
  cfgv.citationChecks = false;
  try { await S.checkCitations(false); assert.strictEqual(c.clears, 1, 'switched off: the collection is cleared'); } finally { delete cfgv.citationChecks; }
});

/* ------------------------------- labels panel ------------------------------- */
t('LabelsProvider: a hidden panel is only marked stale, ensure() and showing the panel rebuild it, unchanged files are not rescanned', async () => {
  const FL = req('filesAndLabels.js');
  const X = req('filesAndLabelsPure.js');
  const a = f('pa.tex'); const b = f('pb.tex');
  write(a, '\\section{Intro}\\label{sec:i}\n\\ref{eq:b}'); write(b, '\\begin{equation}\\label{eq:b}\nx\n\\end{equation}');
  const glob = '**/*.{tex,tikz,cls,sty}';
  state.files[glob] = [a, b]; state.docs = []; fire('create'); fire('close');
  const p = new FL._t.LabelsProvider();
  p.view = { visible: false };
  let refreshes = 0;
  const orig = p.refresh.bind(p);
  p.refresh = async () => { refreshes++; return orig(); };
  let scans = 0;
  const origData = X.labelFileData;
  X.labelFileData = (...x) => { scans++; return origData(...x); };
  try {
    assert.strictEqual(p.stale, true);
    p.schedule(0);
    await sleep(25);
    assert.strictEqual(refreshes, 0, 'hidden panel: no rebuild');
    assert.strictEqual(p.stale, true);
    await p.ensure();
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(p.stale, false);
    assert.strictEqual(p.index.total, 2);
    assert.strictEqual(scans, 2);
    assert.strictEqual(p.index.groups.find((g) => g.path === 'pa.tex').labels[0].ctx, 'Intro', 'the context comes from the cache');
    assert.strictEqual(p.index.groups.find((g) => g.path === 'pb.tex').labels[0].uses, 1);
    await p.ensure();
    assert.strictEqual(refreshes, 1, 'fresh and not empty: ensure() does nothing');
    p.view.visible = true;
    p.schedule(0);
    await sleep(40);
    assert.strictEqual(refreshes, 2, 'visible panel: rebuilt');
    assert.strictEqual(scans, 2, 'no file changed: no file rescanned');
    write(b, '\\begin{equation}\\label{eq:b}\\label{eq:b2}\nx\n\\end{equation}');
    p.schedule(0);
    await sleep(40);
    assert.strictEqual(scans, 3, 'one file changed: one rescan');
    assert.strictEqual(p.index.total, 3);
  } finally { X.labelFileData = origData; }
});

/* -------------------------------------------------------------------------- */
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + n + ' tests passed');
  process.exit(0);
})();
