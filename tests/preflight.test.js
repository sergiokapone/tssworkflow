'use strict';
// node tests/preflight.test.js [path/to/extension]  - preflightPure.js: the outputs of pdffonts / pdfimages / pdfinfo, picture headers, the log, the report
const path = require('path'), assert = require('assert'), zlib = require('zlib');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const F = require(path.join(ext, 'preflightPure.js'));
const L = require(path.join(ext, 'logPure.js'));
const I = require(path.join(ext, 'i18n.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

// real output of pdffonts (Poppler 25): a name longer than its column pushes the rest of the row to the right
const FONTS = [
  'name                                 type              encoding         emb sub uni object ID',
  '------------------------------------ ----------------- ---------------- --- --- --- ---------',
  'OYXLAR+BookmanOldStyle               CID TrueType      Identity-H       yes yes yes     54  0',
  'SXKWSR+LMRoman12-Regular             Type 1C           Custom           yes yes no      56  0',
  'XUGMMF+TeXGyreScholaMath-Regular-Identity-H CID Type 0C       Identity-H       yes yes yes     59  0',
  'Helvetica                            Type 1            WinAnsi          no  no  no      70  0',
  'Helvetica                            Type 1            WinAnsi          no  no  no      71  0',
  '[none]                               Type 3            Custom           yes no  no      80  0',
  'CMUTypewriter-Regular-Identity-H     CID Type 0C (OT)  Identity-H       yes yes yes     90  0'
].join('\n');

t('parsePdffonts: the row is read from the right; a long name does not shift the columns; type with spaces, subset prefix', () => {
  const f = F.parsePdffonts(FONTS);
  assert.strictEqual(f.length, 7);
  const long = f.find((x) => x.base === 'TeXGyreScholaMath-Regular-Identity-H');
  assert.ok(long && long.emb && long.type === 'CID Type 0C' && long.encoding === 'Identity-H', JSON.stringify(long));
  assert.deepStrictEqual(f.map((x) => x.type), ['CID TrueType', 'Type 1C', 'CID Type 0C', 'Type 1', 'Type 1', 'Type 3', 'CID Type 0C (OT)']);
  assert.strictEqual(f[0].base, 'BookmanOldStyle');
  assert.deepStrictEqual(F.parsePdffonts('garbage\n\n'), []);
});

t('fontFindings: not embedded once per font, Type 3 apart, the rest counted', () => {
  const r = F.fontFindings(F.parsePdffonts(FONTS));
  assert.deepStrictEqual(r.notEmbedded.map((x) => x.base), ['Helvetica']);
  assert.deepStrictEqual(r.type3.map((x) => x.base), ['[none]']);
  assert.strictEqual(r.total, 6);
});

const IMAGES = [
  'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
  '--------------------------------------------------------------------------------------------',
  '   2     0 image    1704  1189  index   1   8  image  no       676  0   439   439 12.4K 0.6%',
  '  17     1 image     598   242  rgb     3   8  image  no       700  0   205   210 40.1K 9.2%',
  '  17     2 smask     598   242  gray    1   8  image  no       701  0   205   210 1.2K  0.8%',
  '  30     3 image    2000  1000  cmyk    4   8  jpeg   no       710  0   600   599 300K  3.7%',
  '  31     4 image    1000   800  icc     3   8  jpeg   no       711  0   150   150 80K   3.3%'
].join('\n');

t('parsePdfimages / imageFindings: masks skipped, the smaller of x / y ppi, sorted from the worst; RGB and ICC counted', () => {
  const im = F.parsePdfimages(IMAGES);
  assert.deepStrictEqual(im.map((i) => i.page), [2, 17, 30, 31]);
  const r = F.imageFindings(im, { minDpi: 300 });
  assert.deepStrictEqual(r.lowRes.map((i) => [i.page, i.ppi]), [[31, 150], [17, 205]]);
  assert.deepStrictEqual(r.rgb.map((i) => i.page), [17, 31]);
  assert.strictEqual(F.imageFindings(im, { minDpi: 150 }).lowRes.length, 0);
});

t('parsePdfinfo', () => {
  const r = F.parsePdfinfo('Producer:        LuaTeX-1.18.0\nPages:           489\nPage size:       595.276 x 841.89 pts (A4)\nPDF version:     1.7\n');
  assert.deepStrictEqual(r, { pages: 489, pageSize: '595.276 x 841.89 pts (A4)', version: '1.7', producer: 'LuaTeX-1.18.0' });
});

t('imageSize: PNG from IHDR, JPEG from SOF after other segments (APP0, DQT), progressive SOF2; other files null', () => {
  const crc = () => Buffer.alloc(4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(720, 0); ihdr.writeUInt32BE(541, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, crc(), zlib.deflateSync(Buffer.alloc(1))]);
  assert.deepStrictEqual(F.imageSize(png), { width: 720, height: 541, comps: null });
  const seg = (mk, body) => { const b = Buffer.alloc(4 + body.length); b[0] = 0xff; b[1] = mk; b.writeUInt16BE(body.length + 2, 2); body.copy(b, 4); return b; };
  const sof = (mk, w, h, c) => { const b = Buffer.alloc(6 + 3 * c); b[0] = 8; b.writeUInt16BE(h, 1); b.writeUInt16BE(w, 3); b[5] = c; return seg(mk, b); };
  const jpg = (s) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xdb, Buffer.alloc(65)), s, Buffer.from([0xff, 0xd9])]);
  assert.deepStrictEqual(F.imageSize(jpg(sof(0xc0, 1376, 768, 3))), { width: 1376, height: 768, comps: 3 });
  assert.deepStrictEqual(F.imageSize(jpg(sof(0xc2, 640, 480, 4))), { width: 640, height: 480, comps: 4 });
  assert.strictEqual(F.imageSize(Buffer.from('%PDF-1.5 not a picture at all')), null);
  assert.strictEqual(F.imageSize(null), null);
});

const LOG = [
  'This is LuaHBTeX, Version 1.18.0',
  '(./main.tex',
  '(./Ch/Ch.tex',
  'Overfull \\hbox (13.3pt too wide) in paragraph at lines 576--580',
  'Overfull \\hbox (2.0pt too wide) in paragraph at lines 10--11',
  'Overfull \\hbox (7.5pt too wide) in paragraph at lines 90--91',
  "LaTeX Warning: Reference `fig:x' on page 3 undefined on input line 42.",
  "LaTeX Warning: Citation `knuth' on page 4 undefined on input line 50.",
  'Missing character: There is no а (U+0430) in font [lmmono10-italic]:!',
  'Missing character: There is no б (U+0431) in font [lmmono10-italic]:!',
  'Missing character: There is no а (U+0430) in font [lmmono10-italic]:!',
  'Missing character: There is no ; (U+003B) in font nullfont!',
  'Missing character: There is no ; (U+003B) in font nullfont!',
  ')',
  './Ch/Ch.tex:12: Undefined control sequence.',
  'l.12 \\foo',
  ')',
  'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.'
].join('\n');

t('logPure.parseLog marks every item with kind (overfull with pts, ref, cite), whatever the language', () => {
  for (const lang of ['uk', 'en']) {
    I.setLang(lang);
    const k = L.parseLog(LOG, 5).map((i) => i.kind + (i.pts ? ':' + i.pts : ''));
    assert.deepStrictEqual(k, ['overfull:13.3', 'overfull:7.5', 'ref', 'cite'], lang);
  }
  I.setLang('uk');
});

t('logFindings: places relative to the project root, overfull from the widest, errors, glyphs, the rerun sign', () => {
  const r = F.logFindings(LOG, { cwd: path.resolve('/p/out'), root: path.resolve('/p'), overfull: 5 });
  assert.deepStrictEqual(r.overfull, [{ at: 'out/Ch/Ch.tex:576', pts: 13.3 }, { at: 'out/Ch/Ch.tex:90', pts: 7.5 }]);
  assert.deepStrictEqual(r.undefRefs.map((x) => x.at), ['out/Ch/Ch.tex:42']);
  assert.deepStrictEqual(r.undefCites.map((x) => x.at), ['out/Ch/Ch.tex:50']);
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].at === 'out/Ch/Ch.tex:12' && /Undefined control sequence/.test(r.errors[0].message), JSON.stringify(r.errors));
  assert.strictEqual(r.missing.length, 5);
  assert.strictEqual(r.rerun, true);
  assert.strictEqual(F.logFindings('This is LuaHBTeX\n(./main.tex)\n', {}).rerun, false);
});

const base = () => ({
  pdf: path.resolve('/p/main.pdf'), root: path.resolve('/p'), info: F.parsePdfinfo('Pages: 10\nPage size: A4\nPDF version: 1.7'), stale: [],
  fonts: { list: F.parsePdffonts(FONTS) }, fontFiles: new Map([['Helvetica', ['Ch/Pictures/plot.pdf']]]),
  images: { list: F.parsePdfimages(IMAGES) }, imageFiles: new Map([['598×242', ['Ch/Pictures/rub.png']]]),
  log: F.logFindings(LOG, { cwd: path.resolve('/p'), root: path.resolve('/p') }), todos: [{ at: 'Ch/Ch.tex:3', kw: 'TODO', text: 'рисунок' }], iffalse: ['Ch/Ch.tex:7']
});

t('formatReport: the verdict, errors before warnings, places as file:line (links), the picture and font files found', () => {
  const md = F.formatReport(base(), { minDpi: 300 });
  assert.ok(md.startsWith('# Перевірка перед друком — main.pdf'), md.slice(0, 80));
  const sum = md.slice(md.indexOf('## Підсумок'), md.indexOf('**Не готово'));
  const marks = sum.split('\n').filter((l) => l.startsWith('- ')).map((l) => l[2]);
  assert.deepStrictEqual(marks, [...marks].sort((a, b) => '✗⚠✓'.indexOf(a) - '✗⚠✓'.indexOf(b)), 'errors, then warnings, then the good news');
  assert.ok(/\*\*Не готово до друку\.\*\* Блокувальних проблем: 4\./.test(md), 'fonts, errors, undefined, glyphs');
  assert.ok(md.includes('- `Helvetica` (Type 1) — у Ch/Pictures/plot.pdf'));
  assert.ok(md.includes('| 17 | 205 | 598×242 | Ch/Pictures/rub.png |'));
  assert.ok(md.includes('| 31 | 150 | 1000×800 | ? |'));
  assert.ok(md.includes('- Ch/Ch.tex:42 — '));
  assert.ok(md.includes('- Ch/Ch.tex:576 — 13.3pt'));
  assert.ok(md.includes('- Ch/Ch.tex:3 — TODO: рисунок') && md.includes('- Ch/Ch.tex:7'));
  // glyphs: one line per font, with the count and the hint about Cyrillic; nullfont is a warning about TikZ code, not an error
  assert.ok(md.includes('- `[lmmono10-italic]` ×3: а б — у шрифті немає кирилиці'), md);
  assert.ok(/⚠ зайвих символів у коді рисунків \(nullfont\): 2/.test(md));
  assert.ok(md.includes('- U+003B «;» — nullfont ×2'));
  assert.ok(md.includes('RGB: 2'), 'RGB is only counted without requireCmyk');
  assert.ok(/⚠ рисунків у RGB: 2/.test(F.formatReport(base(), { cmyk: true })));
});

t('formatReport: a clean PDF is ready; missing tools and log are said, not hidden; a stale PDF is a warning', () => {
  const clean = Object.assign(base(), {
    fonts: { list: F.parsePdffonts(FONTS).filter((f) => f.emb && !/Type 3/.test(f.type)) }, images: { list: [] },
    log: F.logFindings('(./main.tex)\n', {}), todos: [], iffalse: []
  });
  const md = F.formatReport(clean, {});
  assert.ok(md.includes('**Готово до друку.**'), md);
  assert.ok(md.includes('Растрових рисунків у PDF немає.'));
  const broken = Object.assign(clean, { fonts: { error: 'pdffonts не знайдено' }, images: { error: 'pdfimages не знайдено' }, log: null, stale: ['Ch/Ch.tex'] });
  const b = F.formatReport(broken, {});
  assert.ok(b.includes('pdffonts не знайдено') && b.includes('pdfimages не знайдено') && b.includes('Лог цієї збірки не знайдено'));
  assert.ok(/⚠ PDF старіший за джерела \(1\)/.test(b) && b.includes('- Ch/Ch.tex'));
  assert.ok(b.includes('**Блокувальних проблем немає**'));
});

t('formatReport in English: no Ukrainian left except the data (TODO text, the letters that are missing)', () => {
  I.setLang('en');
  try {
    const md = F.formatReport(base(), { minDpi: 300 });
    assert.ok(md.startsWith('# Check before print — main.pdf'));
    assert.ok(md.includes('**Not ready for print.** Blocking problems: 4.'));
    const rest = md.replace('TODO: рисунок', '').replace(/: а б — /, '');
    assert.ok(!/[а-яіїєґ]/i.test(rest), rest.split('\n').filter((l) => /[а-яіїєґ]/i.test(l)).join('\n'));
  } finally { I.setLang('uk'); }
});

console.log('\n' + n + ' tests passed');
