'use strict';
/* Tests of the commands with an optional first argument (\newcommand{\E}[1][E]{...}): macrosPure.parseKatexOptMacros / toKatexOptMacros,
 * mathjaxFile.optMacros and media/katex/optmacros.js with the real KaTeX of the extension.
 * Run from the repository root: node tests/optMacros.test.js [extension] */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const Module = require('module');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const MP = require(path.join(EXT, 'macrosPure.js'));
const katex = require(path.join(EXT, 'media', 'katex', 'katex.min.js'));
const { makeVscode } = require('./vscodeStub');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const O = (t) => MP.parseKatexOptMacros(t);

// ---- the descriptions
eq(O('\\newcommand{\\E}[1][E]{\\mathbf{#1}}'), { '\\E': { n: 1, def: 'E', body: '\\mathbf{#1}' } });
eq(O('\\newcommand{\\diff}[2][]{\\frac{d#1}{d#2}}'), { '\\diff': { n: 2, def: '', body: '\\frac{d#1}{d#2}' } }, 'an empty default');
eq(O('\\newcommand\\E[1][E]{x}'), { '\\E': { n: 1, def: 'E', body: 'x' } }, 'no braces around the name');
eq(O('\\renewcommand*{\\E}[2][a b]{#1#2}'), { '\\E': { n: 2, def: 'a b', body: '#1#2' } }, 'renewcommand, starred, a default with a space');
eq(O('\\newcommand{\\a}[1]{x}\\newcommand{\\b}{y}\\newcommand{\\c}[2]{#1#2}'), {}, 'plain macros are not described (parseKatexMacros has them)');
eq(O('\\newcommand{\\E}[1][E]{x}\n\\newcommand{\\E}[1]{y}'), {}, 'a later plain definition removes the description');
eq(O('\\newcommand{\\E}[1][E]{x}\n\\def\\E{y}'), {}, 'a later \\def too');
eq(O('\\newcommand{\\E}[1]{y}\n\\renewcommand{\\E}[1][E]{x}'), { '\\E': { n: 1, def: 'E', body: 'x' } }, 'and a later description wins');
eq(O('\\newcommand{\\k}[1][a]{1}\n\\providecommand{\\k}[1][b]{2}'), { '\\k': { n: 1, def: 'a', body: '1' } }, 'providecommand does not replace');
eq(O('% \\newcommand{\\no}[1][x]{y}\n\\newcommand{\\yes}[1][x]{y} % \\newcommand{\\no2}[1][x]{y}'), { '\\yes': { n: 1, def: 'x', body: 'y' } }, 'comments');
eq(O('\\newcommand{\\pd}[2][]{\\frac{\\partial #1}%\n{\\partial #2}}'), { '\\pd': { n: 2, def: '', body: '\\frac{\\partial #1} {\\partial #2}' } }, 'a body over several lines');
eq(O(''), {}); eq(O(null), {});
eq(O('\\newcommand{\\broken}[1][x]{unclosed'), {}, 'an unclosed body: skipped');
// the macros of a class: through the form of the MathJax file
const cls = '\\newcommand{\\vect}[1]{\\symbf{#1}}\n\\newcommand{\\E}[1][E]{\\symbf{#1}}\n\\newcommand{\\diff}[2][]{\\frac{d#1}{d#2}}\n';
const fromCls = MP.toKatexOptMacros(MP.scanMacros(cls));
eq(Object.keys(fromCls).sort(), ['\\E', '\\diff'], 'only the ones with an optional first argument');
eq(fromCls['\\E'].body, '\\mathbf{#1}', 'the body is the MathJax one (\\symbf -> \\mathbf)');
ok(!('\\E' in MP.toKatexMacros(MP.scanMacros(cls))) && '\\vect' in MP.toKatexMacros(MP.scanMacros(cls)), 'toKatexMacros is as before');

// ---- the page script with the real KaTeX
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(EXT, 'media', 'katex', 'optmacros.js'), 'utf8'), sandbox, { filename: 'optmacros.js' });
const km = sandbox.window.tssKatexMacros;
ok(typeof km === 'function', 'window.tssKatexMacros');
const html = (tex, macros) => katex.renderToString(tex, { output: 'html', throwOnError: true, strict: 'ignore', macros: Object.assign({}, macros) });
const same = (tex, expected, macros, m) => eq(html(tex, macros), html(expected), (m || tex) + ' = ' + expected);
const M = km({ '\\E': { n: 1, def: 'E', body: '\\mathbf{#1}' }, '\\diff': { n: 2, def: '', body: '\\frac{d#1}{d#2}' }, '\\abs': '\\left|#1\\right|', '\\k3': 'x', '\\w': { n: 3, def: 'x', body: '[#1|#2|#3]' } });
eq(typeof M['\\E'], 'function', 'a description becomes a function'); eq(M['\\abs'], '\\left|#1\\right|', 'a string stays a string');
same('\\E', '\\mathbf{E}', M, 'the default');
same('\\E[B]', '\\mathbf{B}', M, 'the given argument');
same('\\E[B]^2 + \\E', '\\mathbf{B}^2 + \\mathbf{E}', M, 'inside a formula');
same('\\E {C}', '\\mathbf{E}{C}', M, 'a braced group after a macro with one argument is not its argument');
same('\\E[\\alpha x]', '\\mathbf{\\alpha x}', M, 'a control word in the argument');
same('\\E[\\alpha]', '\\mathbf{\\alpha}', M, 'a control word right before ]');
same('\\E[{a]b}]', '\\mathbf{{a]b}}', M, 'a bracket inside braces does not close it');
same('\\E[a b]', '\\mathbf{a b}', M, 'spaces');
same('\\diff{t}', '\\frac{d}{dt}', M, 'the default is empty, the other argument is taken');
same('\\diff[2]{t}', '\\frac{d2}{dt}', M, 'an optional and a mandatory argument');
same('\\diff[2]{\\tau} + \\abs{x}', '\\frac{d2}{d\\tau} + \\left|x\\right|', M, 'mixed with plain macros');
same('\\w{a}{b}', '[x|a|b]', M, 'three arguments, the default');
same('\\w[q]{a}{b}', '[q|a|b]', M, 'three arguments, the first is given');
same('\\frac{\\E[B]}{\\E}', '\\frac{\\mathbf{B}}{\\mathbf{E}}', M, 'inside other commands');
// a macro that is called twice in one formula, and the object is not changed
const before = JSON.stringify({ '\\E': { n: 1, def: 'E', body: '\\mathbf{#1}' } });
const input = { '\\E': { n: 1, def: 'E', body: '\\mathbf{#1}' } };
km(input); eq(JSON.stringify(input), before, 'the input is not changed');
same('\\E[1]\\E[2]\\E', '\\mathbf{1}\\mathbf{2}\\mathbf{E}', M, 'repeated');
// an optional argument that is not closed does not hang or crash the page: KaTeX reports an error (or draws something)
const t0 = Date.now();
let res = 'drawn';
try { html('\\E[B', M); } catch (e) { res = 'error'; }
ok(res === 'error' || res === 'drawn', 'no hang'); ok(Date.now() - t0 < 1000, 'quick: ' + (Date.now() - t0) + ' ms');
eq(Object.keys(km(null)).length, 0, 'null'); eq(JSON.stringify(km({ '\\a': 'b', '\\c': null })), JSON.stringify({ '\\a': 'b', '\\c': null }), 'other values are passed through (the object comes from another realm: compared as JSON)');
// without the helper the page falls back to a plain copy: a description is then not a macro KaTeX could use, but nothing throws
const fallback = (window0, macros) => (window0.tssKatexMacros || ((m) => Object.assign({}, m)))(macros);
ok(typeof fallback({}, { '\\a': 'b' }) === 'object', 'fallback');

// ---- the file lookup (mathjaxFile.js): descriptions of the macro files
function lookup(dir, folders, cfgValues, act) {
  const h = makeVscode('x', [[0, 0, 0, 0]], {}, cfgValues || {});
  h.vs.workspace.workspaceFolders = folders.map((f) => ({ uri: { fsPath: f } }));
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? h.vs : orig.call(this, req, ...rest); };
  for (const key of Object.keys(require.cache)) if (key.startsWith(EXT) && /\.js$/.test(key)) delete require.cache[key];
  try { return act(require(path.join(EXT, 'mathjaxFile.js')), { uri: { fsPath: path.join(dir, 'a.tex') } }); } finally { Module._load = orig; }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-opt-'));
try {
  const f = path.join(tmp, 'mathjax-macros.tex');
  fs.writeFileSync(f, '\\newcommand{\\grad}{\\nabla}\n\\newcommand{\\E}[1][E]{\\mathbf{#1}}\n\\newcommand{\\diff}[2][]{\\frac{d#1}{d#2}}\n');
  lookup(tmp, [tmp], {}, (MJ, doc) => {
    eq(MJ.macros(doc), { '\\grad': '\\nabla' }, 'macros(): as before, without the optional ones');
    eq(Object.keys(MJ.optMacros(doc)).sort(), ['\\E', '\\diff'], 'optMacros(): the commands with an optional first argument');
    eq(MJ.optMacros(doc)['\\E'], { n: 1, def: 'E', body: '\\mathbf{#1}' });
  });
  // two files: a plain definition in the later file removes the description of the earlier one, a description in the later file wins
  fs.mkdirSync(path.join(tmp, 'tex'));
  fs.writeFileSync(path.join(tmp, 'tex', 'm.tex'), '\\newcommand{\\E}[1]{\\mathrm{#1}}\n\\newcommand{\\diff}[2][x]{D}\n');
  lookup(tmp, [tmp], { mathjaxMacrosFile: 'mathjax-macros.tex', 'hover.preview.newcommand.newcommandFile': 'tex/m.tex' }, (MJ, doc) => {
    const o = MJ.optMacros(doc);
    eq(Object.keys(o), ['\\diff'], 'a plain \\E in the later file removes the description');
    eq(o['\\diff'], { n: 2, def: 'x', body: 'D' }, 'the later description wins');
    eq(MJ.macros(doc)['\\E'], '\\mathrm{#1}');
  });
  fs.writeFileSync(f, '');
  lookup(tmp, [tmp], {}, (MJ, doc) => eq(MJ.optMacros(doc), {}, 'an empty file'));
  lookup(tmp, [], {}, (MJ, doc) => eq(MJ.optMacros(doc), {}, 'no workspace folder: nothing, no crash'));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }


// ---- the wiring: both pages load the helper before their own script and call it where they hand macros to KaTeX
const rd = (...p) => fs.readFileSync(path.join(EXT, ...p), 'utf8');
for (const [mod, pageJs] of [['tableEditor.js', path.join('media', 'tableEditor', 'webview.js')], ['selectionPreview.js', path.join('media', 'selectionPreview', 'webview.js')]]) {
  const src = rd(mod);
  const a = src.indexOf('optmacros.js');
  ok(a > 0 && a < src.indexOf('webview.js'), mod + ': optmacros.js is loaded before the script of the page');
  ok(a > src.indexOf('katex.min.js'), mod + ': and after KaTeX');
  ok(/window\.tssKatexMacros/.test(rd(pageJs)), pageJs + ' uses window.tssKatexMacros');
}

// ---- all the way: tableEditor.katexMacros (what both pages receive) with a class and a macros file
function withTE(dir, cfgValues, cmds, act) {
  const h = makeVscode('x', [[0, 0, 0, 0]], {}, cfgValues || {});
  h.vs.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return h.vs;
    if (req === './macros') return { _allMacros: async () => ({ cmds, envs: new Map() }) };
    return orig.call(this, req, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(EXT) && /\.js$/.test(key)) delete require.cache[key];
  const doc = { uri: { fsPath: path.join(dir, 'a.tex'), toString: () => 'file://' + dir + '/a.tex' } };
  return Promise.resolve().then(() => act(require(path.join(EXT, 'tableEditor.js')), doc)).finally(() => { Module._load = orig; });
}
const clsCmds = new Map(MP.scanMacros(cls).filter((e) => e.kind !== 'env').map((e) => [e.name, e]));
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-opt2-'));
(async () => {
  try {
    // only the class: the plain macro is a string, the ones with an optional argument are descriptions
    let got = await withTE(tmp2, {}, clsCmds, (TE, doc) => TE.katexMacros(doc));
    eq(got['\\vect'], '\\mathbf{#1}');
    eq(got['\\E'], { n: 1, def: 'E', body: '\\mathbf{#1}' }, 'from the class: a description');
    eq(Object.keys(got).sort(), ['\\E', '\\diff', '\\vect']);
    const wire = JSON.parse(JSON.stringify(got)); // what travels to the page
    const page = km(wire);
    eq(html('\\E[B] + \\diff[2]{t} + \\vect{v}', page), html('\\mathbf{B} + \\frac{d2}{dt} + \\mathbf{v}'), 'the page draws what the class defines');
    // the macros file: new commands, and it wins over the class (a plain one over a description and the other way round)
    fs.writeFileSync(path.join(tmp2, 'mathjax-macros.tex'), '\\newcommand{\\E}[1]{\\mathrm{#1}}\n\\newcommand{\\vect}[1][v]{\\boldsymbol{#1}}\n\\newcommand{\\grad}{\\nabla}\n');
    got = await withTE(tmp2, {}, clsCmds, (TE, doc) => TE.katexMacros(doc));
    eq(got['\\E'], '\\mathrm{#1}', 'a plain definition of the file replaces the description of the class');
    eq(got['\\vect'], { n: 1, def: 'v', body: '\\boldsymbol{#1}' }, 'a description of the file replaces the plain macro of the class');
    eq(got['\\grad'], '\\nabla');
    eq(got['\\diff'], { n: 2, def: '', body: '\\frac{d#1}{d#2}' }, 'what the file does not mention stays');
    eq(html('\\E{x} \\vect \\vect[w]', km(JSON.parse(JSON.stringify(got)))), html('\\mathrm{x} \\boldsymbol{v} \\boldsymbol{w}'), 'drawn');
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
  console.log('optMacros: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

