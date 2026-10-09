'use strict';
// node tests/manifest.test.js [path/to/extension]  - package.json against the code: commands, settings, menus, files, activation events
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const pk = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const c = pk.contributes;
const code = fs.readdirSync(ext).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(ext, f), 'utf8')).join('\n');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const declared = new Set(c.commands.map((x) => x.command));
const quoted = (s) => code.includes("'" + s + "'") || code.includes('"' + s + '"');

t('every declared command is used in the code (registered or called)', () => {
  const lost = [...declared].filter((id) => !quoted(id));
  assert.deepStrictEqual(lost, [], 'declared in package.json, but never mentioned in the code');
});

t('every public command registered in the code is declared in package.json', () => {
  const reg = [...code.matchAll(/(?:registerCommand|registerTextEditorCommand|\bcmd)\(\s*'(tssworkflow\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]);
  assert.ok(reg.length > 50, 'found only ' + reg.length + ' registrations: the pattern is out of date');
  // tssworkflow._name are internal helpers (called from the code or from links), they are not meant for the palette
  assert.deepStrictEqual([...new Set(reg)].filter((id) => !declared.has(id) && !id.startsWith('tssworkflow._')), []);
});

t('menus, keybindings, views and welcome links point at declared commands', () => {
  const refs = new Set();
  const walk = (o, key) => {
    if (typeof o === 'string') {
      if (key === 'command') refs.add(o.replace(/^command:/, '').replace(/[?#].*$/, ''));
      for (const m of o.matchAll(/command:(tssworkflow\.[A-Za-z0-9_.]+)/g)) refs.add(m[1]);
    } else if (Array.isArray(o)) o.forEach((x) => walk(x, key));
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], k);
  };
  walk({ menus: c.menus, keybindings: c.keybindings, viewsWelcome: c.viewsWelcome });
  const own = [...refs].filter((id) => id.startsWith('tssworkflow.'));
  assert.ok(own.length > 10);
  assert.deepStrictEqual(own.filter((id) => !declared.has(id)), []);
});

t('settings: every declared tssworkflow.* key is read, and every key the code reads is declared', () => {
  const props = {};
  for (const blk of [].concat(c.configuration)) Object.assign(props, blk.properties);
  const keys = Object.keys(props).filter((k) => k.startsWith('tssworkflow.')).map((k) => k.slice('tssworkflow.'.length));
  const unread = keys.filter((k) => !quoted(k));
  assert.deepStrictEqual(unread, [], 'declared but never mentioned in the code');
  const read = [...code.matchAll(/(?:\bcfg\(\)|getConfiguration\('tssworkflow'\))\s*\.(?:get|update|inspect)\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(read.length > 30, 'found only ' + read.length + ' reads: the pattern is out of date');
  assert.deepStrictEqual([...new Set(read)].filter((k) => !keys.includes(k)), []);
});

t('activationEvents hold no onCommand: / onView: (VS Code generates them from contributes since 1.74)', () => {
  const m = /^\^?(\d+)\.(\d+)/.exec(pk.engines.vscode);
  assert.ok(+m[1] > 1 || +m[2] >= 74, 'engines.vscode is older than 1.74');
  assert.deepStrictEqual((pk.activationEvents || []).filter((e) => /^on(Command|View):/.test(e)), []);
});

t('every file that package.json points at exists', () => {
  const files = [pk.main];
  const walk = (o, key) => {
    if (typeof o === 'string' && /^(path|configuration|icon|light|dark|image)$/.test(key || '') && /\.[A-Za-z0-9]+$/.test(o) && !/^\$\(/.test(o)) files.push(o);
    else if (Array.isArray(o)) o.forEach((x) => walk(x, key));
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], k);
  };
  walk({ g: c.grammars, s: c.snippets, l: c.languages, vc: c.viewsContainers, v: c.views, i: c.icons });
  assert.ok(files.length > 3);
  const missing = files.filter((f) => !fs.existsSync(path.join(ext, f)));
  assert.deepStrictEqual(missing, []);
});

t('JSON files of the extension are valid', () => {
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'katex') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.json$/.test(e.name)) found.push(p); } };
  walk(ext);
  assert.ok(found.length >= 3);
  for (const f of found) JSON.parse(fs.readFileSync(f, 'utf8'));
});

console.log('\n' + n + ' tests passed');
