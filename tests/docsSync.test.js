'use strict';
// node tests/docsSync.test.js [path/to/extension] [LaTeX-VSCode-setup.md]  - tests/docs-sync.js on copies of the reference
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), { spawnSync } = require('child_process');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const cands = [process.argv[3], path.join(__dirname, '..', 'LaTeX-VSCode-setup.md'), path.join(__dirname, '..', '..', 'LaTeX-VSCode-setup.md'), path.join(ext, '..', '..', 'LaTeX-VSCode-setup.md')].filter(Boolean);
const docPath = cands.find((p) => fs.existsSync(p));
if (!docPath) { console.log('skip: LaTeX-VSCode-setup.md not found'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-ds-'));
const sync = (doc, ...flags) => spawnSync(process.execPath, [path.join(__dirname, 'docs-sync.js'), ext, doc, ...flags], { encoding: 'utf8' });
const docTest = (doc) => spawnSync(process.execPath, [path.join(__dirname, 'docs.test.js'), ext, doc], { encoding: 'utf8' });
const copy = (name, edit) => { const p = path.join(tmp, name); const src = fs.readFileSync(docPath, 'utf8'); fs.writeFileSync(p, edit ? edit(src) : src); return p; };
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const dropLine = (re) => (s) => { const sep = s.includes('\r\n') ? '\r\n' : '\n'; const L = s.split(sep); const i = L.findIndex((l) => re.test(l)); assert.ok(i >= 0, 'the row to drop exists: ' + re); L.splice(i, 1); return L.join(sep); };

t('a reference in step: no difference, exit 0, and --write changes nothing', () => {
  const p = copy('same.md');
  const r = sync(p); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const before = fs.readFileSync(p, 'utf8');
  const w = sync(p, '--write'); assert.strictEqual(w.status, 0);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

t('a missing command row and a missing setting row are reported (exit 1) and by --write become stub rows; the counts are fixed', () => {
  const p = copy('gap.md', (s) => dropLine(/^\|\s*`[^`]+`\s*\|\s*`debugState`\s*\|/)(dropLine(/^\|\s*`wrapWidth`\s*\|\s*ціле\s*\|/)(s)).replace(/Усього (\d+) команд/, 'Усього 1 команд').replace(/Усього (\d+) ключів/, 'Усього 1 ключів'));
  const r = sync(p);
  assert.strictEqual(r.status, 1);
  for (const s of ['no row for wrapWidth', 'no row for debugState', 'settings count', 'commands count']) assert.ok(r.stdout.includes(s), 'reported: ' + s + '\n' + r.stdout);
  const w = sync(p, '--write'); assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  const out = fs.readFileSync(p, 'utf8');
  assert.strictEqual((out.match(/^\|.*ЗАПОВНИТИ ОПИС/gm) || []).length, 2, 'two stub rows (table rows; the prose may name the marker)');
  assert.ok(/\| `wrapWidth` \| ціле \| `90` \|/.test(out), 'the stub of the setting has the type and the default of package.json');
  assert.ok(/`debugState` \| — \| палітра команд \| \*\*ЗАПОВНИТИ ОПИС\*\* \| 0\.\d+\.\d+ \|/.test(out), 'the stub of the command');
  // after the fix only the stubs are wrong: the mismatch tests of docs.test.js pass, the stub test fails
  const d = docTest(p);
  assert.ok(/FAIL|Error|AssertionError/.test(d.stdout + d.stderr) && /ЗАПОВНИТИ ОПИС/.test(d.stdout + d.stderr), 'docs.test.js refuses a reference with stubs');
  assert.ok(!/section 8 lists exactly|section 7 lists exactly/.test((d.stdout + d.stderr).split('\n').filter((l) => /FAIL/.test(l)).join('\n')), 'the rows and the counts are right now');
  assert.strictEqual(sync(p).status, 0, 'idempotent: the second run finds nothing');
  // written descriptions make it pass
  const done = fs.readFileSync(p, 'utf8').replace(/\*\*ЗАПОВНИТИ ОПИС\*\*/g, 'Описано.');
  fs.writeFileSync(p, done);
  assert.strictEqual(docTest(p).status, 0, docTest(p).stdout + docTest(p).stderr);
});

t('a row of a setting that is gone is reported and never deleted', () => {
  const p = copy('gone.md', (s) => s.replace(/^(\|\s*`wrapWidth`\s*\|\s*ціле\s*\|)/m, '| `oldGoneKey` | булевий | `true` | — | Старий ключ. | 0.1.0 |\n$1'));
  const r = sync(p); assert.strictEqual(r.status, 1);
  assert.ok(/row of oldGoneKey is not in package\.json/.test(r.stdout));
  sync(p, '--write');
  assert.ok(fs.readFileSync(p, 'utf8').includes('`oldGoneKey`'), 'the hand-written row stays');
});

t('docs.test.js catches a stub row and a changelog row that landed in a table of section 7', () => {
  const p = copy('stub.md', (s) => s.replace(/^(\|\s*`wrapWidth`\s*\|\s*ціле\s*\|)/m, '| 0.19.2 | Рефакторинг без нових команд. | — | — | — | — |\n$1'));
  const d = docTest(p);
  assert.notStrictEqual(d.status, 0);
  assert.ok(/neither a setting nor a command|move it to section 10/.test(d.stdout + d.stderr), d.stdout + d.stderr);
});

console.log('\n' + n + ' tests passed');
