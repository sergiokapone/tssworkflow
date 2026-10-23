'use strict';
// node tests/hygiene.test.js [path/to/extension]
// Static guards over the sources for three classes of mistakes that were found by accident:
//  1. a local name that hides a name imported from another module (0.20.0: `const debounce = (doc) => ...` hid util.debounce,
//     so the check while typing threw a TypeError on every keystroke and nobody noticed);
//  2. context.subscriptions passed as the `disposables` of a panel listener (every opening of a panel leaked 2-3 listeners,
//     each holding the closed webview) - panel listeners belong to util.panelScope;
//  3. an external program started without the time limit of util.run / util.execFileT (a hung git or latexdiff lived for ever).
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || require('./_ext'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const files = fs.readdirSync(ext).filter((f) => /\.js$/.test(f)).sort();
const raw = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ext, f), 'utf8')]));

// source with comments, strings and template literals blanked out (same length, same line breaks), so a regex sees only code
function code(src) {
  let out = '', i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? src.length : e; out += blank(src.slice(i, j)); i = j; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; out += blank(src.slice(i, j)); i = j; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; if (c !== '`' && src[j] === '\n') break; j++; }
      out += c + blank(src.slice(i + 1, j)) + (src[j] === c ? c : '');
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const clean = Object.fromEntries(files.map((f) => [f, code(raw[f])]));
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;

// names a module takes from another module of the extension: const { a, b: c } = require('./x'); const U = require('./x')
function importedNames(f) {
  const names = new Set();
  for (const m of raw[f].matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*'\.\/[^']+'\s*\)/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
    }
  }
  for (const m of raw[f].matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*'\.\/[^']+'\s*\)\s*(?:;|$)/gm)) names.add(m[1]);
  return names;
}
// declarations of `name` other than the import itself: const/let/var/function, function parameters, arrow parameters, catch (name)
function redeclarations(f, name) {
  const src = clean[f], hits = [];
  const esc = name.replace(/\$/g, '\\$');
  const add = (re, what) => { for (const m of src.matchAll(re)) hits.push(f + ':' + lineOf(src, m.index) + ' ' + what + ' ' + name); };
  add(new RegExp('\\b(?:const|let|var)\\s+' + esc + '\\b(?!\\s*=\\s*require\\()', 'g'), 'declares');
  add(new RegExp('\\b(?:const|let|var)\\s*\\{[^}]*(?:\\b|:\\s*)' + esc + '\\b[^}]*\\}\\s*=(?!\\s*require\\()', 'g'), 'destructures');
  add(new RegExp('\\bfunction\\s+' + esc + '\\b', 'g'), 'function');
  add(new RegExp('\\bcatch\\s*\\(\\s*' + esc + '\\s*\\)', 'g'), 'catch');
  const paramHit = (m) => {
    const params = m[1].split(',').map((p) => p.replace(/=.*/, '').replace(/^\.\.\./, '').trim());
    if (params.includes(name)) hits.push(f + ':' + lineOf(src, m.index) + ' parameter ' + name);
  };
  for (const m of src.matchAll(/\bfunction\b[^(\n]*\(([^()]*)\)/g)) paramHit(m);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) paramHit(m);
  add(new RegExp('(?<![\\w$.])' + esc + '\\s*=>', 'g'), 'arrow parameter');
  return hits;
}

t('no local name hides a name imported from another module of the extension', () => {
  const bad = [];
  for (const f of files) for (const nm of importedNames(f)) bad.push(...redeclarations(f, nm));
  assert.deepStrictEqual(bad, [], 'a local name hides an import:\n  ' + bad.join('\n  '));
});

t('the shadowing check sees the 0.20.0 bug (mutation: the old local `debounce` is put back)', () => {
  const f = 'filesAndLabels.js';
  assert.ok(importedNames(f).has('debounce'), 'filesAndLabels.js imports debounce from util');
  const saved = clean[f];
  try {
    clean[f] = saved.replace(/const refreshLabels = \(doc\) =>/, 'const debounce = (doc) =>');
    assert.notStrictEqual(clean[f], saved, 'the mutation applies (refreshLabels still exists)');
    assert.ok(redeclarations(f, 'debounce').length >= 1, 'the old shadowing would be reported');
  } finally { clean[f] = saved; }
  // and other shapes: a parameter, a destructuring, a function declaration
  const probe = (s) => { clean['__probe.js'] = code(s); return redeclarations('__probe.js', 'debounce'); };
  assert.ok(probe('function a(debounce) { return 1; }').length, 'parameter');
  assert.ok(probe('const f = (x, debounce) => x;').length, 'arrow parameter list');
  assert.ok(probe('const { debounce } = other;').length, 'destructuring');
  assert.ok(probe('function debounce() {}').length, 'function declaration');
  assert.ok(probe("const s = 'const debounce = 1'; // const debounce = 2").length === 0, 'strings and comments are not code');
  delete clean['__probe.js'];
});

const panelFiles = () => files.filter((f) => /createWebviewPanel\(/.test(clean[f]));
const FOUR = ['formulaOverview.js', 'macroGallery.js', 'selectionPreview.js', 'tableEditor.js'];

t('the four panels are built by webviewKit.createPanelController; only webviewKit.js (and the one-off pictures panel) call createWebviewPanel', () => {
  assert.deepStrictEqual(panelFiles(), ['saveAndPictures.js', 'webviewKit.js']);
  for (const f of FOUR) {
    assert.ok(/\bK\.createPanelController\(/.test(clean[f]), f + ' builds its panel with K.createPanelController');
    assert.ok(!/^let (?:panel|ready|seq)\b/m.test(clean[f]), f + ' keeps no panel / ready / seq of its own: they live in the controller');
  }
  // the controller is the one place that wires the listeners to the panel: panelScope, and no extension-wide list
  assert.ok(/\bpanelScope\(/.test(clean['webviewKit.js']), 'the controller uses util.panelScope');
});

t('context.subscriptions is never the `disposables` argument of a listener of a webview (any module that touches a webview)', () => {
  const bad = [];
  for (const f of files.filter((x) => /\bwebview\b|WebviewPanel/.test(clean[x]))) {
    for (const m of clean[f].matchAll(/,\s*(?:null|undefined)\s*,\s*(?:\w+\.)?subscriptions\b/g)) bad.push(f + ':' + lineOf(clean[f], m.index));
    for (const m of clean[f].matchAll(/\.on(?:DidReceiveMessage|DidChangeViewState|DidDispose)\s*\([^;]*?\bcontext\.subscriptions\b/gs)) bad.push(f + ':' + lineOf(clean[f], m.index) + ' (listener of a panel)');
  }
  assert.deepStrictEqual(bad, [], 'a panel listener in the extension-wide list leaks until the extension stops:\n  ' + bad.join('\n  '));
});

t('the panel guard sees the old leak (mutation)', () => {
  const bad = (s) => [...code(s).matchAll(/,\s*(?:null|undefined)\s*,\s*(?:\w+\.)?subscriptions\b/g)].length;
  assert.strictEqual(bad('panel.onDidDispose(() => {}, null, context.subscriptions);'), 1);
  assert.strictEqual(bad('panel.webview.onDidReceiveMessage(fn, null, subs);'), 0);
});

t('external programs are started only through util.js (execFileT / run: a time limit by default)', () => {
  const bad = [];
  for (const f of files.filter((x) => x !== 'util.js')) {
    for (const m of clean[f].matchAll(/\b(?:execFile|execFileSync|exec|execSync|spawnSync)\s*\(/g)) {
      // vscode.commands.executeCommand etc. do not match: the name must stand alone; .exec( of a RegExp is not a process
      const before = clean[f].slice(Math.max(0, m.index - 1), m.index);
      if (before === '.' && !/\bcp\.$/.test(clean[f].slice(Math.max(0, m.index - 3), m.index))) continue;
      bad.push(f + ':' + lineOf(clean[f], m.index) + ' ' + m[0]);
    }
  }
  assert.deepStrictEqual(bad, [], 'start the program with util.execFileT / util.run:\n  ' + bad.join('\n  '));
});

t('the only other use of child_process is the detached PDF viewer in build.js (cp.spawn)', () => {
  const users = files.filter((f) => /require\(\s*'child_process'\s*\)/.test(raw[f])).sort();
  assert.deepStrictEqual(users, ['build.js', 'util.js']);
  const spawns = files.filter((f) => /\bcp\.spawn\(/.test(clean[f]));
  assert.deepStrictEqual(spawns, ['build.js']);
  assert.ok(/detached:\s*true/.test(raw['build.js']), 'the viewer is detached');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + String(e.message).replace(/\n/g, '\n  ')); }
}
console.log('\n' + n + ' tests passed' + (failed ? ', ' + failed + ' FAILED' : ''));
process.exit(failed ? 1 : 0);
