'use strict';
// node tests/synctex.test.js [path/to/extension]
// synctexPure.js (inputs of a .synctex file, spellings of a path, the verdicts, the report) and synctex.js (the real files:
// a truncated .gz, the cache, precheck, the command "Diagnose SyncTeX") on a small stub of vscode.
const path = require('path'), fs = require('fs'), os = require('os'), zlib = require('zlib'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const S = require(path.join(ext, 'synctexPure.js'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const HEAD = 'SyncTeX Version:1\nInput:1:./main.tex\nInput:2:./Ch/Ch.tex\nInput:3:C:/tex/live/article.cls\nInput:4:./Ch/tikz/pic.tikz\nOutput:pdf\nMagnification:100000\nContent:\n';

t('parseSynctexInputs: only the header, CRLF, numbers', () => {
  assert.deepStrictEqual(S.parseSynctexInputs(HEAD).map((i) => [i.n, i.path]), [[1, './main.tex'], [2, './Ch/Ch.tex'], [3, 'C:/tex/live/article.cls'], [4, './Ch/tikz/pic.tikz']]);
  assert.deepStrictEqual(S.parseSynctexInputs('Input:1:a.tex\r\nInput:2:b.tex\r\nContent:\r\n').map((i) => i.path), ['a.tex', 'b.tex']);
  assert.deepStrictEqual(S.parseSynctexInputs('Input:1:a.tex\nContent:\nInput:9:in the body.tex\n').map((i) => i.n), [1], 'nothing after Content:');
  assert.deepStrictEqual(S.parseSynctexInputs(''), []);
  assert.deepStrictEqual(S.parseSynctexInputs(null), []);
});

t('normPath: separators, dots, base, case', () => {
  assert.strictEqual(S.normPath('./Ch/../Ch/Ch.tex', 'C:\\P\\', false), 'C:/P/Ch/Ch.tex');
  assert.strictEqual(S.normPath('C:\\P\\Ch\\Ch.tex', 'D:/other', false), 'C:/P/Ch/Ch.tex', 'an absolute path ignores the base');
  assert.strictEqual(S.normPath('/home/u/p/./a.tex', '', false), '/home/u/p/a.tex');
  assert.strictEqual(S.normPath('C:/P/CH/Ch.TEX', '', true), 'c:/p/ch/ch.tex');
  assert.strictEqual(S.normPath('a/b.tex', '', false), 'a/b.tex');
});

const inputs = S.parseSynctexInputs(HEAD);
const rep = (file, ci, extra) => S.synctexReport(Object.assign({ inputs, file, base: 'C:/P', root: 'C:/P', ci }, extra || {}));

t('synctexReport: ok, case, name, missing', () => {
  assert.strictEqual(rep('C:\\P\\Ch\\Ch.tex', true).status, 'ok');
  assert.strictEqual(rep('C:\\P\\Ch\\Ch.tex', true).recorded, './Ch/Ch.tex');
  const c = rep('c:\\p\\CH\\ch.tex', true);
  assert.strictEqual(c.status, 'case');
  assert.strictEqual(c.resolved, 'C:/P/Ch/Ch.tex');
  const cs = rep('c:\\p\\CH\\ch.tex', false);
  assert.strictEqual(cs.status, 'name', 'a case-sensitive system: the same name, another spelling');
  assert.deepStrictEqual(cs.candidates, ['./Ch/Ch.tex']);
  assert.strictEqual(S.synctexReport({ inputs, file: 'C:/Other/Ch.tex', base: 'C:/P', root: 'C:/P', ci: false }).status, 'name', 'the same name elsewhere');
  assert.deepStrictEqual(S.synctexReport({ inputs, file: 'C:/Other/Ch.tex', base: 'C:/P', root: 'C:/P', ci: false }).candidates, ['./Ch/Ch.tex']);
  const m = rep('C:/P/Ch2/Ch2.tex', true);
  assert.strictEqual(m.status, 'missing');
  assert.strictEqual(m.recorded, null);
  assert.deepStrictEqual(m.inProject, ['main.tex', 'Ch/Ch.tex', 'Ch/tikz/pic.tikz'], 'the project files of the PDF, the class of TeX Live is not among them');
  assert.strictEqual(m.total, 4);
  assert.strictEqual(S.synctexReport({ inputs: [], file: 'C:/P/a.tex', base: 'C:/P', root: 'C:/P', ci: true }).status, 'missing');
});

t('spelledAsRecorded: only for a case difference, with the separators of the file of the editor', () => {
  const c = rep('c:\\p\\CH\\ch.tex', true);
  assert.strictEqual(S.spelledAsRecorded(c, 'c:\\p\\CH\\ch.tex'), 'C:\\P\\Ch\\Ch.tex');
  assert.strictEqual(S.spelledAsRecorded(c, 'c:/p/CH/ch.tex'), 'C:/P/Ch/Ch.tex');
  assert.strictEqual(S.spelledAsRecorded(rep('C:/P/Ch/Ch.tex', true), 'x'), null);
  assert.strictEqual(S.spelledAsRecorded(null, 'x'), null);
});

t('formatSynctexReport: every verdict, the list of files, an old build, no synctex file', () => {
  const ctx = { pdf: 'C:/P/main.pdf', synctex: 'C:/P/main.synctex.gz', synctexMtime: 1e12, fileMtime: 1e12 - 5000, file: 'C:/P/Ch/Ch.tex', line: 12, root: 'C:/P' };
  const text = (r, c) => S.formatSynctexReport(r, Object.assign({}, ctx, c || {})).join('\n');
  assert.ok(/✓ Файл є в PDF \(записаний як `\.\/Ch\/Ch\.tex`\)/.test(text(rep('C:/P/Ch/Ch.tex', true))));
  assert.ok(text(rep('C:/P/Ch/Ch.tex', true)).includes('рядок 12'));
  assert.ok(!text(rep('C:/P/Ch/Ch.tex', true)).includes('змінено після'));
  assert.ok(text(rep('C:/P/Ch/Ch.tex', true), { fileMtime: 1e12 + 60000 }).includes('Файл змінено після останньої збірки'));
  assert.ok(text(rep('c:/p/ch/ch.tex', true)).includes('⚠ Файл є в PDF, але записаний інакше'));
  const missing = text(rep('C:/P/Ch2/Ch2.tex', true));
  assert.ok(missing.includes('✗ Цього файла немає в останній збірці PDF'));
  assert.ok(missing.includes('- `Ch/Ch.tex`') && missing.includes('main.synctex.gz'));
  assert.ok(text(S.synctexReport({ inputs, file: 'C:/Other/Ch.tex', base: 'C:/P', root: 'C:/P', ci: false })).includes('є файл із такою самою назвою'));
  assert.ok(text(null, { synctex: null }).includes('Немає `<job>.synctex.gz`'));
  const many = Array.from({ length: 20 }, (_, i) => ({ n: i, path: './C' + i + '/C' + i + '.tex' }));
  assert.ok(text(S.synctexReport({ inputs: many, file: 'C:/P/x.tex', base: 'C:/P', root: 'C:/P', ci: true })).includes('… ще 8'));
});

/* ------------------------- synctex.js on real files ------------------------- */
const handler = { get: (t0, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : new Proxy(function () {}, handler)), apply: () => new Proxy(function () {}, handler), construct: () => new Proxy(function () {}, handler) };
const mk = (o) => new Proxy(o, { get: (t0, k) => (k in t0 ? t0[k] : (typeof k === 'symbol' || k === 'then' ? undefined : new Proxy(function () {}, handler))) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-sx-'));
const shown = { docs: [], warned: [] };
const state = { editor: undefined };
const folder = { uri: { fsPath: tmp, scheme: 'file' } };
const vscode = mk({
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
  ViewColumn: { Beside: -2 },
  commands: mk({ registerCommand: (id, fn) => { shown.cmd = shown.cmd || {}; shown.cmd[id] = fn; return { dispose() {} }; } }),
  window: mk({
    get activeTextEditor() { return state.editor; },
    showWarningMessage: async (m) => { shown.warned.push(m); },
    showInformationMessage: async (m) => { shown.info = m; },
    showTextDocument: async (d, o) => { shown.docs.push([d, o]); }
  }),
  workspace: mk({ getWorkspaceFolder: () => folder, openTextDocument: async (o) => o })
});
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : load.call(this, r, ...a); };
const SX = require(path.join(ext, 'synctex.js'));
const w = (rel, buf) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };
const gz = (head, bodyBytes) => zlib.gzipSync(Buffer.concat([Buffer.from(head), require('crypto').randomBytes(bodyBytes || 10)]));

t('load: reads the inputs of a .synctex.gz, also a truncated one (the header is in the first 256 KB), and of a plain .synctex', () => {
  const pdf = w('main.pdf', 'pdf');
  const g = w('main.synctex.gz', gz(HEAD.replace(/C:\/tex/, tmp.replace(/\\/g, '/')), 900000));
  assert.ok(fs.statSync(g).size > 300000, 'the test file is bigger than the part that is read: ' + fs.statSync(g).size);
  const r = SX.load(pdf);
  assert.strictEqual(r.path, g);
  assert.deepStrictEqual(r.inputs.map((i) => i.n), [1, 2, 3, 4]);
  fs.rmSync(g);
  w('main.synctex', HEAD);
  assert.strictEqual(SX.load(pdf).inputs.length, 4);
  fs.rmSync(path.join(tmp, 'main.synctex'));
  assert.strictEqual(SX.load(pdf), null, 'no synctex file');
  w('bad.pdf', 'x'); w('bad.synctex.gz', 'this is not gzip');
  assert.deepStrictEqual(SX.load(path.join(tmp, 'bad.pdf')).inputs, [], 'a broken file gives no inputs, no exception');
});

t('load: cached by mtime and size, read again when the file changes', () => {
  const pdf = w('c.pdf', 'pdf');
  const g = w('c.synctex.gz', gz('SyncTeX Version:1\nInput:1:./a.tex\nContent:\n'));
  assert.strictEqual(SX.load(pdf).inputs.length, 1);
  const first = SX.load(pdf).inputs;
  assert.strictEqual(SX.load(pdf).inputs, first, 'the same array: not parsed again');
  fs.writeFileSync(g, gz('SyncTeX Version:1\nInput:1:./a.tex\nInput:2:./b.tex\nContent:\n'));
  assert.strictEqual(SX.load(pdf).inputs.length, 2);
});

t('precheck: nothing to judge by (no synctex), ok, the file is not in the PDF, the same name elsewhere', () => {
  const pdf = w('main.pdf', 'pdf');
  const file = (rel) => path.join(tmp, rel);
  assert.deepStrictEqual(SX.precheck(pdf, { file: file('Ch/Ch.tex') }), {}, 'no synctex file: the viewer is opened as before');
  assert.deepStrictEqual(SX.precheck(pdf, null), {});
  w('main.synctex.gz', gz(HEAD));
  assert.deepStrictEqual(SX.precheck(pdf, { file: file('Ch/Ch.tex') }), {});
  assert.deepStrictEqual(SX.precheck(pdf, {}), {});
  const miss = SX.precheck(pdf, { file: file('Ch2/Ch2.tex') });
  assert.ok(miss.warn.includes('немає файла «Ch2.tex»') && miss.warn.includes('main.pdf'), miss.warn);
  assert.deepStrictEqual(miss.buttons, ['Відкрити PDF без переходу', 'Діагностика SyncTeX']);
  const elsewhere = SX.precheck(pdf, { file: file('Copy/Ch/Ch.tex') });
  assert.ok(elsewhere.warn.includes('є файл «Ch.tex», але з іншого шляху'), elsewhere.warn);
  w('empty.pdf', 'x'); w('empty.synctex.gz', gz('SyncTeX Version:1\nContent:\n'));
  assert.deepStrictEqual(SX.precheck(path.join(tmp, 'empty.pdf'), { file: file('a.tex') }), {}, 'a synctex file without inputs: no judgement');
});

t('diagnose: the report is opened beside the editor, with the file, the verdict and the files of the PDF', async () => {
  const pdf = w('main.pdf', 'pdf');
  const file = w('Ch2/Ch2.tex', 'x');
  w('main.synctex.gz', gz(HEAD));
  const text = await SX.diagnose({ activePdf: () => ({ pdf, ctx: { file, line: 7 } }) });
  assert.ok(text.startsWith('# Діагностика SyncTeX'));
  assert.ok(text.includes('рядок 7') && text.includes('✗ Цього файла немає') && text.includes('- `Ch/Ch.tex`'), text);
  const [doc, opts] = shown.docs.at(-1);
  assert.strictEqual(doc.language, 'markdown');
  assert.strictEqual(opts.viewColumn, -2);
  assert.strictEqual(await SX.diagnose({ activePdf: () => ({ warn: 'ще немає' }) }), null);
  assert.strictEqual(shown.warned.at(-1), 'ще немає');
  assert.strictEqual(await SX.diagnose({ activePdf: () => ({ pdf: null }) }), null);
  assert.strictEqual(await SX.diagnose({ activePdf: () => ({ pdf, ctx: {} }) }), null);
  assert.ok(shown.info.includes('Відкрий .tex'));
  fs.rmSync(path.join(tmp, 'main.synctex.gz'));
  const none = await SX.diagnose({ activePdf: () => ({ pdf, ctx: { file, line: 1 } }) });
  assert.ok(none.includes('**немає**') && none.includes('Немає `<job>.synctex.gz`'));
});

t('register: the command is registered', () => {
  const subs = [];
  SX.register({ subscriptions: subs }, { activePdf: () => ({}) });
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(typeof shown.cmd['tssworkflow.synctexDiagnose'], 'function');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + n + ' tests passed');
  process.exit(0);
})();
