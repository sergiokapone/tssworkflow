'use strict';
// node tests/typesetting.test.js [path/to/extension]  - the pure modules of 0.23.0: hyphenPure, dstuPure, floatsPure, annotsPure
const path = require('path'), assert = require('assert'), zlib = require('zlib');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const H = require(path.join(ext, 'hyphenPure.js'));
const D = require(path.join(ext, 'dstuPure.js'));
const FL = require(path.join(ext, 'floatsPure.js'));
const A = require(path.join(ext, 'annotsPure.js'));
const L = require(path.join(ext, 'logPure.js'));
const FLP = require(path.join(ext, 'filesAndLabelsPure.js'));
const I = require(path.join(ext, 'i18n.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

/* ------------------------------- hyphenation ------------------------------- */
// a real overfull paragraph of LuaLaTeX, cut by the log at 79 bytes (also inside a word and a font name)
const LOG = [
  '(./preface.tex',
  'Overfull \\hbox (0.75658pt too wide) in paragraph at lines 55--59',
  '[]\\TU/BookmanOldStyle(0)/m/n/14 Під-ру-чник адре-со-ва-ний ',
  'на-сам-пе-ред сту-ден-там фізико-технічного',
  ' []',
  '',
  'Overfull \\hbox (7.18465pt too wide) in paragraph at lines 9--12',
  '\\TU/BookmanOldStyle(0)/m/n/14 Пер-ше рів-ня-н-ня $\\TU/StixTwoMath(1)/m/n/14 ',
  '𝜀$ \\TU/BookmanOldStyle(0',
  ')/m/it/14 яке п',
  'ов’язує',
  ' []',
  '',
  'Overfull \\hbox (8.0pt too wide) in paragraph at lines 20--21',
  '\\TU/BookmanOldStyle(0)/m/n/14 ви-гляд си-ло-вих лі-ній. Ос',
  'кіль-',
  ' []',
  ')'
].join('\n');

t('logPure.parseLog: an overfull paragraph has its last line and the box, the cut lines joined (also inside a font name)', () => {
  const it = L.parseLog(LOG, 0);
  assert.deepStrictEqual(it.map((x) => [x.line, x.endLine]), [[54, 58], [8, 11], [19, 20]]);
  assert.strictEqual(it[0].box, '[]\\TU/BookmanOldStyle(0)/m/n/14 Під-ру-чник адре-со-ва-ний на-сам-пе-ред сту-ден-там фізико-технічного');
  assert.deepStrictEqual(H.boxWords(it[1].box), ['Пер-ше', 'рів-ня-н-ня', 'яке', 'пов’язує']);
});

t('hyphenPure.candidates: the last word TeX could not break; a compound word (the hyphen is in the source); a word broken at the line end is fine', () => {
  const it = L.parseLog(LOG, 0);
  const c0 = H.candidates(it[0].box, 'Підручник адресований\nнасамперед студентам фізико-технічного');
  assert.deepStrictEqual(c0.map((c) => [c.shown, c.letters, c.source, c.compound]), [['фізико-технічного', 'фізикотехнічного', 'фізико-технічного', true]]);
  const c1 = H.candidates(it[1].box, 'Перше рівняння $\\varepsilon$ \\emph{яке пов’язує}');
  assert.deepStrictEqual(c1.map((c) => [c.letters, c.compound]), [['пов’язує', false]]);
  assert.deepStrictEqual(H.candidates(it[2].box, 'вигляд силових ліній. Оскільки'), []);
  // a hyphenated word in the box is not a hyphen of the source: TeX can break it
  assert.deepStrictEqual(H.candidates('[]\\TU/X(0)/m/n/10 ана-лі-тич-но', 'аналітично'), []);
});

t('hyphenPure.suggest: syllables, й / ь / apostrophe with the letter before, дж / дз whole except after a prefix, two letters at each end', () => {
  const cases = {
    рівняння: 'рів-нян-ня', технічного: 'тех-ніч-но-го', кукурудза: 'ку-ку-ру-дза', відзначити: 'від-зна-чи-ти', підземний: 'під-зем-ний',
    Майстерня: 'Май-стер-ня', 'пов’язує': 'пов’-я-зує', 'фізико-технічного': 'фі-зи-ко-тех-ніч-но-го', йод: 'йод', буря: 'бу-ря'
  };
  for (const [w, s] of Object.entries(cases)) assert.strictEqual(H.suggest(w), s, w);
});

t('hyphenPure.softHyphens / hyphenationEntry: the same letters only; explicit hyphens stay; case does not matter', () => {
  assert.strictEqual(H.softHyphens('фізико-технічного', 'фі-зи-ко-тех-ніч-но-го'), 'фі\\-зи\\-ко-тех\\-ніч\\-но\\-го');
  assert.strictEqual(H.softHyphens('пов’язує', 'пов’я-зує'), 'пов’я\\-зує');
  assert.strictEqual(H.softHyphens('слово', 'сло-ва'), null);
  assert.strictEqual(H.hyphenationEntry('пов’язує', ' ПОВ’Я-ЗУЄ '), 'пов’я-зує');
  assert.strictEqual(H.hyphenationEntry('слово', 'сло--во'), null);
  assert.strictEqual(H.hyphenationEntry('слово', '-слово'), null);
  assert.strictEqual(H.hyphenationEntry('слово', 'сло-во x'), null);
});

t('hyphenPure.addHyphenation: into the \\hyphenation of the preamble (after a comment with text), a new line before \\begin{document}, no duplicates', () => {
  const pre = '\\documentclass{book} % коментар\n% \\hyphenation{x}\n\\hyphenation{ана-ліз}\n\\begin{document}\n\\hyphenation{не-тут}\n';
  const r = H.addHyphenation(pre, ['пов’я-зує', 'ана-ліз']);
  assert.ok(r.text.includes('\\hyphenation{ана-ліз пов’я-зує}\n\\begin{document}') && r.text.includes('% \\hyphenation{x}\n'), r.text);
  assert.deepStrictEqual([r.added, r.line], [['пов’я-зує'], 2]);
  const multi = H.addHyphenation('\\documentclass{book}\n\\hyphenation{\n  ана-ліз\n}\n\\begin{document}\n', ['а-б']);
  assert.ok(multi.text.includes('  ана-ліз а-б\n}'), multi.text);
  const fresh = H.addHyphenation('\\documentclass{book}\n\\usepackage{x}\n\\begin{document}\nТекст\n', ['а-б', 'в-г']);
  assert.ok(fresh.text.includes('\\usepackage{x}\n\\hyphenation{а-б в-г}\n\\begin{document}'));
  assert.strictEqual(fresh.line, 2);
  assert.deepStrictEqual(H.addHyphenation(r.text, ['ана-ліз']).added, []);
  assert.strictEqual(H.addHyphenation('Текст без преамбули', ['а-б']), null);
});

t('hyphenPure.findInLines: whole words only, outside comments, the last occurrence in the paragraph', () => {
  const lines = ['Текст фізико-технічного і', 'ще фізико-технічного. % фізико-технічного', 'нефізико-технічного'];
  assert.deepStrictEqual(H.findInLines(lines, 0, 2, 'фізико-технічного'), { line: 1, col: 3 });
  assert.strictEqual(H.findInLines(lines, 2, 2, 'фізико-технічного'), null);
});

/* --------------------------------- ДСТУ ---------------------------------- */
const BIB = String.raw`@article{good,
  author = {Іваненко, І. І. and Петренко, П. П.},
  title = {Про поле},
  journal = {Укр. фіз. журн.},
  year = {2020}, volume = {65}, pages = {12--15}, langid = {ukrainian}
}
@article{bad,
  author = {Іваненко І. І., Петренко П. П., Сидоренко С. С.},
  title = {Прo поле},
  year = {20},
  pages = {12-15},
  url = {https://x.org}
}
@book{nb, author = {Knuth, D.}, title = {The TeXbook}, publisher = {AW}, year = {1984}, langid = {ukrainian}}
@online{web, title = {Сторінка}, url = {https://y.org}, langid = {ukrainian}}
@misc{empty, title = {Щось}, year = {2001}, note = {}, langid = {english}}
@string{x = {y}}
`;

t('dstuPure.checkEntry: required fields by type (with BibTeX aliases), url without urldate, authors by commas, pages, year, langid, mixed letters', () => {
  const e = FLP.parseBib(BIB).filter((x) => !x.special);
  const r = Object.fromEntries(e.map((x) => [x.key, D.checkEntry(x)]));
  assert.deepStrictEqual(r.good, { errors: [], warnings: [] });
  assert.ok(r.bad.errors.some((x) => /journaltitle \(journal\)/.test(x) && /volume або number/.test(x)), r.bad.errors.join(' | '));
  assert.ok(r.bad.errors.some((x) => /urldate/.test(x)) && r.bad.errors.some((x) => /author: імена через кому/.test(x)));
  assert.ok(r.bad.warnings.some((x) => /через -- \(12-15\)/.test(x)) && r.bad.warnings.some((x) => /рік «20»/.test(x)));
  assert.ok(r.bad.warnings.some((x) => /langid немає/.test(x)) && r.bad.warnings.some((x) => /кирилиця й латиниця в одному слові: Прo/.test(x)), r.bad.warnings.join(' | '));
  assert.ok(r.nb.errors.some((x) => /location \(address\)/.test(x)) && r.nb.warnings.some((x) => /латиницею, а langid = ukrainian/.test(x)));
  assert.ok(r.web.errors.some((x) => /немає urldate/.test(x)) && !r.web.errors.some((x) => /^є url/.test(x)), 'online: urldate once, as a required field');
  assert.ok(r.empty.warnings.some((x) => /порожнє поле note/.test(x)) && r.empty.warnings.some((x) => /кирилицею, а langid = english/.test(x)));
});

t('dstuPure.dstuReport: counts, only the cited entries, places as file.bib:line (links), English', () => {
  const r = D.dstuReport([{ rel: 'refs/main.bib', text: BIB }]);
  assert.deepStrictEqual([r.entries, r.withErrors, r.withWarnings], [5, 3, 1]);
  assert.ok(r.md.includes('- refs/main.bib:7 `bad` (@article) — ✗ '), r.md);
  assert.ok(!r.md.includes('`good`'));
  const only = D.dstuReport([{ rel: 'main.bib', text: BIB }], { only: new Set(['good', 'web']) });
  assert.deepStrictEqual([only.entries, only.withErrors], [2, 1]);
  assert.ok(only.md.includes('(2 ключів)'));
  I.setLang('en');
  try {
    const en = D.dstuReport([{ rel: 'main.bib', text: BIB }]).md;
    assert.ok(en.startsWith('# DSTU 8302:2015 — bibliography') && en.includes('missing journaltitle (journal), volume or number'), en);
  } finally { I.setLang('uk'); }
});

/* --------------------------------- floats --------------------------------- */
const base = path.resolve('/p');
const SX = [
  'SyncTeX Version:1', 'Input:1:./main.tex', 'Input:2:./Ch/Ch.tex', 'Output:pdf', 'Content:',
  '{1', '[2,10:0,0:0,0,0', 'h2,10:1,1:0,0,0', ']', '}1',
  '{2', '(2,20:1,1:0,0,0', 'x2,10:1,1', '}2',
  '{3', 'k2,30:1,1:5', '}3',
  '{5', '(2,40:1,2:0,0,0', 'g2,50:1,1', '}5',
  'Input:3:./Ch/late.tex', '{6', '$3,7:1,1', '}6',
  'Postamble:'
].join('\n');

t('floatsPure.synctexPages: the first page of a line, up to three lines back, inputs declared later, covers', () => {
  const at = FL.synctexPages(SX, base, false);
  const ch = path.join(base, 'Ch', 'Ch.tex');
  assert.strictEqual(at(ch, 10), 1, 'line 10 is on pages 1 and 2: the first');
  assert.strictEqual(at(ch, 22), 2, 'no record of 22: the record of 20');
  assert.strictEqual(at(ch, 25), null, 'nothing within three lines');
  assert.strictEqual(at(path.join(base, 'Ch', 'late.tex'), 7), 6);
  assert.ok(at.covers(ch) && !at.covers(path.join(base, 'other.tex')));
  assert.strictEqual(FL.synctexPages(SX, base, true)(path.join(base, 'CH', 'ch.TEX'), 30), 3, 'case-insensitive on Windows');
});

t('floatsPure.floatPlacement: far after, before, without references, unknown page; only floats; only the files of this PDF', () => {
  const ch = path.join(base, 'Ch', 'Ch.tex'), other = path.join(base, 'other.tex');
  const index = new Map([
    [ch, {
      labels: [
        { name: 'fig:far', line: 39, envs: ['figure'] }, { name: 'tab:before', line: 19, envs: ['table*'] },
        { name: 'fig:alone', line: 29, envs: ['center', 'figure'] }, { name: 'eq:x', line: 5, envs: ['equation'] },
        { name: 'fig:ok', line: 9, envs: ['figure'] }, { name: 'fig:roman', line: 49, envs: ['figure'] }
      ],
      refs: [{ name: 'fig:far', line: 9 }, { name: 'tab:before', line: 39 }, { name: 'eq:x', line: 9 }, { name: 'fig:ok', line: 19 }, { name: 'fig:roman', line: 9 }]
    }],
    [other, { labels: [{ name: 'fig:other', line: 1, envs: ['figure'] }], refs: [] }]
  ]);
  const aux = { 'fig:far': '5', 'tab:before': '1', 'fig:ok': '3', 'fig:roman': 'iv', 'eq:x': '1' };
  const r = FL.floatPlacement(index, (k) => aux[k] || null, FL.synctexPages(SX, base, false), (a) => path.relative(base, a).replace(/\\/g, '/'), 1);
  assert.deepStrictEqual(r.far.map((x) => [x.name, x.page, x.refPage, x.refAt]), [['fig:far', 5, 1, 'Ch/Ch.tex:10']]);
  assert.deepStrictEqual(r.before.map((x) => [x.name, x.page, x.refPage]), [['tab:before', 1, 5]]);
  assert.deepStrictEqual(r.unref.map((x) => x.name), ['fig:alone']);
  assert.deepStrictEqual([r.unknown, r.total], [1, 5]);
  const md = FL.formatFloats(r, { maxDist: 1 });
  assert.ok(md.includes('- Ch/Ch.tex:40 `fig:far` (figure) — с. 5; перше посилання Ch/Ch.tex:10 — с. 1'), md);
  assert.strictEqual(FL.floatPlacement(index, (k) => aux[k] || null, FL.synctexPages(SX, base, false), (a) => a, 4).far.length, 0, 'floatMaxPages = 4');
});

/* ------------------------------ PDF notes -------------------------------- */
const utf16 = (s) => '<FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex') + '>';
// a PDF with objects written in order, an object stream and an incremental update, like a viewer saves notes
function pdf(o) {
  const parts = ['%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'];
  const obj = (num, body) => parts.push(num + ' 0 obj\n' + body + '\nendobj\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  if (o.nested) {
    obj(2, '<< /Type /Pages /Kids [10 0 R 3 0 R] /Count 2 /MediaBox [0 0 600 800] >>');
    obj(10, '<< /Type /Pages /Parent 2 0 R /Kids [11 0 R] /Count 1 >>');
    obj(11, '<< /Type /Page /Parent 10 0 R /MediaBox [0 0 300 400] /Annots [12 0 R] >>');
    obj(12, '<< /Type /Annot /Subtype /FreeText /Rect [10 10 50 30] /Contents (\\(see\\) \\116ote\\\nhere) >>');
  } else obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 600 800] >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R 6 0 R 8 0 R] >>');
  obj(4, '<< /Type /Annot /Subtype /Text /Rect [300 500 320 520] /Contents ' + utf16('Перевірте знак') + ' /T (Reviewer) >>');
  obj(6, '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] >>');
  obj(8, '<< /Type /Annot /Subtype /Popup /Rect [0 0 1 1] >>');
  // object 5 lives in a compressed object stream; its text is UTF-8 without a BOM
  const inner = '<< /Type /Annot /Subtype /Highlight /Rect [100 690 200 700] /QuadPoints [100 700 200 700 100 690 200 690] /Contents (' + Buffer.from('Що це?', 'utf8').toString('latin1') + ') /T ' + utf16('Рецензент') + ' /IRT 4 0 R >>';
  const head = '5 0 ';
  const data = zlib.deflateSync(Buffer.from(head + inner, 'latin1'));
  parts.push('7 0 obj\n<< /Type /ObjStm /N 1 /First ' + head.length + ' /Filter /FlateDecode /Length ' + data.length + ' >>\nstream\n' + data.toString('latin1') + '\nendstream\nendobj\n');
  parts.push('xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 13 /Root 1 0 R' + (o.encrypt ? ' /Encrypt 9 0 R' : '') + ' >>\nstartxref\n0\n%%EOF\n');
  if (o.update) { obj(4, '<< /Type /Annot /Subtype /Text /Rect [300 500 320 520] /Contents (Changed) /T (Reviewer) >>'); parts.push('trailer\n<< /Size 13 /Root 1 0 R /Prev 0 >>\n%%EOF\n'); }
  return Buffer.from(parts.join(''), 'latin1');
}

t('annotsPure.readAnnotations: UTF-16 and UTF-8 texts, an object stream, links and popups skipped, a reply marked, the inherited MediaBox', () => {
  const r = A.readAnnotations(pdf({}));
  assert.strictEqual(r.pages, 1);
  assert.deepStrictEqual(r.annotations.map((a) => [a.page, a.type, a.author, a.text, a.reply]), [[1, 'Text', 'Reviewer', 'Перевірте знак', false], [1, 'Highlight', 'Рецензент', 'Що це?', true]]);
  assert.deepStrictEqual(r.annotations[1].quads, [[100, 700, 200, 700, 100, 690, 200, 690]]);
  assert.deepStrictEqual(r.annotations[0].box, [0, 0, 600, 800]);
});

t('annotsPure: an incremental update replaces an object; nested pages in order with their own MediaBox; escapes of literal strings; encrypted', () => {
  assert.strictEqual(A.readAnnotations(pdf({ update: true })).annotations[0].text, 'Changed');
  const nested = A.readAnnotations(pdf({ nested: true }));
  assert.strictEqual(nested.pages, 2);
  assert.deepStrictEqual(nested.annotations.map((a) => [a.page, a.type]), [[1, 'FreeText'], [2, 'Text'], [2, 'Highlight']]);
  assert.strictEqual(nested.annotations[0].text, '(see) Notehere');
  assert.deepStrictEqual(nested.annotations[0].box, [0, 0, 300, 400]);
  assert.deepStrictEqual(A.readAnnotations(pdf({ encrypt: true })), { error: 'encrypted' });
  assert.deepStrictEqual(A.readAnnotations(Buffer.from('not a pdf')), { error: 'no catalog' });
});

t('annotsPure: the crop for pdftotext and the point for synctex (from the top left corner); the answer of synctex edit; the TODO line', () => {
  const [note, hl] = A.readAnnotations(pdf({})).annotations;
  assert.deepStrictEqual(A.cropOf(hl), { x: 100, y: 100, w: 101, h: 11 });
  assert.deepStrictEqual(A.pointOf(hl), { x: 102, y: 105 });
  assert.deepStrictEqual(A.pointOf(note), { x: 310, y: 290 });
  const out = 'This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nOutput:D:/p/main.pdf\nInput:D:/p/./Ch/Ch.tex\nLine:120\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n';
  assert.deepStrictEqual(A.parseSynctexEdit(out), { input: 'D:/p/./Ch/Ch.tex', line: 120 });
  assert.strictEqual(A.parseSynctexEdit('SyncTeX result begin\nSyncTeX result end\n'), null);
  assert.strictEqual(A.todoComment(Object.assign({ quote: 'знак\n мінус' }, hl), { pageWord: 'с.' }), '% TODO: [Рецензент, с. 1] Що це? «знак мінус»');
  assert.strictEqual(A.todoComment({ type: 'StrikeOut', text: '', quote: 'зайве', page: 3, author: '' }, { keyword: 'FIXME', strike: 'прибрати:' }), '% FIXME: прибрати: «зайве»');
  assert.ok(A.todoComment({ type: 'Text', text: 'x'.repeat(600), page: 1 }).length < 420);
});

console.log('\n' + n + ' tests passed');
