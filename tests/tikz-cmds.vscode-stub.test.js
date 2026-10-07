'use strict';
// node tests/tikz-cmds.vscode-stub.test.js [path/to/extension]  - 0.6.1: command "Format inline \tikz" (extra4.js) and
// "Extract tikzpicture to tikz/" with inline \tikz pictures (tikzExtract.js), on a stub of `vscode` and real files in a temp folder
const Module = require('module'), path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

const deep = () => new Proxy(function () {}, { get: (o, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => deep(), construct: () => deep() });
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
const cfgValues = {};
const log = { infos: [], warns: [], status: [], previews: [], commands: {}, inputs: [] };
let current = null;
let modalAnswer = 'Винести';

const mkEditor = (file, text, sel) => {
  const doc = {
    uri: { fsPath: file }, fileName: file, languageId: 'latex', isUntitled: false, eol: 1, text,
    get lineCount() { return doc.text.split('\n').length; },
    lineAt: (i) => ({ text: doc.text.split('\n')[i] }),
    getText: () => doc.text
  };
  const ed = {
    document: doc, options: { tabSize: 4, insertSpaces: true },
    selection: sel || { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
    edit: async (cb) => {
      const ops = [];
      cb({ replace: (r, s) => ops.push({ r, s }) });
      const L = doc.text.split('\n');
      const off = (p) => L.slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.character;
      let s = doc.text;
      for (const o of ops.sort((x, y) => off(y.r.start) - off(x.r.start))) s = s.slice(0, off(o.r.start)) + o.s + s.slice(off(o.r.end));
      doc.text = s;
      return true;
    }
  };
  return ed;
};
const stub0 = {
  Range, EndOfLine: { LF: 1, CRLF: 2 },
  Uri: { file: (p) => ({ fsPath: p }) },
  TextEdit: { replace: (r, s) => ({ r, s }) },
  window: new Proxy({
    showInformationMessage: (m, ...b) => { log.infos.push(m); return Promise.resolve(b.length && /modal/.test(JSON.stringify(b[0])) ? modalAnswer : undefined); },
    showWarningMessage: (m) => { log.warns.push(m); return Promise.resolve(undefined); },
    setStatusBarMessage: (m) => { log.status.push(m); },
    showInputBox: async (o) => { log.inputs.push(o); return 'Typed'; },
    showErrorMessage: (m) => { throw new Error(m); },
    get activeTextEditor() { return current; }
  }, { get: (o, k) => (k in o ? o[k] : deep()) }),
  workspace: new Proxy({
    getConfiguration: () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d) }),
    onWillSaveTextDocument: () => ({ dispose() {} })
  }, { get: (o, k) => (k in o ? o[k] : deep()) }),
  commands: { registerCommand: (id, fn) => { log.commands[id] = fn; return { dispose() {} }; } }
};
// the information message with { modal: true } is the confirmation of "extract all"
stub0.window.showInformationMessage = (m, ...b) => { log.infos.push(m); return Promise.resolve(b.some((x) => x && x.modal) ? modalAnswer : undefined); };
const stub = new Proxy(stub0, { get: (o, k) => (k in o ? o[k] : deep()) });
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? stub : orig.call(this, r, ...a); };
const api = {
  applyWithPreview: async (ed, s, e, lines, title, sum) => {
    log.previews.push({ title, sum });
    const L = ed.document.text.split('\n');
    L.splice(s, e - s + 1, ...lines);
    ed.document.text = L.join('\n');
    return true;
  }
};
const context = { subscriptions: [] };
require(path.join(ext, 'extra4.js')).register(context, api);
require(path.join(ext, 'tikzExtract.js')).register(context);
Module._load = orig;

const LONG = '\\tikz[>latex]{ \\node [] (0) at (0, -1) {}; \\node [] (1) at (0, +1) {}; \\draw[line width=2pt, gray] (0.center) to (1.center); \\draw[thin] (0,0) -- (1,1); }';
const SMALL = '\\tikz{ \\draw (0,0) -- (1,1); \\draw (1,1) -- (2,2); }';
const reset = () => { log.infos.length = 0; log.warns.length = 0; log.status.length = 0; log.previews.length = 0; log.inputs.length = 0; for (const k of Object.keys(cfgValues)) delete cfgValues[k]; };

t('both commands are registered', () => {
  for (const id of ['tssworkflow.formatTikz', 'tssworkflow.extractTikz', 'tssworkflow.extractTikzAll']) assert.strictEqual(typeof log.commands[id], 'function', id);
});
t('formatTikz, cursor inside a long \\tikz: that one is laid out through the preview, the short one next to it is left', async () => {
  reset();
  const text = ['\\begin{tblr}{colspec={c|c}}', '    ' + LONG + ' & ' + SMALL + ' \\\\', '\\end{tblr}'].join('\n');
  current = mkEditor('x.tex', text);
  current.selection.active = { line: 1, character: 20 };
  current.selection.isEmpty = true;
  await log.commands['tssworkflow.formatTikz']();
  assert.strictEqual(log.previews.length, 1);
  assert.strictEqual(log.previews[0].title, 'Форматування \\tikz');
  assert.ok(/під курсором/.test(log.previews[0].sum), log.previews[0].sum);
  const out = current.document.text.split('\n');
  assert.strictEqual(out[1], '    \\tikz[>latex]{');
  assert.ok(out.some((l) => l.startsWith('        \\draw[thin]')));
  assert.ok(out.some((l) => l.includes('} & ' + SMALL + ' \\\\')), 'the short one on the same line is not touched');
  assert.strictEqual(current.document.text.replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});
t('formatTikz, cursor outside any \\tikz: all in the file; minLength from the setting', async () => {
  reset();
  cfgValues['tikzFormat.minLength'] = 0;
  const text = ['text', SMALL, 'text', SMALL].join('\n'); // the cursor stays at 0:0, outside both
  current = mkEditor('x.tex', text);
  await log.commands['tssworkflow.formatTikz']();
  assert.ok(/у файлі/.test(log.previews[0].sum), log.previews[0].sum);
  assert.strictEqual((current.document.text.match(/^\\tikz\{$/gm) || []).length, 2);
});
t('formatTikz: nothing to do and no \\tikz at all give messages, the document stays', async () => {
  reset();
  current = mkEditor('x.tex', SMALL);
  await log.commands['tssworkflow.formatTikz']();
  assert.strictEqual(log.previews.length, 0);
  assert.ok(log.infos.some((m) => /Нічого розкладати/.test(m) && /minLength/.test(m)), log.infos.join('|'));
  assert.strictEqual(current.document.text, SMALL);
  reset();
  current = mkEditor('x.tex', 'просто текст');
  await log.commands['tssworkflow.formatTikz']();
  assert.ok(log.infos.some((m) => /Немає/.test(m)));
  reset();
  current = mkEditor('x.tex', 'просто текст');
  current.document.languageId = 'plaintext';
  await log.commands['tssworkflow.formatTikz']();
  assert.ok(log.infos.some((m) => /Відкрий \.tex/.test(m)));
});
t('formatTikz is idempotent through the command: the second run reports that there is nothing to do', async () => {
  reset();
  current = mkEditor('x.tex', LONG);
  await log.commands['tssworkflow.formatTikz']();
  const once = current.document.text;
  reset();
  await log.commands['tssworkflow.formatTikz']();
  assert.strictEqual(current.document.text, once);
  assert.strictEqual(log.previews.length, 0);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tssx-'));
const SRC = ['\\begin{figure}', '  \\tikz{ \\draw (0,0) -- (1,1); }', '  \\caption{c}\\label{tikz:Inline}', '\\end{figure}', '\\begin{tblr}{colspec={c}}', '  \\tikz{ \\draw (0,0) -- (2,2); } \\\\', '\\end{tblr}'].join('\n');
t('extract one: the cursor inside an inline \\tikz of a table cell; no label, so it asks for the name', async () => {
  reset();
  const file = path.join(tmp, 'a.tex');
  current = mkEditor(file, SRC);
  current.selection = { isEmpty: true, start: { line: 5, character: 10 }, end: { line: 5, character: 10 }, active: { line: 5, character: 10 } };
  await log.commands['tssworkflow.extractTikz']();
  assert.strictEqual(log.inputs.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'tikz', 'Typed.tikz'), 'utf8'), '\\tikz{ \\draw (0,0) -- (2,2); }\n');
  assert.ok(current.document.text.split('\n')[5].includes('\\localinput{Typed.tikz} \\\\'), current.document.text);
});
t('extract all: the inline one in a labelled figure goes by the label; the one without a label is skipped; inline off = as before', async () => {
  reset();
  const file = path.join(tmp, 'b.tex');
  cfgValues.tikzExtractInline = false;
  current = mkEditor(file, SRC);
  await log.commands['tssworkflow.extractTikzAll']();
  assert.ok(log.infos.some((m) => /Немає/.test(m)), 'no environments, inline switched off: ' + log.infos.join('|'));
  reset();
  current = mkEditor(file, SRC);
  await log.commands['tssworkflow.extractTikzAll']();
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'tikz', 'Inline.tikz'), 'utf8'), '\\tikz{ \\draw (0,0) -- (1,1); }\n');
  const L = current.document.text.split('\n');
  assert.strictEqual(L[1], '  \\localinput{Inline.tikz}');
  assert.ok(L[5].includes('\\tikz{ \\draw (0,0) -- (2,2); }'), 'the one without a label stays');
  assert.ok(log.infos.some((m) => /Винесено 1/.test(m) && /без мітки 1/.test(m)), log.infos.join('|'));
});
t('extract all: declining the confirmation changes nothing', async () => {
  reset();
  modalAnswer = undefined;
  const file = path.join(tmp, 'c.tex');
  current = mkEditor(file, SRC.replace('Inline', 'Other'));
  const before = current.document.text;
  await log.commands['tssworkflow.extractTikzAll']();
  assert.strictEqual(current.document.text, before);
  assert.ok(!fs.existsSync(path.join(tmp, 'tikz', 'Other.tikz')));
  modalAnswer = 'Винести';
});
(async () => {
  let n = 0;
  for (const { name, fn } of queue) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.log('FAIL  ' + name + '\n' + (e && e.stack || e)); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + n + ' tests passed');
})();
