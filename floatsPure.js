'use strict';
/* floatsPure.js: figures and tables printed far from the place where the text first refers to them. No VS Code API.
 * The page of a float is the page of its \label in the .aux; the page of a reference comes from the .synctex of the same build
 * (the first page on which a record of that source line is). The labels and the references are those of labels.js. */
const { tr } = require('./i18n');
const S = require('./synctexPure');

const FLOAT_ENV = /^(figure|table|sidewaysfigure|sidewaystable|wrapfigure|wraptable|SCfigure|SCtable|figwindow|tabwindow|marginfigure|margintable)\*?$/;

/* the whole text of a .synctex -> pageAt(absPath, line1) : the first page with a record of that line, or of one of the three
 * lines before it (a \ref in a line that made no box of its own); null when the file or the line is not in the PDF.
 * base: the folder of the .synctex (relative inputs); ci: case-insensitive paths (Windows, macOS) */
function synctexPages(text, base, ci) {
  const tags = new Map(); // tag -> normalized path
  const first = new Map(); // tag -> Map(line -> first page)
  let page = 0;
  for (const line of String(text || '').split('\n')) {
    const c = line.charCodeAt(0);
    if (c === 123 /* { */) { page = parseInt(line.slice(1), 10) || page; continue; }
    if (line.startsWith('Input:')) {
      const m = /^Input:(\d+):(.*)$/.exec(line.replace(/\r$/, ''));
      if (m) tags.set(m[1], S.normPath(m[2], base, ci));
      continue;
    }
    if (!page) continue;
    // records: [ ( h v x k g $ followed by tag,line:
    const m = /^[[(hvxkg$f](\d+),(\d+)[:,]/.exec(line);
    if (!m) continue;
    let byLine = first.get(m[1]);
    if (!byLine) { byLine = new Map(); first.set(m[1], byLine); }
    const ln = +m[2];
    if (!byLine.has(ln)) byLine.set(ln, page);
  }
  const byPath = new Map();
  for (const [tag, p] of tags) if (first.has(tag)) byPath.set(p, (byPath.get(p) || []).concat([first.get(tag)]));
  const pageAt = (abs, line1) => {
    const maps = byPath.get(S.normPath(abs, base, ci));
    if (!maps) return null;
    let best = null;
    for (const m of maps) {
      for (let l = line1; l >= Math.max(1, line1 - 3); l--) {
        if (m.has(l)) { const p = m.get(l); if (best === null || p < best) best = p; break; }
      }
    }
    return best;
  };
  pageAt.covers = (abs) => byPath.has(S.normPath(abs, base, ci)); // is the file a part of this PDF at all
  return pageAt;
}

/* index: Map abs -> { labels: [{ name, line, envs }], refs: [{ name, line }] } (labels.js buildIndex);
 * auxPage(name) -> page as printed in the .aux (a string) or null; pageAt from synctexPages; rel(abs) -> the path for the report;
 * maxDist: how many pages after the first reference a float may stand.
 * -> { far, before, unref, unknown, total } */
function floatPlacement(index, auxPage, pageAt, rel, maxDist) {
  const dist = maxDist === undefined ? 1 : maxDist;
  const refsOf = new Map();
  // only the files of this PDF: another document in the same folder has labels of its own
  const inPdf = (abs) => !pageAt.covers || pageAt.covers(abs);
  for (const [abs, d] of index) for (const r of d.refs || []) {
    if (!inPdf(abs)) continue;
    if (!refsOf.has(r.name)) refsOf.set(r.name, []);
    refsOf.get(r.name).push({ abs, line: r.line });
  }
  const far = [], before = [], unref = [];
  let unknown = 0, total = 0;
  for (const [abs, d] of index) for (const l of d.labels || []) {
    if (!inPdf(abs)) continue;
    const env = (l.envs || []).find((e) => FLOAT_ENV.test(e));
    if (!env) continue;
    total++;
    const at = rel(abs) + ':' + (l.line + 1);
    const refs = refsOf.get(l.name) || [];
    if (!refs.length) { unref.push({ name: l.name, env, at }); continue; }
    const fp = /^\d+$/.test(String(auxPage(l.name) || '').trim()) ? parseInt(auxPage(l.name), 10) : null;
    let rp = null, refAt = null;
    for (const r of refs) {
      const p = pageAt(r.abs, r.line + 1);
      if (p !== null && (rp === null || p < rp)) { rp = p; refAt = rel(r.abs) + ':' + (r.line + 1); }
    }
    if (fp === null || rp === null) { unknown++; continue; }
    const item = { name: l.name, env, at, page: fp, refPage: rp, refAt };
    if (fp < rp) before.push(item);
    else if (fp - rp > dist) far.push(item);
  }
  far.sort((a, b) => (b.page - b.refPage) - (a.page - a.refPage));
  return { far, before, unref, unknown, total };
}

// the Markdown of the result; level: '#' for a report of its own, '##' inside another one
function formatFloats(r, o) {
  const opt = o || {};
  const h = opt.level || '#';
  const out = [];
  out.push(h + ' ' + tr('Плаваючі об\'єкти й перші посилання'), '');
  out.push(tr('Рисунків і таблиць з \\label: {0}. Сторінку об\'єкта взято з .aux, сторінку посилання — з .synctex тієї самої збірки. Допустимо: на сторінці посилання або не далі ніж через {1} с. (`tssworkflow.floatMaxPages`).', r.total, opt.maxDist === undefined ? 1 : opt.maxDist), '');
  const row = (x) => '- ' + x.at + ' `' + x.name + '` (' + x.env + tr(') — с. {0}; перше посилання {1} — с. {2}', x.page, x.refAt, x.refPage);
  if (r.far.length) { out.push(h + '# ' + tr('Далеко після першого посилання ({0})', r.far.length), ''); for (const x of r.far) out.push(row(x)); out.push(''); }
  if (r.before.length) { out.push(h + '# ' + tr('Раніше за перше посилання ({0})', r.before.length), '', tr('Читач бачить рисунок, ще не знаючи, навіщо він.'), ''); for (const x of r.before) out.push(row(x)); out.push(''); }
  if (r.unref.length) { out.push(h + '# ' + tr('Без жодного посилання ({0})', r.unref.length), ''); for (const x of r.unref) out.push('- ' + x.at + ' `' + x.name + '` (' + x.env + ')'); out.push(''); }
  if (r.unknown) out.push(tr('Не вдалося визначити сторінку для {0} (немає в .aux або в .synctex: документ зібрано частково чи без SyncTeX).', r.unknown), '');
  if (!r.far.length && !r.before.length && !r.unref.length) out.push(tr('Усі рисунки й таблиці стоять поруч зі своїм першим посиланням.'), '');
  return out.join('\n');
}

module.exports = { FLOAT_ENV, synctexPages, floatPlacement, formatFloats };
