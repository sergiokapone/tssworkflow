'use strict';
/* preflightPure.js: "Check before print" without VS Code. Reads what the tools of TeX Live print about a finished PDF
 * (pdffonts, pdfimages -list, pdfinfo: Poppler / Xpdf), the size of PNG / JPEG files from their headers, and builds the
 * Markdown report out of these facts and of the .log of the same build (logPure.js).
 * Places in the report are written as `Розділ/Розділ.tex:12`, which the report documents turn into links (projectRefactor.js). */
const path = require('path');
const { tr } = require('./i18n');
const L = require('./logPure');
const FL = require('./floatsPure');

const posix = (p) => String(p).replace(/\\/g, '/');

/* pdffonts -> [{ name, base, type, encoding, emb, sub }] (base: the name without the subset prefix ABCDEF+).
 * A row is read from the right: `emb sub uni object gen` are always there; before them the encoding (one word), the name is
 * the first word and the type (`CID Type 0C`, `TrueType (OT)`) is what lies between. The columns are not cut by position:
 * a name longer than its column (…-Identity-H) pushes the rest of the row to the right. */
function parsePdffonts(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 8) continue;
    const tail = t.slice(-5);
    if (!/^(yes|no)$/.test(tail[0]) || !/^(yes|no)$/.test(tail[1]) || !/^(yes|no)$/.test(tail[2]) || !/^\d+$/.test(tail[3]) || !/^\d+$/.test(tail[4])) continue;
    out.push({
      name: t[0], base: t[0].replace(/^[A-Z]{6}\+/, ''), type: t.slice(1, -6).join(' '), encoding: t[t.length - 6],
      emb: tail[0] === 'yes', sub: tail[1] === 'yes'
    });
  }
  return out;
}

// pdfimages -list -> [{ page, type, width, height, color, xppi, yppi }]; masks (smask, stencil) are not pictures of their own
function parsePdfimages(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 14 || !/^\d+$/.test(t[0]) || !/^\d+$/.test(t[1])) continue;
    out.push({ page: +t[0], type: t[2], width: +t[3], height: +t[4], color: t[5], xppi: +t[12], yppi: +t[13] });
  }
  return out.filter((i) => i.type === 'image');
}

// pdfinfo -> { pages, pageSize, version, producer }
function parsePdfinfo(text) {
  const o = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) o[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { pages: o.pages ? +o.pages : null, pageSize: o['page size'] || '', version: o['pdf version'] || '', producer: o.producer || '' };
}

// the pixel size of a PNG / JPEG from the first bytes of the file: { width, height, comps } or null
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), comps: null };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const mk = buf[i + 1];
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7) || mk === 0xff) { i += mk === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
      }
      i += 2 + len;
    }
  }
  return null;
}

// the log of the build: what keeps the PDF from being final
function logFindings(log, o) {
  const opt = o || {};
  const text = String(log || '');
  const rel = (f) => (opt.cwd && opt.root ? posix(path.relative(opt.root, path.resolve(opt.cwd, f))) : posix(f).replace(/^\.\//, ''));
  const issues = L.parseLog(text, opt.overfull === undefined ? 5 : opt.overfull);
  const at = (it) => rel(it.file) + ':' + (it.line + 1);
  const overfull = [], undefRefs = [], undefCites = [];
  for (const it of issues) {
    if (it.kind === 'overfull') overfull.push({ at: at(it), pts: it.pts });
    else if (it.kind === 'ref') undefRefs.push({ at: at(it), message: it.message });
    else if (it.kind === 'cite') undefCites.push({ at: at(it), message: it.message });
  }
  overfull.sort((a, b) => b.pts - a.pts);
  const errors = L.parseLogErrors(text).map((e) => ({ at: e.file ? rel(e.file) + ':' + (e.line + 1) : '', message: e.message }));
  const missing = L.missingCharLines(text);
  const rerun = /Label\(s\) may have changed|Rerun to get|There were undefined references|Please \(re\)run Biber|Please rerun LaTeX/.test(text);
  return { overfull, undefRefs, undefCites, errors, missing, rerun };
}

// fonts: not embedded (the printer substitutes them) and Type 3 (bitmap fonts: blurred in print)
function fontFindings(fonts) {
  const seen = new Set();
  const notEmbedded = [], type3 = [];
  for (const f of fonts || []) {
    const key = f.base + '|' + f.type;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!f.emb) notEmbedded.push(f);
    else if (/Type 3/.test(f.type)) type3.push(f);
  }
  return { notEmbedded, type3, total: seen.size };
}

// pictures: the resolution at which they are printed (the smaller of x / y), the colour space
function imageFindings(images, o) {
  const minDpi = (o && o.minDpi) || 300;
  const lowRes = [], rgb = [];
  for (const im of images || []) {
    const ppi = Math.min(im.xppi || 0, im.yppi || 0);
    if (ppi && ppi < minDpi) lowRes.push(Object.assign({ ppi }, im));
    if (/^(rgb|icc)$/.test(im.color)) rgb.push(im);
  }
  lowRes.sort((a, b) => a.ppi - b.ppi);
  return { lowRes, rgb, total: (images || []).length };
}

const pages = (list) => {
  const p = [...new Set(list.map((i) => i.page))].sort((a, b) => a - b);
  return p.length > 12 ? p.slice(0, 12).join(', ') + ' …' : p.join(', ');
};

/* d: { pdf, root, info, stale: [rel], fonts: { list, error }, fontFiles: Map base -> [rel], images: { list, error },
 *      imageFiles: Map 'w×h' -> [rel], log: logFindings | null, todos: [{ at, kw, text }], iffalse: [at] }
 * o: { minDpi, cmyk } -> Markdown */
function formatReport(d, o) {
  const opt = o || {};
  const minDpi = opt.minDpi || 300;
  const out = [];
  const sum = [];
  const add = (sev, what) => sum.push(sev + ' ' + what);
  const ERR = '✗', WARN = '⚠', OK = '✓';
  const relPdf = posix(path.relative(d.root, d.pdf));
  out.push(tr('# Перевірка перед друком — {0}', relPdf), '');
  if (d.info && d.info.pages) out.push(tr('Сторінок: {0}; формат: {1}; PDF {2}.', d.info.pages, d.info.pageSize || '?', d.info.version || '?'), '');

  // the PDF is older than the sources
  const body = [];
  if (d.stale && d.stale.length) {
    add(WARN, tr('PDF старіший за джерела ({0})', d.stale.length));
    body.push(tr('## PDF застарів'), '', tr('Ці файли змінено після збірки PDF; решта звіту описує старий PDF. Збери документ і онови звіт.'), '');
    for (const f of d.stale.slice(0, 20)) body.push('- ' + f);
    if (d.stale.length > 20) body.push(tr('- …і ще {0}', d.stale.length - 20));
    body.push('');
  }

  // fonts
  body.push(tr('## Шрифти'), '');
  if (d.fonts.error) { add(WARN, tr('шрифти не перевірено')); body.push(d.fonts.error, ''); }
  else {
    const ff = fontFindings(d.fonts.list);
    const where = (f) => { const w = d.fontFiles && d.fontFiles.get(f.base); return w && w.length ? tr(' — у {0}', w.slice(0, 5).join(', ')) : ''; };
    if (ff.notEmbedded.length) {
      add(ERR, tr('не вбудовані шрифти: {0}', ff.notEmbedded.length));
      body.push(tr('Не вбудовані (друкарня підставить інший шрифт, текст зсунеться). Зазвичай вони приходять з PDF-рисунків (matplotlib, Inkscape, Excel): збережи рисунок із вбудованими шрифтами або перетвори текст на криві.'), '');
      for (const f of ff.notEmbedded) body.push('- `' + f.base + '` (' + f.type + ')' + where(f));
      body.push('');
    }
    if (ff.type3.length) {
      add(WARN, tr('растрові шрифти Type 3: {0}', ff.type3.length));
      body.push(tr('Шрифти Type 3 (часто растрові: розмиті в друці й при збільшенні). Джерела ті самі: рисунки або старі шрифти METAFONT.'), '');
      for (const f of ff.type3) body.push('- `' + f.base + '`' + where(f));
      body.push('');
    }
    if (!ff.notEmbedded.length && !ff.type3.length) { add(OK, tr('шрифти вбудовані ({0})', ff.total)); body.push(tr('Усі {0} шрифтів вбудовані, Type 3 немає.', ff.total), ''); }
  }

  // pictures
  body.push(tr('## Растрові рисунки'), '');
  if (d.images.error) { add(WARN, tr('рисунки не перевірено')); body.push(d.images.error, ''); }
  else {
    const fi = imageFindings(d.images.list, { minDpi });
    const files = (im) => { const w = d.imageFiles && d.imageFiles.get(im.width + '×' + im.height); return w && w.length ? ' — ' + w.slice(0, 3).join(', ') : ''; };
    if (fi.lowRes.length) {
      add(WARN, tr('рисунків з роздільністю нижче {0} ppi: {1}', minDpi, fi.lowRes.length));
      body.push(tr('Роздільність у PDF (з урахуванням розміру на сторінці) нижча за {0} ppi (`tssworkflow.preflight.minDpi`): у друці буде видно пікселі. Візьми більший оригінал або зменш рисунок на сторінці.', minDpi), '');
      body.push(tr('| Сторінка | ppi | Пікселі | Файл |'), '|---|---|---|---|');
      for (const im of fi.lowRes.slice(0, 60)) body.push('| ' + im.page + ' | ' + im.ppi + ' | ' + im.width + '×' + im.height + ' | ' + (files(im).replace(/^ — /, '') || '?') + ' |');
      if (fi.lowRes.length > 60) body.push('', tr('…і ще {0}.', fi.lowRes.length - 60));
      body.push('');
    } else if (fi.total) { add(OK, tr('рисунки ≥ {0} ppi ({1})', minDpi, fi.total)); body.push(tr('Усі {0} растрових рисунків мають не менше {1} ppi.', fi.total, minDpi), ''); }
    else body.push(tr('Растрових рисунків у PDF немає.'), '');
    if (fi.rgb.length) {
      if (opt.cmyk) {
        add(WARN, tr('рисунків у RGB: {0}', fi.rgb.length));
        body.push(tr('Рисунки в RGB, а друкарня просить CMYK (`tssworkflow.preflight.requireCmyk`). Сторінки: {0}.', pages(fi.rgb)), '');
      } else body.push(tr('Рисунків у RGB: {0} (сторінки {1}). Якщо друкарня вимагає CMYK, увімкни `tssworkflow.preflight.requireCmyk`.', fi.rgb.length, pages(fi.rgb)), '');
    }
  }

  // the log
  body.push(tr('## Лог збірки'), '');
  const lg = d.log;
  if (!lg) { add(WARN, tr('лог не знайдено')); body.push(tr('Лог цієї збірки не знайдено поруч із PDF.'), ''); }
  else {
    const any = lg.errors.length || lg.undefRefs.length || lg.undefCites.length || lg.overfull.length || lg.missing.length || lg.rerun;
    if (lg.errors.length) {
      add(ERR, tr('помилок LaTeX: {0}', lg.errors.length));
      body.push(tr('### Помилки'), '');
      for (const e of lg.errors.slice(0, 30)) body.push('- ' + (e.at ? e.at + ' — ' : '') + e.message);
      body.push('');
    }
    if (lg.rerun) { add(WARN, tr('PDF не остаточний: треба ще прохід')); body.push(tr('Лог просить ще один прохід (мітки змінились або бібліографія не зібрана): номери сторінок і посилання можуть бути неправильні.'), ''); }
    if (lg.undefRefs.length || lg.undefCites.length) {
      add(ERR, tr('невизначених посилань: {0}, цитат: {1}', lg.undefRefs.length, lg.undefCites.length));
      body.push(tr('### Невизначені посилання й цитати (у PDF надруковано ??)'), '');
      for (const r of lg.undefRefs.concat(lg.undefCites).slice(0, 60)) body.push('- ' + r.at + ' — ' + r.message);
      body.push('');
    }
    // one line per character and font, with the count; nullfont is the font of the code of a TikZ picture: a stray character
    // there is not printed at all, so it is a typo in the picture, not a lost letter of the text
    const groups = new Map();
    for (const m of lg.missing) {
      const k = m.code + '|' + m.font;
      if (!groups.has(k)) groups.set(k, { code: m.code, font: m.font, n: 0, lines: [] });
      const g = groups.get(k);
      g.n++;
      if (m.line && g.lines.length < 5 && !g.lines.includes(m.line)) g.lines.push(m.line);
    }
    const glyph = (g) => '- U+' + g.code.toString(16).toUpperCase().padStart(4, '0') + ' «' + String.fromCodePoint(g.code) + '» — ' + g.font +
      (g.n > 1 ? ' ×' + g.n : '') + (g.lines.length ? tr(', рядок {0}', g.lines.join(', ')) : '');
    const lost = [...groups.values()].filter((g) => g.font !== 'nullfont');
    const tikz = [...groups.values()].filter((g) => g.font === 'nullfont');
    if (lost.length) {
      add(ERR, tr('відсутніх гліфів: {0}', lost.reduce((s, g) => s + g.n, 0)));
      body.push(tr('### Відсутні гліфи (символу немає у шрифті, у PDF він пропав)'), '');
      // one line per font: a font without Cyrillic loses dozens of letters at once
      const byFont = new Map();
      for (const g of lost) { if (!byFont.has(g.font)) byFont.set(g.font, []); byFont.get(g.font).push(g); }
      for (const [font, gs] of byFont) {
        const n = gs.reduce((s, g) => s + g.n, 0);
        const chars = gs.slice(0, 40).map((g) => String.fromCodePoint(g.code)).join(' ');
        const cyr = gs.some((g) => g.code >= 0x400 && g.code <= 0x4ff);
        body.push('- `' + font.replace(/:$/, '') + '` ×' + n + ': ' + chars + (gs.length > 40 ? ' …' : '') + (cyr ? tr(' — у шрифті немає кирилиці') : ''));
      }
      body.push('');
    }
    if (tikz.length) {
      add(WARN, tr('зайвих символів у коді рисунків (nullfont): {0}', tikz.reduce((s, g) => s + g.n, 0)));
      body.push(tr('### Зайві символи в коді рисунків (nullfont)'), '', tr('Символ потрапив туди, де TikZ нічого не друкує (зайва `;` чи `,`, текст поза `node`). У PDF його немає, але це ознака помилки в коді рисунка. Місце знайдеш у лозі за рядком «Missing character».'), '');
      for (const g of tikz.slice(0, 30)) body.push(glyph(g));
      body.push('');
    }
    if (lg.overfull.length) {
      add(WARN, 'Overfull \\hbox: ' + lg.overfull.length);
      body.push(tr('### Рядки, що вилазять на поле (Overfull \\hbox, від найширших)'), '');
      for (const b of lg.overfull.slice(0, 40)) body.push('- ' + b.at + ' — ' + b.pts + 'pt');
      if (lg.overfull.length > 40) body.push(tr('- …і ще {0}', lg.overfull.length - 40));
      body.push('');
    }
    if (!any) { add(OK, tr('лог чистий')); body.push(tr('Помилок, невизначених посилань, відсутніх гліфів і Overfull \\hbox немає.'), ''); }
  }

  // floats far from their first reference (floatsPure.js): only when the .aux and the .synctex were readable
  if (d.floats && d.floats.r) {
    const fr = d.floats.r;
    if (fr.far.length + fr.before.length) add(WARN, tr('рисунків і таблиць не біля першого посилання: {0}', fr.far.length + fr.before.length));
    if (fr.unref.length) add(WARN, tr('рисунків і таблиць без посилань: {0}', fr.unref.length));
    if (!fr.far.length && !fr.before.length && !fr.unref.length && fr.total) add(OK, tr('рисунки й таблиці біля посилань ({0})', fr.total));
    body.push(FL.formatFloats(fr, { level: '##', maxDist: opt.floatMaxPages }));
  } else if (d.floats && d.floats.error) body.push('## ' + tr('Плаваючі об\'єкти й перші посилання'), '', d.floats.error, '');

  // the sources
  body.push(tr('## Джерела'), '');
  if (d.todos.length) {
    add(WARN, tr('позначок TODO / FIXME: {0}', d.todos.length));
    body.push(tr('### Незакриті позначки'), '');
    for (const t of d.todos.slice(0, 60)) body.push('- ' + t.at + ' — ' + t.kw + (t.text ? ': ' + t.text : ''));
    if (d.todos.length > 60) body.push(tr('- …і ще {0}', d.todos.length - 60));
    body.push('');
  }
  if (d.iffalse.length) {
    add(WARN, tr('блоків \\iffalse: {0}', d.iffalse.length));
    body.push(tr('### Вимкнений текст (\\iffalse … \\fi)'), '', tr('Перевір, що він вимкнений навмисно.'), '');
    for (const a of d.iffalse.slice(0, 40)) body.push('- ' + a);
    body.push('');
  }
  if (!d.todos.length && !d.iffalse.length) { add(OK, tr('джерела без позначок')); body.push(tr('Позначок TODO / FIXME і блоків \\iffalse немає.'), ''); }

  out.push(tr('## Підсумок'), '');
  for (const s of sum.filter((x) => x.startsWith(ERR))) out.push('- ' + s);
  for (const s of sum.filter((x) => x.startsWith(WARN))) out.push('- ' + s);
  for (const s of sum.filter((x) => x.startsWith(OK))) out.push('- ' + s);
  const errs = sum.filter((x) => x.startsWith(ERR)).length;
  out.push('', errs ? tr('**Не готово до друку.** Блокувальних проблем: {0}.', errs) : sum.some((x) => x.startsWith(WARN)) ? tr('**Блокувальних проблем немає**, але перегляньте попередження.') : tr('**Готово до друку.**'), '');
  return out.concat(body).join('\n');
}

module.exports = { parsePdffonts, parsePdfimages, parsePdfinfo, imageSize, logFindings, fontFindings, imageFindings, formatReport };
