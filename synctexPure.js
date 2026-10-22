'use strict';
/* synctexPure.js: what the .synctex.gz of a build says about the files of the PDF (no VS Code API).
 * A build of one chapter through alone.tex rewrites main.pdf and main.synctex.gz, so the PDF on the screen often does not
 * contain the file whose line the user wants to see: SumatraPDF / LaTeX Workshop then silently do nothing. */

// [{ n, path }] from the header of a .synctex file (the lines `Input:<n>:<path>` before `Content:`)
function parseSynctexInputs(text) {
  const s = String(text || '');
  const end = s.indexOf('\nContent:');
  const head = end > 0 ? s.slice(0, end) : s;
  const out = [];
  const re = /^Input:(\d+):(.*)$/gm;
  let m;
  while ((m = re.exec(head)) !== null) out.push({ n: Number(m[1]), path: m[2].replace(/\r$/, '') });
  return out;
}

// a path in one spelling: forward slashes, no `.` and `..`, relative ones resolved against base; lower case when ci (Windows)
function normPath(p, base, ci) {
  let s = String(p || '').replace(/\\/g, '/');
  const abs = /^([A-Za-z]:)?\//.test(s);
  if (!abs && base) s = String(base).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + s;
  const m = /^([A-Za-z]:)?(\/?)(.*)$/.exec(s);
  const parts = [];
  for (const seg of m[3].split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  const r = (m[1] || '') + (m[2] ? '/' : '') + parts.join('/');
  return ci ? r.toLowerCase() : r;
}

const baseName = (p) => String(p).replace(/\\/g, '/').split('/').pop();

/* inputs: parseSynctexInputs(..); file: the file of the editor; base: the directory the recorded paths are relative to (the
 * folder of the .synctex.gz); root: the project folder; ci: compare ignoring case.
 * -> { status: 'ok' | 'case' | 'name' | 'missing', recorded, resolved, candidates: [recorded], inProject: [path relative to root], total } */
function synctexReport({ inputs, file, base, root, ci }) {
  const list = inputs || [];
  const want = normPath(file, base, false);
  const wantCi = normPath(file, base, true);
  let hit = list.find((i) => normPath(i.path, base, false) === want);
  let status = hit ? 'ok' : 'missing';
  if (!hit) {
    hit = list.find((i) => normPath(i.path, base, true) === wantCi);
    if (hit) status = ci ? 'case' : 'name'; // a different spelling that is the same file only on a case-insensitive system
  }
  let candidates = [];
  if (hit && status === 'name') candidates = [hit.path];
  if (!hit) {
    const name = baseName(file).toLowerCase();
    candidates = list.filter((i) => baseName(i.path).toLowerCase() === name).map((i) => i.path);
    if (candidates.length) status = 'name';
  }
  const rootN = root ? normPath(root, '', false).replace(/\/+$/, '') + '/' : '';
  const inProject = [];
  for (const i of list) {
    if (!/\.(?:tex|tikz|ltx)$/i.test(i.path)) continue;
    const n = normPath(i.path, base, false);
    if (rootN && n.startsWith(rootN)) inProject.push(n.slice(rootN.length));
  }
  return {
    status,
    recorded: hit ? hit.path : null,
    resolved: hit ? normPath(hit.path, base, false) : null,
    candidates,
    inProject,
    total: list.length
  };
}

// the path to give the viewer when the PDF spells the file differently (other case): the recorded spelling, with the separators of `like`
function spelledAsRecorded(report, like) {
  if (!report || report.status !== 'case' || !report.resolved) return null;
  return /\\/.test(String(like || '')) ? report.resolved.replace(/\//g, '\\') : report.resolved;
}

const hhmmss = (t) => { const d = new Date(t); const z = (x) => String(x).padStart(2, '0'); return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); };

const { tr } = require('./i18n');

/* ctx: { pdf, synctex (path or null), synctexMtime, fileMtime, file, line, root } -> markdown lines */
function formatSynctexReport(report, ctx) {
  const L = [tr('# Діагностика SyncTeX'), ''];
  L.push('- PDF: `' + ctx.pdf + '`');
  L.push('- ' + (ctx.synctex ? tr('Файл синхронізації: `{0}` (оновлено {1})', ctx.synctex, hhmmss(ctx.synctexMtime)) : tr('Файл синхронізації: **немає**')));
  L.push('- ' + (ctx.line ? tr('Файл редактора: `{0}`, рядок {1}', ctx.file, ctx.line) : tr('Файл редактора: `{0}`', ctx.file)));
  L.push('');
  if (!ctx.synctex) {
    L.push(tr('✗ Немає `<job>.synctex.gz` поруч із PDF. Або збірка йшла без `-synctex=1`, або результат лежить в іншому каталозі (LaTeX Workshop: `latex-workshop.latex.outDir`).'));
    return L;
  }
  const rep = report || { status: 'missing', candidates: [], inProject: [], total: 0 };
  if (rep.status === 'ok') {
    L.push(tr('✓ Файл є в PDF (записаний як `{0}`). Перехід має працювати.', rep.recorded));
  } else if (rep.status === 'case') {
    L.push(tr('⚠ Файл є в PDF, але записаний інакше: `{0}`. SumatraPDF порівнює шляхи без пом\'якшень, тому плагін сам підставляє записаний шлях.', rep.recorded));
  } else if (rep.status === 'name') {
    L.push(tr('✗ У PDF немає саме цього шляху, але є файл із такою самою назвою:'));
    for (const c of rep.candidates) L.push('  - `' + c + '`');
    L.push(tr('Імовірно, PDF зібрано з іншої копії проєкту або з іншого каталогу.'));
  } else {
    L.push(tr('✗ Цього файла немає в останній збірці PDF. Найчастіша причина: PDF зібрано з іншого розділу (збірка розділу через `alone.tex` перезаписує `main.pdf` і `main.synctex.gz`). Збери цей файл (▷) і повтори.'));
  }
  if (rep.status !== 'ok' && rep.inProject && rep.inProject.length) {
    L.push('', tr('У PDF зараз файли проєкту ({0}):', rep.inProject.length));
    for (const p of rep.inProject.slice(0, 12)) L.push('- `' + p + '`');
    if (rep.inProject.length > 12) L.push('- ' + tr('… ще {0}', rep.inProject.length - 12));
  }
  if ((rep.status === 'ok' || rep.status === 'case') && ctx.fileMtime && ctx.synctexMtime && ctx.fileMtime > ctx.synctexMtime + 1000) {
    L.push('', tr('⚠ Файл змінено після останньої збірки ({0} проти {1}): рядки в PDF можуть не збігатися. Збери ще раз.', hhmmss(ctx.fileMtime), hhmmss(ctx.synctexMtime)));
  }
  L.push('', tr('Внутрішній вьюер LaTeX Workshop (`Ctrl+Alt+J`) читає ті самі дані: якщо тут ✗, там теж не спрацює.'));
  return L;
}

module.exports = { parseSynctexInputs, normPath, synctexReport, spelledAsRecorded, formatSynctexReport };
