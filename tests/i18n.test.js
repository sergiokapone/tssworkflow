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


// the build and the log (0.21.1): logPure.js speaks the language too, and what the code recognizes in a message works in both
const L = require(path.join(ext, 'logPure'));
const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
t('logPure in English and in Ukrainian: the passes, the messages of the parser of the log, the hint for pgf layers, the report of texlogsieve', () => {
  const log = '(./A.tex\nOverfull \\hbox (12.5pt too wide) in paragraph at lines 3--4\nLaTeX Warning: Reference `eq:x\' on page 1 undefined on input line 7.\n)\n';
  const entries = [{ kind: 'Error', file: 'A.tex', line: 1, message: 'Oops' }, { kind: 'Warning', file: 'A.tex', line: 2, message: 'W' }];
  const run = (lang) => {
    I.setLang(lang);
    return { pass: [1, 2, 5].map(L.passWord), log: L.parseLog(log, 1).map((x) => x.message), hint: L.logHint("graphics layer 'bg' is not defined"), rep: strip(L.formatTexlogsieveReport(entries, { outside: 3 }).join('\n')) };
  };
  const uk = run('uk'), en = run('en');
  assert.deepStrictEqual(uk.pass, ['прохід', 'проходи', 'проходів']);
  assert.deepStrictEqual(en.pass, ['pass', 'passes', 'passes']);
  assert.deepStrictEqual(uk.log, ['Overfull \\hbox: 12.5pt завширшки', 'Невизначене посилання «eq:x» (за логом LaTeX)']);
  assert.deepStrictEqual(en.log, ['Overfull \\hbox: 12.5pt too wide', 'Undefined reference “eq:x” (from the LaTeX log)']);
  assert.strictEqual(uk.hint, 'Оголоси шар і додай його в список: \\pgfdeclarelayer{bg} \\pgfsetlayers{bg, background, bg, main}', 'the braces of {{0}} stay');
  assert.strictEqual(en.hint, 'Declare the layer and add it to the list: \\pgfdeclarelayer{bg} \\pgfsetlayers{bg, background, bg, main}');
  assert.ok(uk.rep.includes('помилок: 1 · попереджень: 1') && uk.rep.includes('ПОМИЛКИ (1)') && uk.rep.includes('(ще 3 попереджень'), uk.rep);
  assert.ok(en.rep.includes('errors: 1 · warnings: 1') && en.rep.includes('ERRORS (1)') && en.rep.includes('WARNINGS (1)') && en.rep.includes('(3 more warnings'), en.rep);
  assert.ok(!cyr.test(en.rep), 'no Ukrainian in the English report');
});

t('"Missing character": the message is recognized by the quick fix of authoring.js in both languages (it looks at the beginning of the text)', () => {
  const g = { chars: ['Н'], font: 'cmmi12', page: 6 };
  I.setLang('uk');
  const uk = L.missingCharMessage(g, 12);
  I.setLang('en');
  const en = L.missingCharMessage(g, 12);
  assert.ok(uk.startsWith('Немає гліфів у шрифті cmmi12 (стор. 6): Н.') && en.startsWith('No glyphs in the font cmmi12 (p. 6): Н.'));
  const code = fs.readFileSync(path.join(ext, 'authoring.js'), 'utf8');
  const m = /if \((\/\^\([^\n]*?\)\/)\.test\(msg\)\)/.exec(code);
  assert.ok(m, 'the test of the message in authoring.js is found');
  const re = new Function('return ' + m[1])();
  assert.ok(re.test(uk) && re.test(en), m[1]);
  assert.ok(!re.test('Overfull \\hbox: 12pt'), 'and nothing else');
  assert.ok(/Cyrillic in math mode/.test(L.missingCharMessage({ chars: ['Н'], font: 'cmmi12', page: 1 }, null)), 'the hint for Cyrillic in English');
  assert.ok(/nullfont/.test(L.missingCharMessage({ chars: ['x'], font: 'nullfont', page: 1 }, null)));
});

t('a message that is matched in the code by its Ukrainian text is a trap in English: the known places are listed here (add a new one to this test)', () => {
  // authoring.js: the quick fix of "Missing character" (checked above). projectInfo.js: the quick fix of the typography check looks for "одиницею" in the message of projectInfoPure.js:
  // those messages are not translated yet; when they are, the quick fix must look at the code of the diagnostic, not at the words
  const info = fs.readFileSync(path.join(ext, 'projectInfo.js'), 'utf8');
  const translated = /tr\('[^']*одиницею/.test(fs.readFileSync(path.join(ext, 'projectInfoPure.js'), 'utf8'));
  assert.ok(!translated || !/\/одиницею\/\.test\(d\.message\)/.test(info), 'projectInfo.js matches a translated message by its words');
});


// files and labels (0.21.2): the diagnostics of \input & co. and the errors of the readers of tables
const FL = require(path.join(ext, 'filesAndLabelsPure'));
t('filesAndLabelsPure: the diagnostics of the paths of \\input (braces of {{1}} stay, the code and the fix do not depend on the language), the errors of .xlsx', () => {
  const table = FL.fileMacroTable({});
  const ex = (set) => (p) => set.includes(p.replace(/\\/g, '/'));
  const run = (lang) => {
    I.setLang(lang);
    const missing = FL.checkFileRefs(['\\input{nope}'], table, { dir: '/p/Ch', root: '/p', inputRoot: 'root', exists: ex([]) });
    const trap = FL.checkFileRefs(['\\input{a}'], table, { dir: '/p/Ch', root: '/p', inputRoot: 'root', exists: ex(['/p/Ch/a.tex']) });
    const plain = FL.checkFileRefs(['\\includegraphics{nope}'], table, { dir: '/p/Ch', root: '/p', inputRoot: 'file', exists: ex([]) });
    let xlsx = '';
    try { FL.readXlsx(Buffer.from('nonsense')); } catch (e) { xlsx = e.message; }
    return { missing, trap, plain, xlsx };
  };
  const uk = run('uk'), en = run('en');
  assert.deepStrictEqual([uk.missing[0].code, en.missing[0].code, uk.trap[0].code, en.trap[0].code], ['file-missing-input', 'file-missing-input', 'input-root-path', 'input-root-path']);
  assert.strictEqual(uk.trap[0].fix, 'Ch/a');
  assert.strictEqual(en.trap[0].fix, 'Ch/a');
  assert.strictEqual(uk.missing[0].message, 'Файл не знайдено (шлях від кореня проєкту): nope');
  assert.strictEqual(en.missing[0].message, 'File not found (path from the project root): nope');
  assert.ok(uk.trap[0].message.startsWith('\\input{a}: шлях рахується від кореня проєкту'), uk.trap[0].message);
  assert.ok(en.trap[0].message.startsWith('\\input{a}: the path is counted from the project root') && en.trap[0].message.endsWith('Correct: Ch/a'), en.trap[0].message);
  assert.strictEqual(en.xlsx, 'does not look like an .xlsx (no end of the zip)');
  assert.ok(/^не схоже на \.xlsx/.test(uk.xlsx));
});

t('the buttons of files and labels that the code compares with the answer are different in English too (Update / No / Remove / Merge / Save anyway / Cancel ...)', () => {
  const buttons = ['Оновити', 'Ні', 'Видалити', "Об'єднати", 'Все одно зберегти', 'Скасувати', 'Скопіювати install', 'Скопіювати пошук', 'Показати в терміналі'];
  const en = buttons.map((b) => EN[b]);
  assert.ok(en.every(Boolean), en.join(','));
  assert.strictEqual(new Set(en).size, en.length, en.join(', '));
  assert.ok(!en.includes(EN['Замінити']) && !en.includes(EN['Відкрити']), 'and not the buttons of the other commands that can be on the screen together');
});

console.log(n + ' tests passed');
