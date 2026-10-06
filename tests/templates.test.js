'use strict';
// node tests/templates.test.js [path/to/extension]
const path = require('path');
const assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const T = require(path.join(ext, 'templatesPure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('parse: meta lines are cut, CRLF and BOM normalised', () => {
  const p = T.parseTemplate('\uFEFF% !TSS name: Моя\r\n% !TSS description: опис  \r\n\\documentclass{article}\r\n', 'x.tex');
  assert.deepStrictEqual(p, { name: 'Моя', description: 'опис', body: '\\documentclass{article}\n' });
});
t('parse: no meta -> file name is the name; meta only at the top', () => {
  const p = T.parseTemplate('% !TeX program = lualatex\n% !TSS description: пізно\n', 'Стаття.tex');
  assert.strictEqual(p.name, 'Стаття');
  assert.strictEqual(p.description, '');
  assert.ok(p.body.includes('!TSS description: пізно'));
});
t('build: description line, old meta replaced, round trip', () => {
  const a = T.buildTemplate('% !TSS name: Old\n% !TSS description: old\nBODY', ' новий\n опис ');
  assert.strictEqual(a, '% !TSS description: новий опис\nBODY');
  const p = T.parseTemplate(a, 'f.tex');
  assert.strictEqual(p.body, 'BODY');
  assert.strictEqual(T.buildTemplate('BODY', ''), 'BODY');
});
t('sanitizeName', () => {
  assert.strictEqual(T.sanitizeName('  a/b:c*?  '), 'a b c');
  assert.strictEqual(T.sanitizeName('Звіт 2026.'), 'Звіт 2026');
  assert.strictEqual(T.sanitizeName('...'), '');
  assert.strictEqual(T.sanitizeName('CON'), '');
  assert.strictEqual(T.sanitizeName(null), '');
  assert.strictEqual(T.sanitizeName('x'.repeat(200)).length, 80);
});
t('uniqueName is case-insensitive', () => {
  assert.strictEqual(T.uniqueName(['Стаття', 'стаття 2'], 'стаття'), 'стаття 3');
  assert.strictEqual(T.uniqueName([], 'a'), 'a');
});
t('isTemplateFile', () => {
  assert.ok(T.isTemplateFile('a.tex') && T.isTemplateFile('A.TIKZ'));
  assert.ok(!T.isTemplateFile('a.pdf') && !T.isTemplateFile('.gitkeep') && !T.isTemplateFile('tex'));
});
t('builtinVars', () => {
  const v = T.builtinVars(new Date(2026, 9, 5, 7, 3), 'Анжела');
  assert.deepStrictEqual(v, { date: '2026-10-05', year: '2026', time: '07:03', author: 'Анжела' });
});
t('usesVar', () => {
  assert.ok(T.usesVar('\\title{${title}}', 'title'));
  assert.ok(!T.usesVar('\\title{}', 'title'));
});
t('applyTemplate: placeholders, unknown stay, $ is safe', () => {
  const r = T.applyTemplate('\\author{${author}} ${date} ${unknown} $&$ ${year}', { author: 'A', date: 'D', year: 'Y' });
  assert.strictEqual(r.text, '\\author{A} D ${unknown} $&$ Y');
  assert.strictEqual(r.cursor, null);
});
t('applyTemplate: cursor position and extra cursors', () => {
  const r = T.applyTemplate('a\n${author}b${cursor}c\n${cursor}d', { author: 'XY' });
  assert.strictEqual(r.text, 'a\nXYbc\nd');
  assert.deepStrictEqual(r.cursor, { line: 1, character: 3 });
  const r2 = T.applyTemplate('${cursor}x', {});
  assert.deepStrictEqual(r2.cursor, { line: 0, character: 0 });
});
t('sortTemplates: project, user, built-in; by name', () => {
  const l = T.sortTemplates([
    { source: 'builtin', name: 'А' }, { source: 'user', name: 'Б' }, { source: 'project', name: 'Я' },
    { source: 'user', name: 'А' }
  ]);
  assert.deepStrictEqual(l.map((x) => x.source + ':' + x.name), ['project:Я', 'user:А', 'user:Б', 'builtin:А']);
});
t('built-in template of the package is valid and loses its meta lines', () => {
  const fs = require('fs');
  const f = path.join(ext, 'templates', 'ukr-lualatex-article.tex');
  const p = T.parseTemplate(fs.readFileSync(f, 'utf8'), 'ukr-lualatex-article.tex');
  assert.strictEqual(p.name, 'Стаття: LuaLaTeX, кирилиця (укр.)');
  assert.ok(p.description.startsWith('article 14 pt'));
  assert.ok(p.body.startsWith('%%====') && p.body.includes('\\begin{document}') && !p.body.includes('!TSS'));
  const src = fs.readFileSync('/mnt/user-data/uploads/template_Lua_Pdf_LaTeX_Cyrilics.tex', 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(p.body, src, 'body must equal the uploaded template');
});
console.log('\n' + n + ' tests passed');
