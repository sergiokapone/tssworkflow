'use strict';
// node tests/manifest.test.js [path/to/extension]  - package.json against the code: commands, settings, menus, files, activation events
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || require('./_ext'));
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

t('every command has the category "TSS Workflow" and a title without that prefix (menus show the title alone, the palette adds the category)', () => {
  const bad = c.commands.filter((x) => x.category !== 'TSS Workflow' || /^TSS Workflow/.test(x.title)).map((x) => x.command);
  assert.deepStrictEqual(bad, []);
});

t('the context menu of the editor stays short: its own items only when they fit (selection, a table), the rest in the submenu', () => {
  const ctx = c.menus['editor/context'];
  assert.ok(ctx.length <= 6, 'editor/context has ' + ctx.length + ' items: put the new one into tssworkflow.submenu.context');
  for (const x of ctx) {
    if (x.submenu) { assert.strictEqual(x.submenu, 'tssworkflow.submenu.context'); continue; }
    assert.ok(/editorHasSelection|tssworkflow\.inTable/.test(x.when || ''), x.command + ' is always shown: give it a condition or move it into the submenu');
  }
  const sub = c.menus['tssworkflow.submenu.context'];
  const orders = sub.map((x) => x.group);
  assert.strictEqual(new Set(orders).size, orders.length, 'two items of the submenu have the same group@order');
});

t('the minimum version of VS Code in README.md is that of engines (README said 1.60 long after engines became ^1.74.0)', () => {
  const readme = fs.readdirSync(ext).find((f) => /^readme\.md$/i.test(f));
  if (!readme) return; // the packaged tree may have none
  const min = /(\d+\.\d+)/.exec(pk.engines.vscode)[1];
  const said = [...fs.readFileSync(path.join(ext, readme), 'utf8').matchAll(/VS Code (\d+\.\d+)(?:\.0)? or newer/g)].map((x) => x[1]);
  assert.ok(said.length > 0, readme + ' does not say "VS Code X.Y or newer"');
  assert.deepStrictEqual([...new Set(said)], [min], readme + ' vs engines.vscode ' + pk.engines.vscode);
});

t('JSON files of the extension are valid', () => {
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'katex' || e.name.startsWith('.')) continue; /* .git, .vscode-test (a downloaded VS Code), .github: not the extension */ const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.json$/.test(e.name)) found.push(p); } };
  walk(ext);
  assert.ok(found.length >= 3);
  for (const f of found) JSON.parse(fs.readFileSync(f, 'utf8'));
});

console.log('\n' + n + ' tests passed');
