'use strict';
// node tests/fixall.vscode-stub.test.js [path/to/extension]  - extra.js (0.6.0): "fix all" code actions, source.fixAll.tssworkflow, the command
const Module = require('module'), path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
let n = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

const deep = () => new Proxy(function () {}, { get: (o, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => deep(), construct: () => deep() });
class Kind {
  constructor(v) { this.value = v; }
  append(s) { return new Kind(this.value + '.' + s); }
  contains(o) { return o.value === this.value || o.value.startsWith(this.value + '.'); }
}
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
class WorkspaceEdit { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, range, text }); } }
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
const cfgValues = {};
const log = { infos: [], providers: [], commands: {} };

// a document as text; applyEdit edits it
const mkDoc = (text, fileName) => {
  const d = {
    text, fileName: fileName || 'a.tex', uri: { fsPath: fileName || 'a.tex', scheme: 'file' }, eol: 1,
    getText: (r) => {
      if (!r) return d.text;
      const L = d.text.split('\n');
      return (L[r.start.line] || '').slice(r.start.character, r.end.character); // like VS Code: a range outside the text is clamped
    }
  };
  return d;
};
const applyOps = (doc, ops) => {
  const L = doc.text.split('\n');
  for (const o of ops.slice().sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)) {
    const l = o.range.start.line;
    L[l] = L[l].slice(0, o.range.start.character) + o.text + L[l].slice(o.range.end.character);
  }
  doc.text = L.join('\n');
};
let current = null;
const stub0 = {
  Range, WorkspaceEdit, CodeAction,
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
  CodeActionKind: { QuickFix: new Kind('quickfix'), SourceFixAll: new Kind('source.fixAll') },
  EndOfLine: { LF: 1, CRLF: 2 },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  TreeItem: class { constructor(l, s) { this.label = l; this.collapsibleState = s; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  languages: { registerCodeActionsProvider: (sel, prov, meta) => { log.providers.push({ prov, meta }); return { dispose() {} }; } },
  commands: { registerCommand: (id, fn) => { log.commands[id] = fn; return { dispose() {} }; } },
  window: new Proxy({
    createTreeView: () => ({ dispose() {} }),
    showInformationMessage: (m) => { log.infos.push(m); return Promise.resolve(undefined); },
    get activeTextEditor() { return current; }
  }, { get: (o, k) => (k in o ? o[k] : deep()) }),
  workspace: new Proxy({
    getConfiguration: () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d) }),
    applyEdit: async (e) => { applyOps(current.document, e.ops); return true; }
  }, { get: (o, k) => (k in o ? o[k] : deep()) })
};
const stub = new Proxy(stub0, { get: (o, k) => (k in o ? o[k] : deep()) });
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : orig.call(this, r, ...a); };
const E = require(path.join(ext, 'extra.js'));
E.register({ subscriptions: [] }, { showLog() {} });
Module._load = orig;

const entry = log.providers.find((x) => x.prov && typeof x.prov.provideCodeActions === 'function');
const prov = entry.prov;
const FIXALL_KIND = stub0.CodeActionKind.SourceFixAll.append('tssworkflow');
const SRC = 'Довжина 5 см і 7 кг та 1990 р.\n% tss-ignore-next\nЩе 5 см тут\nось - тире, ще - одне\n\\tikz{ \\draw (0,0) -- (1,1); } 3 с.';
const diag = (code, line, col, len, msg) => ({ source: 'TSS Workflow', code, message: msg || '', range: new Range(line, col, line, col + len) });

t('the provider is registered for quickfix and source.fixAll.tssworkflow; the command exists', () => {
  assert.ok(entry.meta.providedCodeActionKinds.some((k) => k.value === 'source.fixAll.tssworkflow'));
  assert.ok(entry.meta.providedCodeActionKinds.some((k) => k.value === 'quickfix'));
  assert.strictEqual(typeof log.commands['tssworkflow.fixTypographyHints'], 'function');
});
t('one hint: the single quick fix and "fix all of this kind" with the number of fixes', async () => {
  const doc = mkDoc(SRC);
  const acts = await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [diag('typo-nbsp', 0, 8, 4)] });
  const titles = acts.map((a) => a.title);
  assert.ok(titles.includes('Замінити пробіл на «~»'));
  const all = acts.find((a) => a.title.startsWith('Виправити всі в файлі'));
  assert.ok(all, titles.join(' | '));
  assert.ok(all.title.endsWith(': 4'), all.title);   // 5 см, 7 кг, 1990 р., 3 с — the ignored line and the TikZ are not counted
  applyOps(doc, all.edit.ops);
  assert.strictEqual(doc.text, 'Довжина 5~см і 7~кг та 1990~р.\n% tss-ignore-next\nЩе 5 см тут\nось - тире, ще - одне\n\\tikz{ \\draw (0,0) -- (1,1); } 3~с.');
});
t('"fix all" is not offered when there is just one hint of that kind', async () => {
  const doc = mkDoc('Тут 5 см і далі - тире.');
  const acts = await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [diag('typo-nbsp', 0, 4, 4)] });
  assert.ok(!acts.some((a) => a.title.startsWith('Виправити всі')));
});
t('the dash: "fix all" works on the current text, even when the diagnostic is stale', async () => {
  const doc = mkDoc(SRC);
  const acts = await prov.provideCodeActions(doc, new Range(3, 0, 3, 0), { diagnostics: [diag('typo-dash', 99, 0, 3)] });
  const all = acts.find((a) => a.title.startsWith('Виправити всі в файлі'));
  assert.ok(all && all.title.endsWith(': 2'), all && all.title);
  applyOps(doc, all.edit.ops);
  assert.strictEqual(doc.text.split('\n')[3], 'ось --- тире, ще --- одне');
});
t('source.fixAll.tssworkflow: offered only on request; by default fixes only typo-nbsp', async () => {
  const doc = mkDoc(SRC);
  const none = await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [] });
  assert.strictEqual(none.length, 0);
  const qf = await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [], only: stub0.CodeActionKind.QuickFix });
  assert.strictEqual(qf.length, 0);
  for (const only of [stub0.CodeActionKind.SourceFixAll, FIXALL_KIND, new Kind('source')]) {
    const acts = await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [], only });
    assert.strictEqual(acts.length, 1, only.value);
    assert.strictEqual(acts[0].kind.value, 'source.fixAll.tssworkflow');
  }
  const a = (await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [], only: FIXALL_KIND }))[0];
  applyOps(doc, a.edit.ops);
  assert.ok(doc.text.includes('Довжина 5~см і 7~кг та 1990~р.'));
  assert.ok(doc.text.includes('ось - тире, ще - одне'), 'the dash is not touched by default');
  const again = await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [], only: FIXALL_KIND });
  assert.strictEqual(again.length, 0, 'nothing left to fix');
});
t('tssworkflow.fixAllCodes: typo-dash added; an empty list or unknown names fix nothing', async () => {
  cfgValues.fixAllCodes = ['typo-nbsp', 'typo-dash', 'nonsense'];
  const doc = mkDoc(SRC);
  const a = (await prov.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: [], only: FIXALL_KIND }))[0];
  applyOps(doc, a.edit.ops);
  assert.ok(doc.text.includes('ось --- тире, ще --- одне'));
  cfgValues.fixAllCodes = ['nonsense'];
  const none = await prov.provideCodeActions(mkDoc(SRC), new Range(0, 0, 0, 0), { diagnostics: [], only: FIXALL_KIND });
  assert.strictEqual(none.length, 0);
  delete cfgValues.fixAllCodes;
});
t('the command fixes the active file and reports the number; in a non-.tex file it only says so', async () => {
  const doc = mkDoc(SRC);
  current = { document: doc };
  log.infos.length = 0;
  await log.commands['tssworkflow.fixTypographyHints']();
  assert.ok(doc.text.startsWith('Довжина 5~см і 7~кг та 1990~р.'));
  assert.ok(/виправлено: 4/.test(log.infos[0]), log.infos[0]);
  await log.commands['tssworkflow.fixTypographyHints']();
  assert.ok(log.infos[1].startsWith('Нічого виправляти'), log.infos[1]);
  const other = mkDoc('5 см', 'notes.txt');
  current = { document: other };
  await log.commands['tssworkflow.fixTypographyHints']();
  assert.strictEqual(other.text, '5 см');
  assert.strictEqual(log.infos[2], 'Відкрий .tex-файл.');
  current = null;
});
(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.log('FAIL  ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  console.log('\n' + n + ' tests passed');
})();
