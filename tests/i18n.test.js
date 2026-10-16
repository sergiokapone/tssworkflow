'use strict';
// node tests/i18n.test.js [path/to/extension]
// i18n.js and i18nEn.js: the language of the messages; every tr('...') of the code has its English text, the placeholders agree, nothing is unused.
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const I = require(path.join(ext, 'i18n'));
const EN = require(path.join(ext, 'i18nEn'));
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  ' + name); } finally { I.setLang('uk'); } };
const unescape = (lit) => lit.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t' }[c] || c));

// every tr('...') call of the code: the key (the Ukrainian text) and the file
const sources = fs.readdirSync(ext).filter((f) => /\.js$/.test(f) && f !== 'i18n.js' && f !== 'i18nEn.js');
const used = new Map(), dynamic = [];
for (const f of sources) {
  const text = fs.readFileSync(path.join(ext, f), 'utf8');
  for (const m of text.matchAll(/(?<![\w.$])tr\(\s*('(?:[^'\\\n]|\\.)*')?/g)) {
    if (m[1]) used.set(unescape(m[1].slice(1, -1)), f);
    else dynamic.push(f + ': ' + text.slice(m.index, m.index + 40).replace(/\n/g, ' '));
  }
}
const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join(' ');
const cyr = /[А-Яа-яІіЇїЄєҐґ]/;

t('tr: Ukrainian is the key, placeholders are filled, a missing argument stays, $ in an argument is harmless', () => {
  I.setLang('uk');
  assert.strictEqual(I.getLang(), 'uk');
  assert.strictEqual(I.tr('Знімок відновлено: {0} файлів.', 3), 'Знімок відновлено: 3 файлів.');
  assert.strictEqual(I.tr('Перейменувати розділ «{0}» → «{1}»? Папка {0}/ і файл {0}.tex перейменуються; ', 'A', 'B'), 'Перейменувати розділ «A» → «B»? Папка A/ і файл A.tex перейменуються; ');
  assert.strictEqual(I.tr('Відновити'), 'Відновити');
  assert.strictEqual(I.tr('{0} і {1}', 'x'), 'x і {1}');
  assert.strictEqual(I.tr('Збірка частин: {0}', '$& $1 {1}'), 'Збірка частин: $& $1 {1}');
  assert.strictEqual(I.tr('якийсь текст без перекладу'), 'якийсь текст без перекладу');
});

t('setLang: uk, en, auto (English unless VS Code is Ukrainian), anything else is uk', () => {
  assert.strictEqual(I.setLang('en', 'uk'), 'en');
  assert.strictEqual(I.setLang('uk', 'en'), 'uk');
  assert.strictEqual(I.setLang('auto', 'uk'), 'uk');
  assert.strictEqual(I.setLang('auto', 'UK-UA'), 'uk');
  assert.strictEqual(I.setLang('auto', 'en'), 'en');
  assert.strictEqual(I.setLang('auto', 'de'), 'en');
  assert.strictEqual(I.setLang('auto', undefined), 'en');
  assert.strictEqual(I.setLang('xx', 'en'), 'uk');
  assert.strictEqual(I.setLang(undefined, 'en'), 'uk');
});

t('tr in English: the translation, with the arguments; a key without a translation stays Ukrainian; the Ukrainian mode ignores the dictionary', () => {
  I.setLang('en');
  assert.strictEqual(I.tr('Знімок відновлено: {0} файлів.', 3), 'Snapshot restored: 3 files.');
  assert.strictEqual(I.tr('Замінити'), 'Replace');
  assert.strictEqual(I.tr('щось нове без перекладу {0}', 1), 'щось нове без перекладу 1');
  I.setLang('uk');
  assert.strictEqual(I.tr('Замінити'), 'Замінити');
});

t('every tr(\'...\') of the code has its English text (the keys are written in the code as plain literals, so that this check sees them)', () => {
  assert.ok(used.size > 100, 'the keys are found: ' + used.size);
  const allowed = dynamic.filter((d) => !/^projectRefactor(Pure)?\.js: tr\((r\.name|v\.label|t\.v\.label)\)/.test(d)); // the names and labels of the built-in groups of notation, see the next test
  assert.deepStrictEqual(allowed, [], 'tr() with something other than a literal in the first place: ' + allowed.join('; '));
  const missing = [...used.keys()].filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
  assert.deepStrictEqual(missing, [], 'no English text for: ' + missing.map((k) => JSON.stringify(k.slice(0, 60))).join(', '));
});

const builtIn = () => {
  const X = require(path.join(ext, 'projectRefactorPure'));
  return X.NOTATION_DEFAULT.flatMap((g) => [g.name].concat(g.variants.map((v) => v.label))).filter((s) => cyr.test(s));
};
t('the Ukrainian names of the built-in groups of notation and of their variants (shown through tr(r.name), tr(v.label)) have English texts', () => {
  const names = builtIn();
  assert.ok(names.length >= 4, names.join('|'));
  for (const s of names) assert.ok(EN[s], 'no English text for the group: ' + s);
});

t('the dictionary has no unused key (a key that nothing asks for is a leftover of a changed message)', () => {
  const groupNames = new Set(builtIn());
  const unused = Object.keys(EN).filter((k) => !used.has(k) && !groupNames.has(k));
  assert.deepStrictEqual(unused, [], 'unused keys: ' + unused.map((k) => JSON.stringify(k.slice(0, 60))).join(', '));
});

t('the placeholders of a translation are those of its key; no translation is empty or the same as the key; no Ukrainian text left except the examples of Ukrainian words', () => {
  for (const [k, v] of Object.entries(EN)) {
    assert.strictEqual(ph(v), ph(k), 'placeholders differ: ' + JSON.stringify(k.slice(0, 60)));
    assert.ok(typeof v === 'string' && v.trim() && v !== k, 'empty or untranslated: ' + JSON.stringify(k.slice(0, 60)));
    if (cyr.test(v)) assert.ok(/напруженість \/ напруженості/.test(v), 'Ukrainian left in the translation: ' + JSON.stringify(v.slice(0, 80)));
    assert.strictEqual(/^\s/.test(v), /^\s/.test(k), 'a leading space is kept: ' + JSON.stringify(k.slice(0, 40)));
    assert.strictEqual(/\s$/.test(v), /\s$/.test(k), 'a trailing space is kept: ' + JSON.stringify(k.slice(0, 40)));
    assert.strictEqual((v.match(/\n/g) || []).length, (k.match(/\n/g) || []).length, 'the line breaks of a report are kept: ' + JSON.stringify(k.slice(0, 40)));
  }
});

t('the buttons that the code compares with the answer differ from each other in English too (Replace / Restore / Rename / Add ...)', () => {
  const buttons = ['Зберегти все', 'Відновити', 'Перейменувати', 'Замінити', 'Показати список', 'Нормалізувати', 'Додати', 'Уточнити форми…', 'Відкрити'];
  const en = buttons.map((b) => EN[b]);
  assert.ok(en.every(Boolean), en.join(','));
  assert.strictEqual(new Set(en).size, en.length, en.join(', '));
});

t('the setting tssworkflow.language: uk (default), en, auto; extension.js applies it at activation and when it changes', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
  const props = Array.isArray(pkg.contributes.configuration) ? Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties)) : pkg.contributes.configuration.properties;
  const st = props['tssworkflow.language'];
  assert.ok(st, 'the setting is in package.json');
  assert.deepStrictEqual([st.default, st.enum], ['uk', ['uk', 'en', 'auto']]);
  assert.ok(st.enumDescriptions && st.enumDescriptions.length === 3);
  const code = fs.readFileSync(path.join(ext, 'extension.js'), 'utf8');
  assert.ok(/get\('language', 'uk'\)/.test(code) && /vscode\.env\.language/.test(code), 'the setting and the language of VS Code are read');
  assert.ok(/affectsConfiguration\('tssworkflow\.language'\)/.test(code), 'a change of the setting is applied without a reload');
});

console.log(n + ' tests passed');
