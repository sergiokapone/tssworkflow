'use strict';
// node tests/docs.test.js [path/to/extension] [LaTeX-VSCode-setup.md]  - the reference against package.json and the files of the extension
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const cands = [process.argv[3], path.join(__dirname, '..', 'LaTeX-VSCode-setup.md'), path.join(__dirname, '..', '..', 'LaTeX-VSCode-setup.md'), path.join(ext, '..', '..', 'LaTeX-VSCode-setup.md'), path.join(process.cwd(), 'LaTeX-VSCode-setup.md')].filter(Boolean);
const docPath = cands.find((p) => fs.existsSync(p));
if (!docPath) { console.log('skip: LaTeX-VSCode-setup.md not found (pass its path as the second argument)'); process.exit(0); }
const doc = fs.readFileSync(docPath, 'utf8').split('\n');
const pk = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const section = (from, to) => {
  const a = doc.findIndex((l) => l.startsWith(from)), b = doc.findIndex((l, i) => i > a && l.startsWith(to));
  assert.ok(a >= 0 && b > a, 'section ' + from + ' not found');
  return doc.slice(a, b);
};
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const props = {};
for (const blk of [].concat(pk.contributes.configuration)) Object.assign(props, blk.properties);
const keys = Object.keys(props).filter((k) => k.startsWith('tssworkflow.')).map((k) => k.slice(12));
const ids = pk.contributes.commands.map((c) => c.command.replace(/^tssworkflow\./, ''));

const s7 = section('## 7.', '## 8.');
// the keys of other extensions (ltex.*, workbench.*, latex-workshop.*) are explained in the same section; they are not ours
const settingRows = s7.filter((l) => /^\|\s*`[A-Za-z][A-Za-z0-9.]*`\s*\|/.test(l)).map(cells).filter((r) => !/^`(ltex|workbench)\./.test(r[0]));
const s8 = section('## 8.', '## 9.');
const cmdRows = s8.filter((l) => /^\|\s*`[^`]+`\s*\|\s*`[A-Za-z][A-Za-z0-9]*`\s*\|/.test(l)).map(cells);

t('section 8 lists exactly the commands of package.json, and the count in the text is right', () => {
  const documented = cmdRows.map((r) => r[1].replace(/`/g, ''));
  assert.deepStrictEqual(ids.filter((i) => !documented.includes(i)), [], 'in package.json, not in the reference');
  assert.deepStrictEqual(documented.filter((i) => !ids.includes(i)), [], 'in the reference, not in package.json');
  assert.strictEqual(new Set(documented).size, documented.length, 'a command is documented twice');
  const m = /Усього (\d+) команд/.exec(s8.join('\n'));
  assert.ok(m && +m[1] === ids.length, 'the text says ' + (m && m[1]) + ' commands, package.json has ' + ids.length);
});

t('section 7 lists exactly the settings of package.json, and the count in the text is right', () => {
  const documented = settingRows.map((r) => r[0].replace(/`/g, ''));
  assert.deepStrictEqual(keys.filter((k) => !documented.includes(k)), [], 'in package.json, not in the reference');
  assert.deepStrictEqual(documented.filter((k) => !keys.includes(k)), [], 'in the reference, not in package.json');
  const m = /Усього (\d+) ключів/.exec(s7.join('\n'));
  assert.ok(m && +m[1] === keys.length, 'the text says ' + (m && m[1]) + ' keys, package.json has ' + keys.length);
});

t('section 7: type and default of every setting match package.json', () => {
  const stem = { boolean: /булев/, string: /рядок/, integer: /ціл/, number: /числ|ціл/ };
  const bad = [];
  for (const r of settingRows) {
    const key = r[0].replace(/`/g, ''), p = props['tssworkflow.' + key];
    if (!p) continue;
    if (typeof p.type === 'string' && stem[p.type] && !stem[p.type].test(r[1])) bad.push(key + ': type ' + p.type + ' vs "' + r[1] + '"');
    const d = p.default;
    if (['boolean', 'number', 'string'].includes(typeof d)) {
      const doc = r[2].replace(/^`|`$/g, '').replace(/^["']|["']$/g, '');
      if (doc !== String(d)) bad.push(key + ': default ' + JSON.stringify(d) + ' vs "' + r[2] + '"');
    }
  }
  assert.deepStrictEqual(bad, []);
});

t('the reference names the current version', () => {
  const m = /з `package\.json` (\d+\.\d+\.\d+)/.exec(s8.join('\n'));
  assert.ok(m, 'section 8 should say "з `package.json` X.Y.Z"');
  assert.strictEqual(m[1], pk.version);
  assert.ok(doc.some((l) => l.startsWith('| ' + pk.version + ' |')), 'the changelog table of section 10 has no row for ' + pk.version);
});

t('every module of the extension is described in the reference', () => {
  const text = doc.join('\n');
  const missing = fs.readdirSync(ext).filter((f) => f.endsWith('.js')).filter((f) => !text.includes('`' + f + '`') && !text.includes('`' + f.replace(/\.js$/, '') + '`'));
  assert.deepStrictEqual(missing, []);
});

t('the reference does not mention modules that were renamed or removed (the changelog may)', () => {
  const log = new Set(section('## 10.', '## 11.'));
  const text = doc.filter((l) => !log.has(l)).join('\n');
  const stale = [...text.matchAll(/`((?:extra\d?|pure)(?:Pure)?\.js)`/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(stale)], []);
});

console.log('\n' + n + ' tests passed');
