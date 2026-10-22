'use strict';
// node tests/i18nRest.test.js [path/to/extension]
// 0.21.10: the pure parts of the modules translated last (synctexPure, lwCompatPure, lwGuardPure, workspacePure.formatFileSize,
// macroGalleryPure notes, normalizePure messages) in English and in Ukrainian; the diagnostics that quickFixes.js reads by their quotes
const assert = require('assert'), path = require('path'), fs = require('fs');
const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const I = require(path.join(EXT, 'i18n'));
const CYR = /[А-Яа-яІіЇїЄєҐґ]/;
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } finally { I.setLang('uk'); } };

t('formatSynctexReport: no Ukrainian in English, the same number of lines, the paths stay', () => {
  const S = require(path.join(EXT, 'synctexPure'));
  const ctx = { pdf: 'main.pdf', synctex: 'main.synctex.gz', synctexMtime: 0, fileMtime: 5000000, file: 'A.tex', line: 3 };
  for (const rep of [{ status: 'ok', recorded: 'A/A.tex', candidates: [], inProject: [] }, { status: 'name', candidates: ['x/A.tex'], inProject: ['B/B.tex'], total: 2 }, { status: 'missing', candidates: [], inProject: [] }]) {
    I.setLang('uk'); const uk = S.formatSynctexReport(rep, ctx);
    I.setLang('en'); const en = S.formatSynctexReport(rep, ctx);
    assert.strictEqual(en.length, uk.length);
    assert.ok(!CYR.test(en.join('\n')), en.join('\n'));
    assert.ok(en.join('\n').includes('`main.pdf`'));
  }
});

t('lwFindings: titles and reasons in English, the fixes do not depend on the language', () => {
  const L = require(path.join(EXT, 'lwCompatPure'));
  const lw = { 'latex.autoBuild.run': 'onSave', 'latex.autoClean.run': 'onBuilt', 'latex.outDir': 'out', 'view.pdf.viewer': 'external' };
  I.setLang('uk'); const uk = L.lwFindings(lw, { compileOnSave: true, pdfViewer: 'vscode' });
  I.setLang('en'); const en = L.lwFindings(lw, { compileOnSave: true, pdfViewer: 'vscode' });
  assert.deepStrictEqual(en.map((f) => f.id), uk.map((f) => f.id));
  assert.deepStrictEqual(en.map((f) => f.fixes), uk.map((f) => f.fixes));
  for (const f of en) assert.ok(!CYR.test(f.title + f.why), f.title + ' / ' + f.why);
});

t('lwGuardPure.describe in English: one process and several', () => {
  const G = require(path.join(EXT, 'lwGuardPure'));
  I.setLang('en');
  const one = G.describe([{ program: 'latexmk', pid: 7 }], 'main');
  const many = G.describe([{ program: 'latexmk', pid: 7 }, { program: 'lualatex', pid: 8 }], 'main');
  assert.ok(/PID 7/.test(one) && !CYR.test(one), one);
  assert.ok(/2 processes/.test(many) && !CYR.test(many), many);
});

t('formatFileSize: units and the decimal separator follow the language', () => {
  const W = require(path.join(EXT, 'workspacePure'));
  assert.strictEqual(W.formatFileSize(2.4 * 1048576), '2,4 МБ');
  assert.strictEqual(W.formatFileSize(91 * 1024), '91 КБ');
  I.setLang('en');
  assert.strictEqual(W.formatFileSize(2.4 * 1048576), '2.4 MB');
  assert.strictEqual(W.formatFileSize(91 * 1024), '91 KB');
});

t('the diagnostics read by quickFixes.js keep the quoted name in both languages', () => {
  const src = fs.readFileSync(path.join(EXT, 'quickFixes.js'), 'utf8');
  assert.ok(!/починатися з/.test(src), 'the prefix must not be found by Ukrainian words');
  const prefixRe = /[«“]([^»”]*)[»”]\s*$/, envRe = /[«“]([^»”]*)[»”]/;
  for (const lang of ['uk', 'en']) {
    I.setLang(lang);
    assert.strictEqual(prefixRe.exec(I.tr('Мітка в «{0}» має починатися з «{1}»', 'figure', 'pic:'))[1], 'pic:');
    assert.strictEqual(envRe.exec(I.tr('У «{0}» немає \\caption', 'figure'))[1], 'figure');
    assert.strictEqual(envRe.exec(I.tr('У «{0}» немає \\label', 'wrapfigure'))[1], 'wrapfigure');
  }
});

console.log(n + ' tests passed');
