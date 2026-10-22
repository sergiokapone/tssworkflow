'use strict';
/* macroGalleryPure.js: the data of the panel "Macro gallery" (no vscode dependency).
 *   exampleCalls(entry)   the calls that show a macro: \name{x}{y}, with the optional argument, with the star
 *   mathjaxState(...)     is the macro in mathjax-macros.tex: ok | differs | missing | skip (MathJax cannot say it) | nofile | na
 *   buildItems(...)       every macro of the project as a card: signature, comment, source, examples, flags */
const MP = require('./macrosPure');
const { tr } = require('./i18n');

const NAMES = ['x', 'y', 'z', 'u', 'v', 'w'];
const norm = (s) => String(s || '').replace(/\s+/g, '');

// [{ call, note }] : the first one is the plain call; then the call with the optional argument and with the star, when the macro has them
function exampleCalls(e) {
  if (e.kind === 'env') {
    const req = (toks) => toks.map((t, k) => (t.optional ? '' : (t.t === 'v' ? '|' + NAMES[k % 6] + '|' : (t.open || '{') + NAMES[k % 6] + (t.close === undefined ? '}' : t.close)))).join('');
    return [{ call: '\\begin{' + e.name + '}' + req(e.tokens || []) + ' … \\end{' + e.name + '}', note: '' }];
  }
  if (e.op) return [{ call: '\\' + e.name + ' f(x)', note: '' }].concat(e.starred ? [{ call: '\\' + e.name + '*_{n} f(x)', note: tr('зі зірочкою') }] : []);
  const toks = e.tokens || [];
  const build = (withOpt, withStar) => {
    let s = '\\' + e.name;
    toks.forEach((t, k) => {
      const arg = NAMES[k % 6];
      if (t.t === 's') { if (withStar) s += '*'; return; }
      if (t.optional) { if (withOpt && (t.t === 'o' || t.t === 'O' || t.t === 'd' || t.t === 'D')) s += (t.open || '[') + '2' + (t.close === undefined ? ']' : t.close); return; }
      if (t.t === 'v') { s += '|' + arg + '|'; return; }
      s += (t.open || '{') + arg + (t.close === undefined ? '}' : t.close);
    });
    return s;
  };
  const out = [{ call: build(false, false), note: '' }];
  if (toks.some((t) => t.optional && (t.t === 'o' || t.t === 'O' || t.t === 'd' || t.t === 'D'))) out.push({ call: build(true, false), note: tr('з необов’язковим аргументом') });
  if (toks.some((t) => t.t === 's')) out.push({ call: build(false, true), note: tr('зі зірочкою') });
  return out;
}

// mjInfo: { has: bool (a macros file exists), defs: Map name -> entry of the file, generated: Map name -> entry the generator would write, skipped: Set }
function mathjaxState(e, mjInfo) {
  if (e.kind !== 'cmd' || e.newif) return { st: 'na', note: '' };
  if (!mjInfo.has) return { st: 'nofile', note: tr('файла макросів MathJax ще немає') };
  const inFile = mjInfo.defs.get(e.name);
  if (inFile) {
    const g = mjInfo.generated.get(e.name);
    if (g && (norm(g.body) !== norm(inFile.body) || g.nargs !== inFile.nargs)) return { st: 'differs', note: tr('у файлі означення інше, ніж робить генератор') };
    return { st: 'ok', note: tr('є у файлі макросів MathJax') };
  }
  if (mjInfo.skipped.has(e.name)) return { st: 'skip', note: tr('MathJax цього не виразить (xparse, \\par, \\label, \\input…)') };
  return { st: 'missing', note: tr('немає у файлі макросів MathJax') };
}

// all: { cmds: Map, envs: Map } (macros.js allMacros); files: the source files in the order of the project
function buildItems(all, files, mjInfo, render) {
  const entries = [...all.cmds.values(), ...all.envs.values()].filter((e) => e.file);
  const rank = (f) => { const i = files.indexOf(f); return i < 0 ? 1e6 : i; };
  entries.sort((a, b) => (rank(a.file) - rank(b.file)) || (a.line - b.line));
  const items = entries.map((e, i) => {
    const examples = exampleCalls(e).map((x) => {
      let html = '';
      try { html = e.kind === 'env' ? render(x.call.replace(/ … /, ' Текст. ')) : render(x.call); } catch (err) { html = ''; }
      return { call: x.call, note: x.note, html, tex: e.kind === 'env' ? '' : x.call };
    });
    const mj = mathjaxState(e, mjInfo);
    return { i, kind: e.kind, name: e.name, sig: MP.signature(e), doc: e.doc || '', src: e.src || '', file: e.file, line: e.line + 1, op: !!e.op, alias: e.alias || '', theorem: !!e.theorem, examples, mj: mj.st, mjNote: mj.note };
  });
  return items;
}

// the macros file of MathJax: { has, defs, generated, skipped }; texts: [file text]
function mathjaxInfo(texts, entries) {
  const defs = new Map();
  for (const t of texts) for (const e of MP.scanMacros(t)) if (e.kind === 'cmd') defs.set(e.name, e);
  const gen = MP.toMathJaxMacros(entries);
  const generated = new Map(MP.scanMacros(gen.text).filter((e) => e.kind === 'cmd').map((e) => [e.name, e]));
  return { has: texts.length > 0, defs, generated, skipped: new Set(gen.skipped) };
}

module.exports = { exampleCalls, mathjaxState, buildItems, mathjaxInfo };
