'use strict';
// node tests/packaging.test.js [path/to/extension]
// What goes into the .vsix: .vscodeignore must not remove anything the extension needs at run time.
// 0.20.0 shipped without build.js (a leftover line `build.js` in .vscodeignore) and died with "Cannot find module './build'"
// on activation, although every other test passed, because they run on the source folder, where the file exists.
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ---- a small .vscodeignore matcher (a pattern without a slash matches at any depth: stricter than vsce, so it can only over-report) ---- */
function toRegex(pat) {
  let p = pat.trim();
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  const slashFree = !p.includes('/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + (slashFree && !anchored ? '(?:.*/)?' : '') + re + '$');
}
function parseIgnore(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const neg = l.startsWith('!');
    return { neg, re: toRegex(neg ? l.slice(1) : l), src: l };
  });
}
// a path is ignored when it, or one of its parent folders, matches (the last matching rule wins, as for negations)
function ignoredBy(rules, rel) {
  const parts = rel.split('/');
  let by = null;
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    for (const r of rules) if (r.re.test(sub)) by = r.neg ? null : r.src;
  }
  return by;
}
const walk = (dir, base) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const rel = base ? base + '/' + d.name : d.name;
  return d.isDirectory() ? (d.name === 'node_modules' || d.name === '.git' ? [] : walk(path.join(dir, d.name), rel)) : [rel];
});

const ignoreFile = [path.join(ext, '.vscodeignore'), path.join(ext, '..', '..', '.vscodeignore'), path.join(ext, '..', '.vscodeignore'), path.join(process.cwd(), '.vscodeignore')].find((p) => fs.existsSync(p));
const pk = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const all = walk(ext, '');
const posix = (p) => p.split(path.sep).join('/');

// the files the extension needs: main and everything reachable by a relative require, every path written in package.json, the resource folders
function needed() {
  const need = new Map(); // file -> why
  const main = posix(path.normalize(pk.main)).replace(/^\.\//, '');
  const queue = [[main, 'package.json "main"']];
  while (queue.length) {
    const [f, why] = queue.shift();
    if (need.has(f)) continue;
    need.set(f, why);
    if (!/\.js$/.test(f) || !fs.existsSync(path.join(ext, f))) continue;
    const src = fs.readFileSync(path.join(ext, f), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
      let r = posix(path.normalize(path.join(path.dirname(f), m[1])));
      if (!/\.\w+$/.test(r)) r += '.js';
      queue.push([r, 'required by ' + f]);
    }
  }
  const strings = [];
  (function visit(v) { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(visit); })(pk);
  for (const s of strings) {
    const rel = s.replace(/^\.\//, '');
    if (/^[\w./@-]+\.\w+$/.test(rel) && fs.existsSync(path.join(ext, rel)) && fs.statSync(path.join(ext, rel)).isFile()) need.set(rel, need.get(rel) || 'named in package.json');
  }
  for (const dir of ['media', 'snippets', 'syntaxes', 'templates']) {
    for (const f of all.filter((x) => x.startsWith(dir + '/'))) need.set(f, need.get(f) || 'resource folder ' + dir + '/');
  }
  return need;
}

t('.vscodeignore is found (otherwise this test proves nothing)', () => {
  if (!ignoreFile) { console.log('WARN no .vscodeignore next to ' + ext + ': packaging is NOT checked'); return; }
  assert.ok(parseIgnore(fs.readFileSync(ignoreFile, 'utf8')).length > 0, ignoreFile + ' has no rules');
});

t('nothing the extension needs at run time is removed by .vscodeignore', () => {
  if (!ignoreFile) return;
  const rules = parseIgnore(fs.readFileSync(ignoreFile, 'utf8'));
  const lost = [];
  for (const [f, why] of needed()) {
    if (!fs.existsSync(path.join(ext, f))) continue; // a missing file is the business of modules.test.js
    const by = ignoredBy(rules, f);
    if (by) lost.push(f + '  (' + why + ') is removed by the rule "' + by + '"');
  }
  assert.deepStrictEqual(lost, [], 'the packaged extension would fail to load:\n  ' + lost.join('\n  '));
});

t('the matcher itself: root-relative folders, slash-free names at any depth, negations', () => {
  const r = parseIgnore('tests/**\n*.vsix\n**/*.map\nbuild.js\n!keep.vsix\n[Content_Types].xml');
  assert.ok(ignoredBy(r, 'tests/a/b.js'));
  assert.ok(ignoredBy(r, 'x.vsix') && !ignoredBy(r, 'keep.vsix'));
  assert.ok(ignoredBy(r, 'media/a.js.map'));
  assert.ok(ignoredBy(r, 'build.js') && ignoredBy(r, 'sub/build.js'));
  assert.ok(ignoredBy(r, '[Content_Types].xml'));
  assert.ok(!ignoredBy(r, 'buildLog.js') && !ignoredBy(r, 'media/katex/katex.min.js'));
});

t('the matcher catches the 0.20.0 mistake: a module required by extension.js listed in .vscodeignore', () => {
  const rules = parseIgnore('.vscode/**\nbuild.js\ntests/**');
  assert.ok(ignoredBy(rules, 'build.js'), 'build.js would be dropped');
  assert.ok(!ignoredBy(parseIgnore('.vscode/**\ntests/**'), 'build.js'));
});

t('every file the code requires exists in the folder (the same check on the packaged tree)', () => {
  const missing = [];
  for (const [f, why] of needed()) if (!fs.existsSync(path.join(ext, f))) missing.push(f + ' (' + why + ')');
  assert.deepStrictEqual(missing, []);
});

let failed = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + String(e.message).replace(/\n/g, '\n  ')); }
  }
  console.log('\n' + n + ' tests passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
