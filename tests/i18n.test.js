'use strict';
// node tests/i18n.test.js [path/to/extension]
// i18n.js and i18nEn.js: the language of the messages; every tr('...') of the code has its English text, the placeholders agree, nothing is unused.
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const I = require(path.join(ext, 'i18n'));
const EN = require(path.join(ext, 'i18nEn'));
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  ' + name); } finally { I.setLang('uk'); } };
const unescape = (lit) => lit.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t' }[c] || c));

// every tr('...') call of the code: the key (the Ukrainian text) and the file
const sources = fs.readdirSync(ext).filter((f) => /\.js$/.test(f) && f !== 'i18n.js' && f !== 'i18nEn.js' && f !== 'webviewI18n.js'); // the mechanism itself looks the keys up with a variable
const used = new Map(), dynamic = [];
for (const f of sources) {
  const text = fs.readFileSync(path.join(ext, f), 'utf8');
  for (const m of text.matchAll(/(?<![\w.$])tr\(\s*('(?:[^'\\\n]|\\.)*')?/g)) {
    if (m[1]) used.set(unescape(m[1].slice(1, -1)), f);
    else dynamic.push(f + ': ' + text.slice(m.index, m.index + 40).replace(/\n/g, ' '));
  }
}
// the pages of webviews (media/<panel>/webview.js) ask for their texts with T('...'): the same keys, the same dictionary (webviewI18n.js)
const WI = require(path.join(ext, 'webviewI18n'));
const pages = [];
for (const d of fs.existsSync(path.join(ext, 'media')) ? fs.readdirSync(path.join(ext, 'media')) : []) {
  const f = path.join(ext, 'media', d, 'webview.js');
  if (!fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  const keys = WI.keysOf(text);
  if (keys.length) { pages.push({ panel: d, file: f, text, keys }); for (const k of keys) used.set(k, 'media/' + d + '/webview.js'); }
}
// media/common/kit.js is shared by the pages (toast, titles of the copy buttons): its texts are in every page block (webviewKit.shell)
{
  const kf = path.join(ext, 'media', 'common', 'kit.js');
  if (fs.existsSync(kf)) for (const k of WI.keysOf(fs.readFileSync(kf, 'utf8'))) used.set(k, 'media/common/kit.js');
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
  const allowed = dynamic.filter((d) => !/^(projectRefactor(Pure)?\.js: tr\((r\.name|v\.label|t\.v\.label)\)|wrapCmd\.js: tr\((c\.desc|f\.label|group)\)|wrapEnv\.js: tr\(s\.desc\))/.test(d)); // the names and labels of the built-in groups of notation and the tables of the commands and environments of the quick picks: see tableTexts()
  assert.deepStrictEqual(allowed, [], 'tr() with something other than a literal in the first place: ' + allowed.join('; '));
  const missing = [...used.keys()].filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
  assert.deepStrictEqual(missing, [], 'no English text for: ' + missing.map((k) => JSON.stringify(k.slice(0, 60))).join(', '));
});

// the Ukrainian descriptions that sit in tables (wrapCmdPure.js, wrapEnvPure.js) and are translated where they are shown: tr(c.desc), tr(f.label), tr(group), tr(s.desc)
const tableTexts = () => {
  const C = require(path.join(ext, 'wrapCmdPure')), E = require(path.join(ext, 'wrapEnvPure'));
  const out = new Set();
  C.STANDARD_CMDS.forEach((c) => c.desc && out.add(c.desc));
  C.FORMAT_MENU.forEach((f) => { out.add(f.label); out.add(f.group); });
  E.STANDARD_ENVS.forEach((e) => e.desc && out.add(e.desc));
  return [...out].filter((x) => cyr.test(x));
};
t('every description in the tables of the commands and environments (the quick picks of Wrap in command / environment, Format) has an English text', () => {
  const tx = tableTexts();
  assert.ok(tx.length > 80, 'the tables are read: ' + tx.length);
  const missing = tx.filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
  assert.deepStrictEqual(missing, [], 'no English text for: ' + missing.join(' | '));
  const C = require(path.join(ext, 'wrapCmdPure')), E = require(path.join(ext, 'wrapEnvPure'));
  assert.ok(C.STANDARD_CMDS.every((c) => !c.desc || !cyr.test(c.desc) || EN[c.desc]) && E.STANDARD_ENVS.every((e) => !e.desc || !cyr.test(e.desc) || EN[e.desc]));
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
  const groupNames = new Set(builtIn().concat(tableTexts()));
  const unused = Object.keys(EN).filter((k) => !used.has(k) && !groupNames.has(k));
  assert.deepStrictEqual(unused, [], 'unused keys: ' + unused.map((k) => JSON.stringify(k.slice(0, 60))).join(', '));
});

t('the placeholders of a translation are those of its key; no translation is empty or the same as the key; no Ukrainian text left except the examples of Ukrainian words', () => {
  for (const [k, v] of Object.entries(EN)) {
    assert.strictEqual(ph(v), ph(k), 'placeholders differ: ' + JSON.stringify(k.slice(0, 60)));
    assert.ok(typeof v === 'string' && v.trim() && v !== k, 'empty or untranslated: ' + JSON.stringify(k.slice(0, 60)));
    // Ukrainian stays only where it is an example of Ukrainian text: words of the Terms report, the title of the section of the quiz questions that is looked for in the document
    if (cyr.test(v)) assert.ok(/напруженість \/ напруженості|Контрольні запитання/.test(v), 'Ukrainian left in the translation: ' + JSON.stringify(v.slice(0, 80)));
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

t('no code recognizes a diagnostic or a message by its Ukrainian words (that breaks in English); the quick fix of "Missing character" looks at both languages', () => {
  // a line that tests/matches a message (message, msg, d.message) against a literal with Cyrillic: only the quick fix of logPure's "Missing character" (authoring.js), which knows both languages
  const bad = [];
  for (const f of sources) {
    fs.readFileSync(path.join(ext, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || !cyr.test(line)) return;
      const arg = /\.(startsWith|includes|indexOf|endsWith)\(\s*'[^']*[А-Яа-яІіЇїЄєҐґ]/.test(line) && /\b(message|msg)\b/.test(line);
      const regexOnMessage = /\/[^\/\n]*[А-Яа-яІіЇїЄєҐґ][^\/\n]*\/[a-z]*\.test\(\s*(String\()?\s*(d\.)?(message|msg)\b/.test(line);
      const onMessage = arg || regexOnMessage;
      if (/MORFOLOGIK|HUNSPELL/.test(line)) return; // settingsCitations.js: the messages of other extensions (LTeX, spell checkers), in their own language
      if ((onMessage || regexOnMessage) && !/No glyphs/.test(line)) bad.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 100));
    });
  }
  assert.deepStrictEqual(bad, [], 'recognized by words: ' + bad.join(' | '));
  const info = fs.readFileSync(path.join(ext, 'projectInfo.js'), 'utf8');
  assert.ok(!/одиницею/.test(info), 'projectInfo.js no longer looks for the word of the message of projectInfoPure.js');
  assert.ok(/isNumberUnitSpace\(text\)/.test(info), 'it looks at the text of the diagnostic');
});


// files and labels (0.21.2): the diagnostics of \input & co. and the errors of the readers of tables
const FL = require(path.join(ext, 'filesAndLabelsPure'));
t('filesAndLabelsPure: the diagnostics of the paths of \\input (braces of {{1}} stay, the code and the fix do not depend on the language), the errors of .xlsx', () => {
  const table = FL.fileMacroTable({});
  // the code resolves the paths (on Windows '/p/Ch' becomes 'D:\p\Ch'): the expected ones are resolved the same way
  const ex = (set) => (p) => set.map((s) => path.resolve(s)).includes(path.resolve(p));
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


t('no key of tr() has a backslash that is silently dropped by JavaScript (\\) is one backslash, \) is ")" : the key must say what it means', () => {
  const bad = [];
  for (const f of sources) {
    const text = fs.readFileSync(path.join(ext, f), 'utf8');
    for (const m of text.matchAll(/(?<![\w.$])tr\(\s*('(?:[^'\\\n]|\\.)*')/g)) {
      if (/\\[^\\n't"xu]/.test(m[1].replace(/\\\\/g, ''))) bad.push(f + ': ' + m[1].slice(0, 60));
    }
  }
  assert.deepStrictEqual(bad, [], 'an escape that means nothing: ' + bad.join(' | '));
});

// project statistics, typography, the mixed macros (0.21.4): projectInfoPure.js speaks the language too
const PIP = require(path.join(ext, 'projectInfoPure'));
t('projectInfoPure in English and in Ukrainian: the hints of typography, the mixed macros, the names of the built-in counters, the title of the part before the first heading; the codes and the places do not depend on the language', () => {
  const lines = ['Довжина 5 мм і 2,5 кг.', 'див. рис. 5 та 12 тис. грн', 'Слово тест\\ref{a} і \\vec x та \\vect y та \\vec z', 'Це слово xаос тут -- тире', 'Дефіс - тут'];
  const opts = { mixedMacros: [['vec', 'vect']] };
  const run = (lang) => { I.setLang(lang); return PIP.typographyChecks(lines, opts).map((r) => ({ line: r.line, col: r.col, len: r.len, code: r.code, message: r.message })); };
  const uk = run('uk'), en = run('en');
  assert.deepStrictEqual(en.map((r) => [r.line, r.col, r.len, r.code]), uk.map((r) => [r.line, r.col, r.len, r.code]), 'only the texts differ');
  const msg = (x, code, i) => x.filter((r) => r.code === code)[i || 0].message;
  assert.strictEqual(msg(uk, 'typo-nbsp', 0), 'Між числом і одиницею — нерозривний пробіл («~» або «\\,»)');
  assert.strictEqual(msg(en, 'typo-nbsp', 0), 'Between a number and a unit — a non-breaking space (“~” or “\\,”)');
  assert.strictEqual(msg(en, 'typo-nbsp', 2), 'After the abbreviation “рис.” — a non-breaking space (“~”)');
  assert.ok(en.some((r) => r.message === 'Between a number and “тис.” — a non-breaking space (“~”)'), JSON.stringify(en.map((r) => r.message)));
  assert.ok(en.some((r) => r.code === 'typo-dash' && r.message === 'A hyphen instead of a dash: “ --- ” is used in the text'));
  const mixed = (x) => x.filter((r) => r.code === 'typo-mixed-macro').map((r) => r.message);
  assert.ok(mixed(uk).length > 0 && mixed(en).length === mixed(uk).length, 'the mixed macros are found');
  assert.ok(mixed(uk)[0].startsWith('У файлі змішано \\vec ') && /^The file mixes \\vec? \(\d+\) and \\vec?t? \(\d+\); the more frequent one is \\vec/.test(mixed(en)[0]), mixed(en)[0]);
  I.setLang('uk');
  assert.deepStrictEqual(Object.keys(PIP.builtinCounters({})), ['Задач', 'Контр. запитань']);
  I.setLang('en');
  assert.deepStrictEqual(Object.keys(PIP.builtinCounters({})), ['Problems', 'Quiz questions']);
  const fs1 = PIP.fileStats('Текст до заголовка зі словами.\n\\section{Назва}\nІнший текст.', {}, PIP.builtinCounters({}));
  assert.ok(fs1.rows.some((r) => r.title === '(before the first heading)'), JSON.stringify(fs1.rows.map((r) => r.title)));
  I.setLang('uk');
  assert.ok(PIP.fileStats('Текст до заголовка зі словами.\n\\section{Назва}\nІнший текст.', {}, PIP.builtinCounters({})).rows.some((r) => r.title === '(до першого заголовка)'));
});


// the report of the state of the extension, the errors of the table and equation operations and of the merge of settings.json (0.21.7)
const DBG = require(path.join(ext, 'debugStatePure')), STR = require(path.join(ext, 'structurePure')), WSP = require(path.join(ext, 'workspacePure'));
t('debugStatePure, structurePure (tableOp, convertEnv, syntax checks) and workspacePure (mergeMissingSettings) speak the language; the values and the structure do not depend on it', () => {
  const state = { version: '1', vscodeVersion: '1.9', platform: 'linux', node: '20', uptimeSec: 3725, subscriptions: 5, timers: ['a'], panels: { x: true }, findCache: 2, docMap: null, caching: false, index: { labels: 3 }, memory: { heapUsed: 10485760, heapTotal: 20971520, rss: 31457280, external: 1048576 } };
  const run = (lang) => { I.setLang(lang); return { rep: DBG.report(state, null), tbl: [STR.tableOp([], 'sort', 0).error, STR.tableOp(['a & b', 'c & d'], 'bogus', 0).error], set: [WSP.mergeMissingSettings('{ nonsense', { a: 1 }).error, WSP.mergeMissingSettings('[1]', { a: 1 }).error] }; };
  const uk = run('uk'), en = run('en');
  assert.strictEqual(uk.rep.split('\n').length, en.rep.split('\n').length, 'the same lines');
  assert.ok(uk.rep.startsWith('# TSS Workflow: стан розширення') && uk.rep.includes('працює 1 год 2 хв') && uk.rep.includes('| Показник | Значення |'), uk.rep.slice(0, 200));
  assert.ok(en.rep.startsWith('# TSS Workflow: state of the extension') && en.rep.includes('has been running for 1 h 2 min') && en.rep.includes('| Metric | Value |') && en.rep.includes('## What can leak') && en.rep.includes('**no** (everything is read from the disk every time)') && en.rep.includes('not built yet'), en.rep.slice(0, 400));
  assert.ok(!cyr.test(en.rep), 'no Ukrainian in the English report: ' + (en.rep.match(/.*[А-Яа-яІіЇїЄєҐґ].*/) || [''])[0]);
  assert.ok(en.rep.includes('10.0 MB') && uk.rep.includes('10.0 МБ'), 'the unit of memory');
  assert.deepStrictEqual(en.tbl, ['The block has no table rows (rows with & on one line are needed).', 'Unknown action: bogus']);
  assert.deepStrictEqual(uk.tbl, ['У блоці немає рядків таблиці (потрібні рядки з & в одному рядку).', 'Невідома дія: bogus']);
  assert.deepStrictEqual(en.set, ['could not parse the existing settings.json', 'settings.json must be a JSON object']);
  assert.deepStrictEqual(uk.set, ['не вдалося розібрати існуючий settings.json', "settings.json має бути JSON-об'єктом"]);
  I.setLang('uk');
});

t('syntax checks of structurePure: the messages are translated, the codes are not (a quick fix looks at the code)', () => {
  const text = ['\\begin{itemize}', 'a', '\\end{enumerate}', '\\end{center}', '\\begin{align}', 'x', ''].join('\n');
  const run = (lang) => { I.setLang(lang); return STR.syntaxChecks(text.split('\n'), {}).map((d) => [d.code, d.message]); };
  const uk = run('uk'), en = run('en');
  assert.deepStrictEqual(en.map((d) => d[0]), uk.map((d) => d[0]), 'the same codes');
  assert.ok(uk.length >= 3 && en.length === uk.length, JSON.stringify(uk));
  assert.ok(en.some((d) => d[0] === 'end-mismatch' && d[1] === '\\end{enumerate} does not match \\begin{itemize}'), JSON.stringify(en));
  assert.ok(en.some((d) => d[0] === 'end-without-begin' && d[1] === '\\end{center} without \\begin'), JSON.stringify(en));
  assert.ok(en.some((d) => d[0] === 'missing-end' && /^Missing \\end\{(align|itemize)\}$/.test(d[1])), JSON.stringify(en));
  assert.ok(uk.some((d) => d[1] === '\\end{enumerate} не відповідає \\begin{itemize}'), 'the braces of {{0}} stay in Ukrainian too');
  I.setLang('uk');
});


t('webviewI18n: keysOf reads the T(...) keys of a page (escapes, apostrophes, no duplicates); a T with something else than a literal is not a key', () => {
  const js = "x(T('Привіт {0}', a)); y(T('Об\\'єднати')); z(T('Привіт {0}', b)); w(T(\"Ще\\n\")); v(foo.T('не мій')); u(notT('ні'));";
  assert.deepStrictEqual(WI.keysOf(js), ['Привіт {0}', "Об'єднати", 'Ще\n']);
  assert.deepStrictEqual(WI.keysOf(''), []);
  assert.deepStrictEqual(WI.keysOf(null), []);
});

t('webviewI18n.block: a JSON block that nothing executes, with < > & as \\u escapes; the language of the moment; texts are filled by the page, not by the host', () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tss-wi-'));
  try {
    const f = path.join(tmp, 'webview.js');
    fs.writeFileSync(f, "T('Замінити'); T('Знімок відновлено: {0} файлів.', n); T('</script><b>&');");
    I.setLang('uk');
    const uk = WI.block([f, path.join(tmp, 'no-such-file.js')]);
    assert.ok(uk.startsWith('<script type="application/json" id="tss-i18n">') && uk.endsWith('</script>'), uk.slice(0, 80));
    assert.strictEqual((uk.match(/<\/script>/g) || []).length, 1, 'nothing in a text can close the block');
    assert.ok(!/<b>|&b/.test(uk) && uk.includes('\\u003c/script\\u003e\\u003cb\\u003e\\u0026'), uk);
    assert.deepStrictEqual(JSON.parse(uk.replace(/^<script[^>]*>|<\/script>$/g, '')), { 'Замінити': 'Замінити', 'Знімок відновлено: {0} файлів.': 'Знімок відновлено: {0} файлів.', '</script><b>&': '</script><b>&' });
    I.setLang('en');
    const d = JSON.parse(WI.block([f]).replace(/^<script[^>]*>|<\/script>$/g, ''));
    assert.strictEqual(d['Замінити'], 'Replace');
    assert.strictEqual(d['Знімок відновлено: {0} файлів.'], 'Snapshot restored: {0} files.', 'the {0} stays: the page fills it');
    assert.strictEqual(d['</script><b>&'], '</script><b>&', 'a key without a translation stays as written');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); I.setLang('uk'); }
});

t('media/common/i18n.js (the page side): T fills {0}, keeps a missing key and a missing argument, survives a broken or absent block', () => {
  const vm = require('vm');
  const code = fs.readFileSync(path.join(ext, 'media', 'common', 'i18n.js'), 'utf8');
  const load = (json) => {
    const box = { document: { getElementById: (id) => (json === undefined ? null : { textContent: json }) } };
    box.window = box;
    vm.runInNewContext(code, box);
    return box.T;
  };
  const T = load(JSON.stringify({ 'Рядок {0} з {1}': 'Row {0} of {1}', 'Просто': 'Plain' }));
  assert.strictEqual(T('Рядок {0} з {1}', 3, 9), 'Row 3 of 9');
  assert.strictEqual(T('Рядок {0} з {1}', 3), 'Row 3 of {1}');
  assert.strictEqual(T('Просто'), 'Plain');
  assert.strictEqual(T('Немає в словнику {0}', 'x'), 'Немає в словнику x');
  assert.strictEqual(T('Ціна $& {0}', '$& $1'), 'Ціна $& $& $1', 'the replacement is not a pattern');
  assert.strictEqual(load('{ broken')('Рядок {0} з {1}', 1, 2), 'Рядок 1 з 2', 'a broken block: Ukrainian');
  assert.strictEqual(load(undefined)('Просто'), 'Просто', 'no block: Ukrainian');
  assert.strictEqual(load('null')('Просто'), 'Просто', 'a block that is not an object');
});

t('the pages of webviews: every T(...) has an English text, none is called with a non-literal, and the table editor loads the dictionary and the helper before its script', () => {
  assert.ok(pages.length >= 1 && pages.some((p) => p.panel === 'tableEditor'), 'the pages are found: ' + pages.map((p) => p.panel));
  for (const p of pages) {
    assert.ok(p.keys.length >= 5, p.panel + ': keys ' + p.keys.length);
    const missing = p.keys.filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
    assert.deepStrictEqual(missing, [], p.panel + ': no English text for ' + missing.map((k) => JSON.stringify(k.slice(0, 50))).join(', '));
    // a text of the page that is not asked through T(...) is a text that stays Ukrainian in English
    const stray = [];
    p.text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.matchAll(/'(?:[^'\\\n]|\\.)*'/g)) if (cyr.test(m[0]) && !/T\(\s*$/.test(line.slice(0, m.index))) stray.push((i + 1) + ': ' + m[0].slice(0, 50));
    });
    assert.deepStrictEqual(stray, [], p.panel + ': Ukrainian texts outside T(): ' + stray.join(' | '));
    const nonLiteral = [...p.text.matchAll(/(?<![\w.$])T\(\s*(?!['"])/g)].length;
    assert.strictEqual(nonLiteral, 0, p.panel + ': T() with something other than a literal in the first place');
  }
  const te = fs.readFileSync(path.join(ext, 'tableEditor.js'), 'utf8');
  const iBlock = te.indexOf('WI.block('), iHelper = te.indexOf("'common', 'i18n.js'"), iPage = te.lastIndexOf("own('webview.js')");
  assert.ok(iBlock > 0 && iHelper > iBlock && iPage > iHelper, 'the block, then the helper, then the script of the page');
  assert.ok(/<html lang="' \+ getLang\(\) \+ '"/.test(te), 'the language of the page');
});


// the table editor (0.21.8): the messages of the model and of the operations, translated where they are made; the page and the host ask for their own texts
const TEP = require(path.join(ext, 'tableEditorPure'));
t('tableEditorPure in English and in Ukrainian: the reason of a skipped table, the errors of the operations, the text of a cell; the structure does not depend on the language', () => {
  const src = '\\begin{tblr}{colspec={ll}}\na & b \\\\\nc & d \\\\\n\\end{tblr}\n';
  const VERB = '\\begin{tblr}{ll}\n\\verb|x| & b \\\\\n\\end{tblr}\n';
  const run = (lang) => {
    I.setLang(lang);
    const m = TEP.parseTable(src, TEP.locateTables(src)[0]).model;
    return {
      skip: TEP.parseTable(VERB, TEP.locateTables(VERB)[0]).skip,
      ops: [TEP.applyOp(m, { type: 'delRow', r: 9 }), TEP.applyOp(m, { type: 'zzz' }), TEP.applyOp(m, { type: 'merge', r1: 0, r2: 0, c1: 0, c2: 0 })].map((x) => x.error),
      cells: [TEP.checkCellText('a & b'), TEP.checkCellText('x {'), TEP.checkCellText('fine')]
    };
  };
  const uk = run('uk'), en = run('en');
  assert.deepStrictEqual(uk.ops.map((x) => typeof x), en.ops.map((x) => typeof x), 'an error is an error in both languages');
  assert.deepStrictEqual(uk.cells.map((x) => !!x), en.cells.map((x) => !!x), 'a cell that is fine is fine in both languages');
  assert.strictEqual(uk.skip, 'у таблиці є \\verb або код');
  assert.strictEqual(en.skip, 'the table has \\verb or code');
  assert.deepStrictEqual(uk.ops.slice(0, 2), ['Немає такого рядка.', 'Невідома дія zzz']);
  assert.deepStrictEqual(en.ops.slice(0, 2), ['There is no such row.', 'Unknown action zzz']);
  assert.strictEqual(en.cells[0], 'in a cell “&” separates cells; for the character write \\&');
  assert.strictEqual(en.cells[1], 'the brackets { } in the cell are not balanced');
  assert.ok(!en.cells[2], 'a fine cell has no message');
  assert.strictEqual(en.ops[2], 'Select several cells to merge them.');
  assert.strictEqual(uk.ops[2], 'Виділи кілька клітинок, щоб їх об\'єднати.');
  I.setLang('uk');
});

t('the table editor: the hint of the page and the title of the panel come from the host with tr (the language of the moment), the keys of the page and of the host do not overlap by accident', () => {
  const te = fs.readFileSync(path.join(ext, 'tableEditor.js'), 'utf8');
  assert.ok(/get title\(\) \{ return tr\('Таблиця'\); \}/.test(te), 'the title of the panel is read when the panel is opened (a getter): the language is set at activation, after the module is loaded');
  assert.ok(/escHtml\(tr\('Enter\/Tab\//.test(te), 'the hint is translated and escaped');
  const te_page = pages.find((p) => p.panel === 'tableEditor');
  const hostKeys = new Set([...te.matchAll(/(?<![\w.$])tr\(\s*('(?:[^'\\\n]|\\.)*')/g)].map((m) => Function('return ' + m[1])()));
  for (const k of te_page.keys) assert.ok(!hostKeys.has(k) || EN[k], 'a key of the page that the host also uses has its text: ' + k.slice(0, 40));
});


// the preview of the selection (0.21.9): the placeholders, the titles and the notes of selectionPreviewPure.js; a table that cannot be parsed gives its reason in the language of the table editor too
const SPV = require(path.join(ext, 'selectionPreviewPure'));
t('selectionPreviewPure in English and in Ukrainian: the placeholders of pictures, the title of a reference, the note of a table that was not parsed (with the reason from tableEditorPure); the structure does not depend on the language', () => {
  const run = (lang) => {
    I.setLang(lang);
    return {
      tikz: SPV.render('\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}', {}),
      missing: SPV.render('\\begin{figure}\\includegraphics{b.png}\\end{figure}', { image: () => ({ skip: 'missing' }) }),
      pdf: SPV.render('\\includegraphics{a.pdf}', { image: () => ({ skip: 'pdf' }) }),
      ref: SPV.render('\\ref{x}', {}),
      table: SPV.render('\\begin{tabular}{l}\\verb|x|\\end{tabular}', {})
    };
  };
  const uk = run('uk'), en = run('en');
  assert.strictEqual(uk.tikz.html, '<div class="ph">tikzpicture: рисунок буде лише в PDF</div>');
  assert.strictEqual(en.tikz.html, '<div class="ph">tikzpicture: the picture will appear only in the PDF</div>');
  assert.ok(en.missing.html.includes('b.png (file not found)') && uk.missing.html.includes('b.png (файл не знайдено)'));
  assert.ok(en.pdf.html.includes('a.pdf (PDF and EPS are not shown in the preview)') && uk.pdf.html.includes('a.pdf (PDF і EPS у перегляді не показуються)'));
  assert.ok(en.ref.html.includes('title="To \\label{x} in the code"') && uk.ref.html.includes('title="До \\label{x} у коді"'));
  assert.deepStrictEqual(en.table.notes, ['table (not parsed: the table has \\verb or code)']);
  assert.deepStrictEqual(uk.table.notes, ['таблиця (не розібрано: у таблиці є \\verb або код)']);
  for (const k of Object.keys(uk)) assert.strictEqual(uk[k].html.replace(/>[^<]*</g, '><').replace(/ title="[^"]*"/g, ''), en[k].html.replace(/>[^<]*</g, '><').replace(/ title="[^"]*"/g, ''), k + ': the same markup in both languages');
  I.setLang('uk');
});

console.log(n + ' tests passed');
