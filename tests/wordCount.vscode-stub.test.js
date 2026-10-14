'use strict';
// node tests/wordCount.vscode-stub.test.js [path/to/extension]
// The word count of the status bar: deepWords (the file and everything it includes) against a synthetic project, where the expected
// numbers are computed independently (countWords of every file that must be reached); with the caches on (util.initCaches) the
// second call must not read the files again, and an edit of one file (the open document: its version; a closed one: mtime) must
// show in the next number. The status bar item must not recount the document when only the selection moved.
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-wc-'));

const handler = { get: (t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const events = {};
const ev = (name) => (fn) => { (events[name] = events[name] || []).push(fn); return { dispose() {} }; };
const state = { docs: [] };
const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }) };
const cfgv = {};
const cfg = { get: (k, d) => (k in cfgv ? cfgv[k] : d), update: async () => {}, has: () => false, inspect: () => ({}) };
const statusItems = [];
const vscode = mk({
  Uri,
  StatusBarAlignment: { Left: 1 },
  workspace: mk({
    get textDocuments() { return state.docs; },
    findFiles: async () => [],
    createFileSystemWatcher: () => ({ onDidCreate: ev('create'), onDidDelete: ev('delete'), dispose() {} }),
    onDidOpenTextDocument: ev('open'), onDidCloseTextDocument: ev('close'), onDidChangeTextDocument: ev('change'), onDidChangeConfiguration: ev('cfg'),
    workspaceFolders: [{ uri: Uri.file(tmp) }], getWorkspaceFolder: () => ({ uri: Uri.file(tmp) }), getConfiguration: () => cfg
  }),
  window: mk({
    activeTextEditor: undefined,
    createStatusBarItem: () => { const it = { text: '', tooltip: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; statusItems.push(it); return it; },
    onDidChangeActiveTextEditor: ev('editor'), onDidChangeTextEditorSelection: ev('selection')
  })
});
const realFs = require('fs');
const reads = [];
const spyFs = Object.assign({}, realFs, { readFileSync: (p, ...a) => { if (String(p).startsWith(tmp)) reads.push(String(p)); return realFs.readFileSync(p, ...a); } });
const load = Module._load;
Module._load = function (req, ...a) { return req === 'vscode' ? vscode : req === 'fs' ? spyFs : load.call(this, req, ...a); };
const req = (f) => require(path.join(ext, f));

let tick = 0;
const f = (n) => path.join(tmp, n);
function write(rel, text) { const p = f(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); const d = new Date(1e12 + (++tick) * 5000); fs.utimesSync(p, d, d); return p; }
const mkDoc = (p, version, text) => ({ uri: Object.assign(Uri.file(p), { scheme: 'file' }), version, languageId: 'latex', getText: (r) => (r ? '' : text), lineCount: text.split('\n').length, fileName: p, isDirty: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const words = (rel) => req('filesAndLabelsPure.js').countWords(fs.readFileSync(f(rel), 'utf8'));

// the project: main -> A (\includechapter), extra (\input), B (\includechapter); A -> A/sec (\input) and back to main (a cycle);
// B -> A again (a duplicate is counted once); ghost does not exist; a commented-out \input is not a reference
const MAIN = 'Перше слово другого рядка тексту.\n\\includechapter{A}\n\\input{extra}\n\\includechapter{B}\n\\input{ghost}\n% \\input{commented}\nКінець головного файла.\n';
write('main.tex', MAIN);
write('A/A.tex', 'Розділ А має кілька слів у собі.\n\\input{A/sec}\n\\input{main}\n');
write('A/sec.tex', 'Підрозділ містить ще п’ять слів тут.\n');
write('extra.tex', 'Додатковий файл з трьома словами.\n');
write('B/B.tex', 'Розділ Б.\n\\includechapter{A}\n');
write('commented.tex', 'Це не повинно рахуватись нікуди ніколи.\n');

(async () => {
  const FL = req('filesAndLabels.js');
  const U = req('util.js');
  const deep = FL._t.deepWords;
  const expectedAll = words('main.tex') + words('A/A.tex') + words('A/sec.tex') + words('extra.tex') + words('B/B.tex');

  t('deepWords reaches every included file once (\\includechapter, \\input, a cycle, a duplicate), skips a missing one and a commented-out one', () => {
    state.docs = [];
    const d = deep(mkDoc(f('main.tex'), 1, MAIN));
    assert.strictEqual(d.files, 5, 'main, A, sec, extra, B');
    assert.strictEqual(d.total, expectedAll);
  });

  t('the open (unsaved) text of the root file counts, not the text on disk', () => {
    const text = 'Тільки чотири слова тут.\n\\input{extra}\n';
    const d = deep(mkDoc(f('main.tex'), 7, text));
    assert.strictEqual(d.files, 2);
    assert.strictEqual(d.total, req('filesAndLabelsPure.js').countWords(text) + words('extra.tex'));
  });

  t('an included file that is open and unsaved counts with its open text', () => {
    const openA = mkDoc(f('A/A.tex'), 3, 'Лише два слова.\n');
    state.docs = [openA];
    try {
      const d = deep(mkDoc(f('main.tex'), 1, MAIN));
      const expected = words('main.tex') + 3 + words('extra.tex') + words('B/B.tex');
      assert.strictEqual(d.total, expected, 'A is replaced by its open text and no longer includes sec');
      assert.strictEqual(d.files, 4);
    } finally { state.docs = []; }
  });

  t('with the caches on: the second call reads no file; an edit of a closed file (mtime) and of the open root (version) shows at once', () => {
    U.initCaches({ subscriptions: [] });
    assert.ok(U.cachingOn(), 'the caches are on');
    const root = mkDoc(f('main.tex'), 1, MAIN);
    state.docs = [];
    const first = deep(root);
    assert.strictEqual(first.total, expectedAll);
    reads.length = 0;
    const second = deep(root);
    assert.deepStrictEqual(second, first, 'the same number');
    assert.deepStrictEqual(reads, [], 'nothing is read again: ' + reads.map((p) => path.basename(p)).join(','));
    // a closed file changes on disk
    write('extra.tex', 'Додатковий файл тепер має значно більше слів, ніж мав раніше.\n');
    const third = deep(root);
    assert.strictEqual(third.total, words('main.tex') + words('A/A.tex') + words('A/sec.tex') + words('extra.tex') + words('B/B.tex'), 'the edit of extra.tex is counted');
    assert.notStrictEqual(third.total, first.total);
    // the open root changes (a new version): its new text counts
    const edited = mkDoc(f('main.tex'), 2, MAIN + 'Ще кілька нових слів додано.\n');
    const fourth = deep(edited);
    assert.strictEqual(fourth.total, third.total + req('filesAndLabelsPure.js').countWords('Ще кілька нових слів додано.'));
    // a new reference appears in an included file: it is followed
    write('B/B.tex', 'Розділ Б.\n\\includechapter{A}\n\\input{commented}\n');
    const fifth = deep(edited);
    assert.strictEqual(fifth.total, fourth.total + words('commented.tex'));
    assert.strictEqual(fifth.files, fourth.files + 1);
  });

  t('the status bar item: a move of the selection in an unchanged document does not recount the document', async () => {
    const wc = req('filesAndLabelsPure.js');
    const origCount = wc.countWords;
    let calls = 0;
    wc.countWords = (s) => { calls++; return origCount(s); };
    try {
      for (const k of Object.keys(require.cache)) if (k.startsWith(ext) && /filesAndLabels\.js$/.test(k)) delete require.cache[k];
      const FL2 = req('filesAndLabels.js');
      assert.ok(FL2);
      const text = 'Один два три чотири п’ять.\n';
      const doc = mkDoc(f('wc-status.tex'), 1, text);
      doc.getText = (r) => (r ? 'два три' : text);
      const ed = { document: doc, selection: { isEmpty: true } };
      vscode.window.activeTextEditor = ed;
      // register() creates the item and calls update() once
      FL2.register({ subscriptions: [], extensionUri: Uri.file(ext) }, { applyWithPreview: async () => {} });
      const item = statusItems[statusItems.length - 1];
      assert.ok(/5 сл\./.test(item.text), 'five words: ' + item.text);
      const before = calls;
      ed.selection = { isEmpty: false }; // the selection moved, the text did not
      (events.selection || []).forEach((fn) => fn({ textEditor: ed }));
      await sleep(400); // the debounce of the item is 300 ms
      assert.ok(/2 із 5 сл\./.test(item.text), 'the selection is shown: ' + item.text);
      assert.strictEqual(calls - before, 1, 'only the selection was counted (1 call), the document was not: ' + (calls - before));
      // the text changed: the document is counted again
      doc.version = 2;
      const t2 = 'Один два три чотири п’ять шість.\n';
      doc.getText = (r) => (r ? 'два три' : t2);
      ed.selection = { isEmpty: true };
      (events.change || []).forEach((fn) => fn({ document: doc }));
      await sleep(400);
      assert.ok(/6 сл\./.test(item.text), 'six words after the edit: ' + item.text);
    } finally { wc.countWords = origCount; vscode.window.activeTextEditor = undefined; }
  });

  for (const [name, fn] of tests) { await fn(); n++; console.log('ok  ' + name); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + n + ' tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
