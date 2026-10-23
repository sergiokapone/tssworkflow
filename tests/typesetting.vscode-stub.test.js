'use strict';
// node tests/typesetting.vscode-stub.test.js [path/to/extension]  - the commands of 0.23.0 on a real folder with a stubbed VS Code:
// hyphenHelper (the quick picks and the input box answered), dstuBib, floatPlacement (and its section of preflight), importPdfNotes
// (pdftotext and synctex faked); the edits are applied to the texts of the documents
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module'), zlib = require('zlib');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-typeset-'));
const proj = path.join(tmp, 'book');
const w = (rel, data) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };

const mainTex = w('main.tex', '\\documentclass{book}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{Ch/Ch}\n\\end{document}\n');
const chTex = w('Ch/Ch.tex', [
  'Текст посилається на рис.~\\ref{fig:far} тут.', // 1
  'Підручник адресований насамперед студентам фізико-технічного', // 2
  'факультету, а рівняння пов’язує поля.', // 3
  '\\begin{figure}', // 4
  '\\caption{Далекий}\\label{fig:far}', // 5
  '\\end{figure}', // 6
  'Див. \\cite{good} і \\cite{bad}.' // 7
].join('\n') + '\n');
w('refs.bib', '@article{good, author = {А, Б.}, title = {Т}, journal = {Ж}, year = {2020}, volume = {1}, pages = {1--2}, langid = {ukrainian}}\n@book{bad, author = {Knuth, D.}, title = {Book}, year = {1984}}\n@book{uncited, title = {X}}\n');
const pdf = w('main.pdf', '%PDF-1.5 placeholder');
w('main.log', [
  '(./main.tex (./Ch/Ch.tex',
  'Overfull \\hbox (3.5pt too wide) in paragraph at lines 2--3',
  '[]\\TU/Bookman(0)/m/n/14 Під-ру-чник адре-со-ва-ний на-сам-пе-ред сту-ден-там фізико-технічного',
  ' []',
  '', '))'
].join('\n'));
w('main.aux', '\\relax\n\\@input{Ch/Ch.aux}\n');
w('Ch/Ch.aux', '\\newlabel{fig:far}{{1}{4}{Далекий}{figure.1}{}}\n');
fs.writeFileSync(path.join(proj, 'main.synctex.gz'), zlib.gzipSync(['SyncTeX Version:1', 'Input:1:./main.tex', 'Input:2:./Ch/Ch.tex', 'Content:', '{1', '(2,1:1,1:0,0,0', '}1', '{4', '(2,5:1,1:0,0,0', '}4', ''].join('\n')));

// a reviewed copy of the PDF: one highlight on page 1
const utf16 = (s) => '<FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex') + '>';
const reviewed = w('review/main-reviewed.pdf', ['%PDF-1.5',
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj', '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 600 800] >>\nendobj',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>\nendobj',
  '4 0 obj\n<< /Type /Annot /Subtype /Highlight /Rect [100 690 200 700] /QuadPoints [100 700 200 700 100 690 200 690] /Contents ' + utf16('Уточніть') + ' /T (Reviewer) >>\nendobj',
  'trailer\n<< /Root 1 0 R >>\n%%EOF\n'].join('\n'));

/* ---------------------------- the stubbed VS Code ---------------------------- */
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(a, b, c, d) { this.start = new Position(a, b); this.end = new Position(c, d); } }
class WorkspaceEdit {
  constructor() { this.ops = []; }
  replace(uri, range, text) { this.ops.push({ uri, range, text }); }
  insert(uri, pos, text) { this.ops.push({ uri, range: new Range(pos.line, pos.character, pos.line, pos.character), text }); }
}
const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => 'file:///' + p.replace(/\\/g, '/'), with: () => Uri.file(p) }) };
const texts = new Map(); // the texts of the "open" documents
const textOfDoc = (p) => (texts.has(p) ? texts.get(p) : fs.readFileSync(p, 'utf8'));
const offset = (text, pos) => { const L = text.split('\n'); let o = 0; for (let i = 0; i < Math.min(pos.line, L.length); i++) o += L[i].length + 1; return Math.min(text.length, o + (pos.line < L.length ? pos.character : 0)); };
const mkDoc = (p) => ({
  uri: Uri.file(p), fileName: p, languageId: 'latex', isDirty: texts.has(p), eol: 1,
  getText: () => textOfDoc(p), get lineCount() { return textOfDoc(p).split('\n').length; },
  lineAt: (i) => ({ text: textOfDoc(p).split('\n')[i] || '' })
});
const S = { picks: [], inputs: [], infoAnswers: [], warnings: [], reports: [], dialog: null, tools: [] };
const commands = {};
const disp = { dispose() {} };
const handler = { get: (t, k) => (k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const walk = (dir, out) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };
let active;
const vscode = mk({
  Uri, Range, Position, WorkspaceEdit, EndOfLine: { LF: 1, CRLF: 2 }, ProgressLocation: { Notification: 15 },
  commands: mk({ registerCommand: (id, fn) => { commands[id] = fn; return disp; }, executeCommand: async () => undefined }),
  workspace: mk({
    get workspaceFolders() { return [{ uri: Uri.file(proj), name: 'book', index: 0 }]; },
    get textDocuments() { return [...texts.keys()].map(mkDoc); },
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {}, has: () => false, inspect: () => ({}) }),
    getWorkspaceFolder: () => ({ uri: Uri.file(proj), name: 'book', index: 0 }),
    findFiles: async (glob) => {
      const g = typeof glob === 'string' ? glob : glob.pattern;
      const m = /\*\.\{([^}]*)\}$/.exec(g) || /\*\.(\w+)$/.exec(g);
      const exts = m ? m[1].split(',').map((e) => '.' + e.toLowerCase()) : [];
      return walk(proj, []).filter((f) => exts.includes(path.extname(f).toLowerCase())).map(Uri.file);
    },
    openTextDocument: async (x) => {
      if (x && x.content !== undefined) { S.reports.push(x.content); return { uri: Uri.file(path.join(tmp, 'Untitled-' + S.reports.length)), lineCount: 1 }; }
      return mkDoc(x.fsPath);
    },
    applyEdit: async (we) => {
      // the operations of one file from the end, so that the earlier offsets stay right
      const by = new Map();
      for (const op of we.ops) { if (!by.has(op.uri.fsPath)) by.set(op.uri.fsPath, []); by.get(op.uri.fsPath).push(op); }
      for (const [p, ops] of by) {
        let t = textOfDoc(p);
        for (const op of ops.map((o) => ({ o, a: offset(t, o.range.start), b: offset(t, o.range.end) })).sort((x, y) => y.a - x.a)) t = t.slice(0, op.a) + op.o.text + t.slice(op.b);
        texts.set(p, t);
      }
      return true;
    }
  }),
  window: mk({
    get activeTextEditor() { return active; },
    showQuickPick: async (items, o) => { const f = S.picks.shift(); return f ? f(items, o) : undefined; },
    showInputBox: async (o) => { const f = S.inputs.shift(); return f ? f(o) : undefined; },
    showInformationMessage: async (m, ...b) => { const f = S.infoAnswers.shift(); return f ? f(m, b) : undefined; },
    showWarningMessage: async (m) => { S.warnings.push(m); return undefined; },
    showOpenDialog: async () => (S.dialog ? [Uri.file(S.dialog)] : undefined),
    showTextDocument: async () => undefined,
    setStatusBarMessage: () => disp,
    withProgress: (o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disp })
  }),
  languages: mk({ registerDocumentLinkProvider: () => disp, registerCodeLensProvider: () => disp })
});
const realCp = require('child_process');
const load = Module._load;
Module._load = function (req, ...a) {
  if (req === 'vscode') return vscode;
  if (req === 'child_process') {
    return Object.assign({}, realCp, {
      execFile: (cmd, args, opts, cb) => {
        const fake = { pdftotext: () => 'знак мінус\n', synctex: () => 'SyncTeX result begin\nOutput:' + pdf + '\nInput:' + path.join(proj, '.', 'Ch', 'Ch.tex') + '\nLine:3\nColumn:-1\nSyncTeX result end\n' }[cmd];
        if (!fake) return realCp.execFile(cmd, args, opts, cb);
        S.tools.push(cmd + ' ' + args.map((x) => (path.isAbsolute(x) ? path.basename(x) : x)).join(' '));
        setImmediate(() => cb(null, fake(), ''));
        return { on() {}, kill() {} };
      }
    });
  }
  return load.call(this, req, ...a);
};

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const editorOn = (p) => ({ document: mkDoc(p), selection: { active: { line: 0 } } });

t('hyphenHelper: the compound word of the log; \\- at this place only, with the edited points', async () => {
  active = editorOn(mainTex);
  let shown = null;
  S.picks.push((items) => { shown = items; return items[0]; });
  S.picks.push((acts) => { assert.strictEqual(acts.length, 2, 'a compound word: no \\hyphenation, only \\- and open: ' + acts.join(' | ')); return acts[0]; });
  S.inputs.push((o) => {
    assert.strictEqual(o.value, 'фі-зи-ко-тех-ніч-но-го');
    assert.ok(o.validateInput('фі-зи-ко-тех-ніч-но-го') === null && o.validateInput('щось-інше') !== null);
    return 'фі-зи-ко-тех-ніч-но-го';
  });
  await commands['tssworkflow.hyphenHelper']();
  assert.deepStrictEqual(shown.map((i) => [i.label, i.description]), [['фізико-технічного', 'Ch/Ch.tex:2 · 3.5pt']]);
  assert.ok(textOfDoc(chTex).split('\n')[1].endsWith('студентам фі\\-зи\\-ко-тех\\-ніч\\-но\\-го'), textOfDoc(chTex).split('\n')[1]);
});

t('hyphenHelper: \\hyphenation goes into the preamble of main.tex (a plain word of the log)', async () => {
  texts.delete(chTex);
  fs.appendFileSync(path.join(proj, 'main.log'), '\n(./Ch/Ch.tex\nOverfull \\hbox (2.0pt too wide) in paragraph at lines 3--3\n[]\\TU/Bookman(0)/m/n/14 фа-куль-те-ту, а рів-нян-ня пов’язує\n []\n\n)\n');
  S.picks.push((items) => items.find((i) => i.label === 'пов’язує'));
  S.picks.push((acts) => acts[0]);
  S.inputs.push((o) => o.value.replace('пов’-я-зує', 'пов’я-зує'));
  await commands['tssworkflow.hyphenHelper']();
  assert.ok(textOfDoc(mainTex).includes('\\usepackage{graphicx}\n\\hyphenation{пов’я-зує}\n\\begin{document}'), textOfDoc(mainTex));
});

t('dstuBib: only the cited entries; the report has the place of the bad one', async () => {
  S.picks.push((items) => items[0]); // "only the cited"
  const before = S.reports.length;
  await commands['tssworkflow.dstuBib']();
  const md = S.reports[before];
  assert.ok(md && md.includes('Лише записи, цитовані в проєкті (2 ключів).'), md); // good and bad; \ref{fig:far} is not a citation
  assert.ok(md.includes('- refs.bib:2 `bad` (@book) — ✗ немає location (address), publisher'), md);
  assert.ok(!md.includes('uncited'));
});

t('floatPlacement: the figure four pages after its first reference; the same section in the check before print', async () => {
  texts.clear();
  const before = S.reports.length;
  await commands['tssworkflow.floatPlacement']();
  const md = S.reports[before];
  assert.ok(md.includes('- Ch/Ch.tex:5 `fig:far` (figure) — с. 4; перше посилання Ch/Ch.tex:1 — с. 1'), md);
  const pf = await require(path.join(ext, 'preflight.js'))._t.compute(pdf, proj, null);
  assert.ok(/⚠ рисунків і таблиць не біля першого посилання: 1/.test(pf) && pf.includes('## Плаваючі об\'єкти й перші посилання'), pf);
});

t('importPdfNotes: the highlight with its text, the place by synctex, the TODO line inserted above it', async () => {
  S.dialog = reviewed;
  S.tools = [];
  S.infoAnswers.push((m, b) => { assert.ok(/Вставити 1 позначок TODO/.test(m)); return b.find((x) => x === 'Вставити'); });
  const before = S.reports.length;
  await commands['tssworkflow.importPdfNotes']();
  const md = S.reports[before];
  assert.ok(md.includes('- с. 1 · виділення · Reviewer: Уточніть «знак мінус» → Ch/Ch.tex:3'), md);
  assert.deepStrictEqual(S.tools.sort(), ['pdftotext -f 1 -l 1 -x 100 -y 100 -W 101 -H 11 -enc UTF-8 -nopgbrk main-reviewed.pdf -', 'synctex edit -o 1:102.0:105.0:' + pdf + ' -d book'].sort());
  const lines = textOfDoc(chTex).split('\n');
  assert.strictEqual(lines[2], '% TODO: [Reviewer, с. 1] Уточніть «знак мінус»');
  assert.ok(lines[3].startsWith('факультету'));
});

t('importPdfNotes: no file chosen: nothing; a PDF without notes: a message, no question', async () => {
  S.dialog = null;
  const before = S.reports.length;
  await commands['tssworkflow.importPdfNotes']();
  assert.strictEqual(S.reports.length, before);
  S.dialog = w('review/clean.pdf', '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n');
  S.infoAnswers.push((m) => { assert.ok(/немає приміток/.test(m), m); return undefined; });
  await commands['tssworkflow.importPdfNotes']();
  assert.strictEqual(S.infoAnswers.length, 0, 'the message was shown');
});

(async () => {
  const ctx = { subscriptions: [] };
  const U = require(path.join(ext, 'util.js'));
  require(path.join(ext, 'projectInfo.js')).register(ctx, { texFiles: U.texFiles });
  for (const m of ['hyphen', 'dstu', 'floats', 'annots']) require(path.join(ext, m + '.js')).register(ctx);
  try {
    for (const [name, fn] of tests) { await fn(); n++; console.log('ok  ' + name); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('\n' + n + ' tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
