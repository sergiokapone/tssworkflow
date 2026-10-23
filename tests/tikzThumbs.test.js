'use strict';
// node tests/tikzThumbs.test.js [path/to/extension]
// TikZ thumbnails (0.25.0): tikzThumbsPure.js; tikzThumbs.js on a stub of vscode with fake lualatex / pdftocairo (the queue, the cache
// and its key, the states of the hover, a failed build, an untrusted workspace); and, when lualatex and pdftocairo are on PATH, a real
// build of a tiny project (skipped without TeX: CI has none).
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const { execFileSync } = require('child_process');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const T = require(path.join(ext, 'tikzThumbsPure.js'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const temps = []; // removed at the end
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };

t('figureOf: X/tikz/name.tikz under the root only', () => {
  const root = path.join(os.tmpdir(), 'proj');
  assert.deepStrictEqual(T.figureOf(root, path.join(root, 'Charges', 'tikz', 'Columb.tikz')), { chapter: 'Charges', tikz: 'Columb', rel: 'Charges/tikz/Columb.tikz' });
  assert.deepStrictEqual(T.figureOf(root, path.join(root, 'A', 'TikZ', 'f.TIKZ'), 'tikz').tikz, 'f');
  assert.strictEqual(T.figureOf(root, path.join(root, 'A', 'pics', 'f.tikz'), 'tikz'), null, 'another folder');
  assert.deepStrictEqual(T.figureOf(root, path.join(root, 'A', 'pics', 'f.tikz'), 'pics').chapter, 'A', 'the folder of \\localinput from the settings');
  assert.strictEqual(T.figureOf(root, path.join(root, 'A', 'tikz', 'f.tex')), null, 'not a .tikz');
  assert.strictEqual(T.figureOf(root, path.join(root, 'A', 'B', 'tikz', 'f.tikz')), null, 'deeper');
  assert.strictEqual(T.figureOf(root, path.join(os.tmpdir(), 'other', 'A', 'tikz', 'f.tikz')), null, 'outside the root');
});

t('pretex / latexArgs: the target of the driver, preview with tightpage for both environments, no shell escape', () => {
  const a = T.latexArgs({ chapter: 'Charges', tikz: 'Columb', driver: 'test.tex', outDir: '/c/x', job: 'thumb' });
  const tex = a[a.length - 1];
  assert.ok(tex.startsWith('\\def\\TargetChapter{Charges}\\def\\TargetTikz{Columb}'));
  assert.ok(tex.includes('\\AddToHook{begindocument/before}{\\RequirePackage[active,tightpage]{preview}\\PreviewEnvironment{tikzpicture}\\PreviewEnvironment{circuitikz}}'));
  assert.ok(tex.endsWith('\\input{test.tex}'));
  assert.ok(a.includes('-output-directory=/c/x') && a.includes('-jobname=thumb') && a.includes('-halt-on-error'));
  assert.ok(!a.some((x) => /shell-escape/.test(x)));
  assert.deepStrictEqual(T.cairoArgs('a.pdf', 'p'), ['-png', '-r', String(T.DPI), 'a.pdf', 'p']);
});

t('pages: in the order of the pages (1, 2, 10; also 01, 02), other files ignored, at most MAX_PAGES', () => {
  assert.deepStrictEqual(T.pages(['thumb-10.png', 'thumb-2.png', 'thumb-1.png', 'thumb.pdf', 'other-1.png'], 'thumb'), ['thumb-1.png', 'thumb-2.png', 'thumb-10.png']);
  assert.deepStrictEqual(T.pages(['thumb-02.png', 'thumb-01.png'], 'thumb'), ['thumb-01.png', 'thumb-02.png']);
  assert.strictEqual(T.pages(Array.from({ length: 9 }, (x, i) => 'thumb-' + (i + 1) + '.png'), 'thumb').length, T.MAX_PAGES);
});

t('keyOf changes with the time or the size of any file; folderOf is stable', () => {
  const s = [{ path: 'a', mtimeMs: 1000.4, size: 5 }, { path: 'b', mtimeMs: 7, size: 1 }];
  assert.strictEqual(T.keyOf(s), T.keyOf(s.map((x) => Object.assign({}, x))));
  assert.notStrictEqual(T.keyOf(s), T.keyOf([Object.assign({}, s[0], { mtimeMs: 2000 }), s[1]]));
  assert.notStrictEqual(T.keyOf(s), T.keyOf([s[0], Object.assign({}, s[1], { size: 2 })]));
  assert.strictEqual(T.folderOf('A/tikz/f.tikz'), T.folderOf('a/TIKZ/F.tikz'), 'case does not split a figure in two (Windows)');
});

t('logError: the first "! ..." line with the next one, or file:line: error', () => {
  assert.strictEqual(T.logError('x\n! Undefined control sequence.\nl.5 \\foo\nmore'), '! Undefined control sequence. l.5 \\foo');
  assert.strictEqual(T.logError('a\n./A/tikz/f.tikz:3: Package pgfkeys Error: I do not know the key\n\nz'), './A/tikz/f.tikz:3: Package pgfkeys Error: I do not know the key');
  assert.strictEqual(T.logError('all good'), '');
});

/* ---- tikzThumbs.js on a stub ---- */
function load(opts) {
  const conf = Object.assign({ driver: 'alone.tex', tikzThumbs: true }, opts.conf);
  const vs = {
    workspace: { isTrusted: opts.trusted !== false, getConfiguration: () => ({ get: (k, d) => (conf[k] !== undefined ? conf[k] : d) }) },
    Uri: { file: (p) => ({ fsPath: p, toString: () => 'file:///' + p.replace(/\\/g, '/') }) },
    MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(s) { this.value += '```' + s + '```'; return this; } },
    window: {}, commands: {}, languages: {}, Range: class {}, Position: class {}
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vs;
    if (req === './util') return { cfg: () => vs.workspace.getConfiguration(), run: opts.run };
    if (req === './filesAndLabels') return { legacySub: () => 'tikz' };
    return orig.call(this, req, ...rest);
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(ext) && /tikzThumbs\.js$/.test(k)) delete require.cache[k];
  try {
    const M = require(path.join(ext, 'tikzThumbs.js'));
    const storage = tmp('tss-thumbs-store-');
    M.register({ storageUri: { fsPath: storage } }, { log: () => {} });
    return { M, storage, vs };
  } finally { Module._load = orig; }
}
function project() {
  const root = tmp('tss-thumbs-proj-');
  fs.mkdirSync(path.join(root, 'A', 'tikz'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alone.tex'), '% driver');
  fs.writeFileSync(path.join(root, 'A', 'tikz', 'f.tikz'), '\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}');
  return { root, fig: path.join(root, 'A', 'tikz', 'f.tikz') };
}
const built = (M) => new Promise((resolve) => M._setOnBuilt((d) => resolve(d)));
// fake programs: lualatex writes thumb.pdf + aux files into -output-directory, pdftocairo writes <prefix>-1.png, -2.png
function fakeRun(calls, fail) {
  return async (cmd, args, o) => {
    calls.push([cmd, args, o && o.cwd]);
    if (cmd === 'lualatex') {
      const out = args.find((a) => a.startsWith('-output-directory=')).slice(18);
      if (fail) { fs.writeFileSync(path.join(out, 'thumb.log'), 'This is LuaTeX\n! Undefined control sequence.\nl.3 \\foo\n'); throw Object.assign(new Error('Command failed'), { code: 1 }); }
      for (const f of ['thumb.pdf', 'thumb.aux', 'thumb.log']) fs.writeFileSync(path.join(out, f), 'x');
      return '';
    }
    if (cmd === 'pdftocairo') { const prefix = args[args.length - 1]; fs.writeFileSync(prefix + '-1.png', 'p1'); fs.writeFileSync(prefix + '-2.png', 'p2'); return ''; }
    throw new Error('unexpected ' + cmd);
  };
}

t('stub: first hover queues a build (code + "building"), the next shows every page; only the pictures stay in the cache', async () => {
  const calls = [];
  const { M } = load({ run: fakeRun(calls) });
  const { root, fig } = project();
  assert.deepStrictEqual(M.status(root, path.join(root, 'main.tex')), { state: 'none' }, 'not a figure');
  const wait = built(M);
  assert.deepStrictEqual(M.status(root, fig), { state: 'building' });
  assert.deepStrictEqual(M.status(root, fig), { state: 'building' }, 'asked again while building: still one job');
  await wait;
  assert.deepStrictEqual(calls.map((c) => c[0]), ['lualatex', 'pdftocairo'], 'one build');
  assert.strictEqual(calls[0][2], root, 'lualatex runs in the root (the driver inputs X/tikz/name.tikz from there)');
  const st = M.status(root, fig);
  assert.strictEqual(st.state, 'ready');
  assert.deepStrictEqual(st.pngs.map((p) => path.basename(p)), ['thumb-1.png', 'thumb-2.png']);
  const dir = path.dirname(st.pngs[0]);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['key.txt', 'thumb-1.png', 'thumb-2.png'], 'the pdf, aux and log are removed');
  const md = M.hoverMd(root, fig, { value: '', appendMarkdown(s) { this.value += s; } });
  assert.strictEqual((md.value.match(/!\[\]\(file:/g) || []).length, 2, md.value);
  assert.ok(md.value.includes('**f.tikz**'));
});

t('stub: a change of the figure or of a .cls in the root makes the thumbnail stale (rebuilt in the same folder)', async () => {
  const calls = [];
  const { M } = load({ run: fakeRun(calls) });
  const { root, fig } = project();
  let wait = built(M); M.status(root, fig); await wait;
  const dir = path.dirname(M.status(root, fig).pngs[0]);
  fs.writeFileSync(fig, fs.readFileSync(fig, 'utf8') + '% more');
  wait = built(M);
  assert.deepStrictEqual(M.status(root, fig), { state: 'building' }, 'the figure changed');
  await wait;
  assert.strictEqual(path.dirname(M.status(root, fig).pngs[0]), dir, 'one folder per figure: no pile of old thumbnails');
  fs.writeFileSync(path.join(root, 'Book.cls'), '% class');
  wait = built(M);
  assert.deepStrictEqual(M.status(root, fig), { state: 'building' }, 'a class of the root appeared');
  await wait;
  assert.strictEqual(calls.filter((c) => c[0] === 'lualatex').length, 3);
});

t('stub: a failed build shows the first error of the log and is not retried until something changes', async () => {
  const calls = [];
  const { M } = load({ run: fakeRun(calls, true) });
  const { root, fig } = project();
  const wait = built(M); M.status(root, fig); await wait;
  const st = M.status(root, fig);
  assert.deepStrictEqual(st, { state: 'failed', msg: '! Undefined control sequence. l.3 \\foo' });
  M.status(root, fig);
  assert.strictEqual(calls.length, 1, 'not retried on every hover');
  const md = M.hoverMd(root, fig, { value: 'CODE', appendMarkdown(s) { this.value += s; } });
  assert.ok(md.value.startsWith('CODE') && md.value.includes('Undefined control sequence'), md.value);
});

t('stub: no driver in the root: failed with a message, lualatex not started', async () => {
  const calls = [];
  const { M } = load({ run: fakeRun(calls), conf: { driver: 'missing.tex' } });
  const { root, fig } = project();
  const wait = built(M); M.status(root, fig); await wait;
  assert.strictEqual(M.status(root, fig).state, 'failed');
  assert.ok(/missing\.tex/.test(M.status(root, fig).msg));
  assert.deepStrictEqual(calls, []);
});

t('stub: untrusted workspace or tikzThumbs = false: nothing is built, the hover keeps the code', async () => {
  for (const o of [{ trusted: false }, { conf: { tikzThumbs: false } }]) {
    const calls = [];
    const { M } = load(Object.assign({ run: fakeRun(calls) }, o));
    const { root, fig } = project();
    assert.deepStrictEqual(M.status(root, fig), { state: 'off' }, JSON.stringify(o));
    const md = M.hoverMd(root, fig, { value: 'CODE', appendMarkdown(s) { this.value += s; } });
    assert.strictEqual(md.value, 'CODE');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(calls, []);
  }
});

/* ---- a real build (only with TeX on PATH) ---- */
const has = (cmd, arg) => { try { execFileSync(cmd, [arg], { stdio: 'ignore', timeout: 20000 }); return true; } catch (e) { return false; } };
t('real: lualatex + preview + pdftocairo give one cropped picture per tikzpicture (skipped without TeX)', async () => {
  if (!has('lualatex', '--version') || !has('pdftocairo', '-v')) { console.log('skip: lualatex or pdftocairo is not on PATH'); return; }
  const { root, fig } = project();
  fs.writeFileSync(path.join(root, 'alone.tex'), '\\documentclass{article}\\usepackage{tikz}\\begin{document}\\input{\\TargetChapter/tikz/\\TargetTikz.tikz}\\end{document}');
  fs.writeFileSync(fig, '\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}\n\\begin{tikzpicture}\\draw (0,0) rectangle (3,1);\\end{tikzpicture}');
  const { run } = (() => { const cp = require('child_process'); return { run: (cmd, args, o) => new Promise((res, rej) => cp.execFile(cmd, args, Object.assign({ windowsHide: true, timeout: 120000 }, o), (e, so) => (e ? rej(e) : res(so)))) }; })();
  const { M } = load({ run });
  const wait = built(M); M.status(root, fig); await wait;
  const st = M.status(root, fig);
  assert.strictEqual(st.state, 'ready', JSON.stringify(st));
  assert.strictEqual(st.pngs.length, 2, 'two tikzpictures, two pictures');
  // a PNG: the signature, and the width of the IHDR chunk (cropped: the rectangle 3 cm is wider than the circle 2 cm, both far below a page)
  const width = (p) => { const b = fs.readFileSync(p); assert.strictEqual(b.slice(1, 4).toString(), 'PNG'); return b.readUInt32BE(16); };
  const [w1, w2] = st.pngs.map(width);
  assert.ok(w1 > 50 && w2 > w1 && w2 < 300, 'cropped widths ' + w1 + ', ' + w2);
});

let failed = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + String(e && e.stack || e).replace(/\n/g, '\n  ')); }
  }
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  console.log('\n' + n + ' tests passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
