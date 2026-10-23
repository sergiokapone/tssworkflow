'use strict';
// node tests/preflight.vscode-stub.test.js [path/to/extension]  - preflight.js on a real folder: the tools of TeX Live are faked
// (child_process.execFile), the files, the log, the dates and the picture headers are real
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-preflight-'));
const proj = path.join(tmp, 'book');
const w = (rel, data, ageSec) => {
  const f = path.join(proj, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  if (ageSec) { const t = new Date(Date.now() - ageSec * 1000); fs.utimesSync(f, t, t); }
  return f;
};
const png = (wd, ht) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(wd, 16); b.writeUInt32BE(ht, 20); return b; };

w('main.tex', '\\documentclass{book}\n\\begin{document}\n\\input{Ch/Ch}\n\\end{document}\n', 600);
w('Ch/Ch.tex', 'Текст.\n% TODO: дописати висновок\n\\iffalse\nстаре\n\\fi\n% \\iffalse у коментарі не рахується\n', 600);
w('Ch/Pictures/rub.png', png(598, 242), 600);
w('Ch/Pictures/plot.pdf', '%PDF-1.4 picture', 600);
w('old/Ch.tex', '% TODO: це стара копія\n', 600); // excluded with tssworkflow.excludeFolders
const pdf = w('main.pdf', '%PDF-1.7 book', 300);
w('main.log', '(./main.tex (./Ch/Ch.tex\nOverfull \\hbox (9.5pt too wide) in paragraph at lines 1--1\n))\n', 300);
w('main.synctex.gz', '', 300);
w('Ch/Ch2.tex', 'Нове, після збірки.\n'); // newer than the PDF

const S = { settings: { excludeFolders: ['old'] }, missing: new Set(), calls: [], warnings: [], reports: [] };
const OUT = {
  pdffonts: (file) => file.endsWith('plot.pdf')
    ? 'name type encoding emb sub uni object ID\n---- ---- ---- --- --- --- ---------\nHelvetica                            Type 1            WinAnsi          no  no  no      12  0\n'
    : 'name type encoding emb sub uni object ID\n---- ---- ---- --- --- --- ---------\nHelvetica                            Type 1            WinAnsi          no  no  no      70  0\nABCDEF+LMRoman10-Regular             Type 1C           Custom           yes yes no      56  0\n',
  pdfimages: () => 'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n----\n  17     1 image     598   242  rgb     3   8  image  no       700  0   205   210 40.1K 9.2%\n',
  pdfinfo: () => 'Pages:           12\nPage size:       595.276 x 841.89 pts (A4)\nPDF version:     1.7\n'
};
const realCp = require('child_process');
const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => 'file:///' + p.replace(/\\/g, '/'), with: () => Uri.file(p) }) };
const walk = (dir, out) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };
// the include glob gives the extensions; the exclude glob is checked by the names of folders in it (**/x/**)
const findFiles = async (glob, ex, limit) => {
  const g = typeof glob === 'string' ? glob : glob.pattern;
  const m = /\*\.\{([^}]*)\}$/.exec(g) || /\*\.(\w+)$/.exec(g);
  const exts = m ? m[1].split(',').map((e) => '.' + e.toLowerCase()) : [];
  const dirs = [...String(ex || '').matchAll(/\*\*\/([^/*{},]+)\/\*\*/g)].map((x) => x[1]);
  return walk(proj, []).filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .filter((f) => !path.relative(proj, f).split(path.sep).slice(0, -1).some((d) => dirs.includes(d))).slice(0, limit).map(Uri.file);
};
const handler = { get: (t, k) => (k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const disp = { dispose() {} };
const commands = {};
let active;
const vscode = mk({
  Uri,
  ProgressLocation: { Notification: 15 },
  commands: mk({ registerCommand: (id, fn) => { commands[id] = fn; return disp; }, executeCommand: async () => undefined }),
  workspace: mk({
    get workspaceFolders() { return [{ uri: Uri.file(proj), name: 'book', index: 0 }]; },
    textDocuments: [],
    getConfiguration: () => ({ get: (k, d) => (k in S.settings ? S.settings[k] : d), update: async () => {}, has: () => false, inspect: () => ({}) }),
    getWorkspaceFolder: () => ({ uri: Uri.file(proj), name: 'book', index: 0 }),
    findFiles,
    openTextDocument: async (o) => { S.reports.push(o.content); return { uri: Uri.file(path.join(tmp, 'Untitled-' + S.reports.length)), lineCount: 1 }; },
    onDidCloseTextDocument: () => disp
  }),
  window: mk({
    get activeTextEditor() { return active; },
    showWarningMessage: async (m) => { S.warnings.push(m); return undefined; },
    showTextDocument: async () => undefined,
    withProgress: (o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disp })
  }),
  languages: mk({ registerDocumentLinkProvider: () => disp, registerCodeLensProvider: () => disp })
});
const load = Module._load;
Module._load = function (req, ...a) {
  if (req === 'vscode') return vscode;
  if (req === 'child_process') {
    return Object.assign({}, realCp, {
      execFile: (cmd, args, opts, cb) => {
        if (!OUT[cmd]) return realCp.execFile(cmd, args, opts, cb);
        S.calls.push(cmd + ' ' + args.map((x) => path.basename(x)).join(' '));
        setImmediate(() => {
          if (S.missing.has(cmd)) { const e = new Error('spawn ' + cmd + ' ENOENT'); e.code = 'ENOENT'; cb(e, '', ''); }
          else cb(null, OUT[cmd](args[args.length - 1]), '');
        });
        return { on() {}, kill() {} };
      }
    });
  }
  return load.call(this, req, ...a);
};

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const doc = (abs) => ({ uri: Uri.file(abs), fileName: abs, languageId: 'latex', getText: () => fs.readFileSync(abs, 'utf8'), isDirty: false });

t('the report of a real folder: fonts with the picture that brought them, the picture file by its pixels, the log, stale sources, TODO and \\iffalse; excludeFolders is respected', async () => {
  const md = await require(path.join(ext, 'preflight.js'))._t.compute(pdf, proj, null);
  assert.ok(md.includes('# Перевірка перед друком — main.pdf'));
  assert.ok(md.includes('Сторінок: 12; формат: 595.276 x 841.89 pts (A4); PDF 1.7.'));
  assert.ok(md.includes('- `Helvetica` (Type 1) — у Ch/Pictures/plot.pdf'), 'the output PDF itself (it has a .log / .synctex.gz) is not a source:\n' + md);
  assert.ok(md.includes('| 17 | 205 | 598×242 | Ch/Pictures/rub.png |'));
  assert.ok(md.includes('- Ch/Ch.tex:1 — 9.5pt'));
  assert.ok(/⚠ PDF старіший за джерела \(1\)/.test(md) && md.includes('- Ch/Ch2.tex'), 'only the file written after the PDF');
  assert.ok(md.includes('- Ch/Ch.tex:2 — TODO: дописати висновок'));
  assert.ok(!md.includes('стара копія'), 'old/ is excluded');
  assert.ok(/- Ch\/Ch\.tex:3\n/.test(md) && !md.includes('Ch/Ch.tex:6'), 'the \\iffalse in a comment does not count');
  assert.ok(md.includes('**Не готово до друку.** Блокувальних проблем: 1.'));
  assert.deepStrictEqual(S.calls.filter((c) => !c.endsWith('plot.pdf')).sort(), ['pdffonts main.pdf', 'pdfimages -list main.pdf', 'pdfinfo main.pdf']);
});

t('a tool that is not installed: its part says so, the rest of the report is made', async () => {
  S.missing = new Set(['pdffonts', 'pdfimages', 'pdfinfo']);
  try {
    const md = await require(path.join(ext, 'preflight.js'))._t.compute(pdf, proj, null);
    assert.ok(md.includes('pdffonts не знайдено в PATH') && md.includes('pdfimages не знайдено в PATH'), md);
    assert.ok(md.includes('⚠ шрифти не перевірено') && md.includes('⚠ рисунки не перевірено'));
    assert.ok(!md.includes('Сторінок:'));
    assert.ok(md.includes('- Ch/Ch.tex:1 — 9.5pt'), 'the log part is still there');
  } finally { S.missing = new Set(); }
});

t('the command: the report document of projectRefactor (links, refresh); no PDF yet: a warning and no report', async () => {
  const ctx = { subscriptions: [] };
  require(path.join(ext, 'projectInfo.js')).register(ctx, { texFiles: require(path.join(ext, 'util.js')).texFiles });
  require(path.join(ext, 'preflight.js')).register(ctx);
  active = { document: doc(path.join(proj, 'Ch', 'Ch.tex')), selection: { active: { line: 0 } } };
  const before = S.reports.length;
  await commands['tssworkflow.preflight']();
  assert.strictEqual(S.reports.length, before + 1, 'one report: ' + S.warnings.join(' | '));
  assert.ok(S.reports[S.reports.length - 1].startsWith('# Перевірка перед друком — main.pdf'));
  fs.renameSync(pdf, pdf + '.bak');
  try {
    S.warnings = [];
    await commands['tssworkflow.preflight']();
    assert.strictEqual(S.reports.length, before + 1, 'no second report');
    assert.ok(S.warnings.some((m) => /PDF не знайдено/.test(m)), S.warnings.join(' | '));
  } finally { fs.renameSync(pdf + '.bak', pdf); active = undefined; }
});

(async () => {
  // projectInfo.collectTodos reads the files through util.texFiles: give it the api it gets at activation
  require(path.join(ext, 'projectInfo.js')).register({ subscriptions: [] }, { texFiles: require(path.join(ext, 'util.js')).texFiles });
  for (const [name, fn] of tests) { await fn(); n++; console.log('ok  ' + name); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + n + ' tests passed');
})().catch((e) => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
