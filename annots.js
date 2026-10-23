'use strict';
/* annots.js: "Reviewer notes from a PDF → TODO". The notes of a PDF a reviewer returned (annotsPure.js reads them), the marked
 * text under a highlight (pdftotext of that rectangle), the place in the sources (synctex edit on the PDF of the current build,
 * which must have the same pages as the reviewed copy). A report with `file:line` links; then, if the user agrees, a line
 * `% TODO: [reviewer, p. N] note «text»` above each place, so the TODO panel lists them. The files are changed, not saved. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const A = require('./annotsPure');
const { tr } = require('./i18n');
const { cfg, info, projectRoot, warn } = require('./util');

const MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
const hasSynctex = (pdf) => !!pdf && ['.synctex.gz', '.synctex'].some((e) => fs.existsSync(pdf.slice(0, pdf.length - path.extname(pdf).length) + e));

// { list, pages, buildPages, mapped } or { error }
async function compute(reviewPdf, buildPdf) {
  const { tool, pool } = require('./preflight');
  let r;
  try { r = A.readAnnotations(await fs.promises.readFile(reviewPdf)); } catch (e) { return { error: tr('Не вдалося прочитати {0}: {1}', path.basename(reviewPdf), e.message) }; }
  if (r.error) return { error: r.error === 'encrypted' ? tr('{0} зашифрований: приміток не прочитати.', path.basename(reviewPdf)) : tr('{0}: не вдалося розібрати структуру PDF.', path.basename(reviewPdf)) };
  const list = r.annotations;
  await pool(list.filter((a) => MARKUP.has(a.type)), 4, async (a) => {
    const c = A.cropOf(a);
    if (!c) return;
    const t = await tool('pdftotext', ['-f', String(a.page), '-l', String(a.page), '-x', String(c.x), '-y', String(c.y), '-W', String(c.w), '-H', String(c.h), '-enc', 'UTF-8', '-nopgbrk', reviewPdf, '-']);
    if (!t.error) a.quote = t.out.replace(/\s+/g, ' ').trim();
  });
  let buildPages = null;
  const sync = hasSynctex(buildPdf);
  if (sync) {
    try { buildPages = A.readAnnotations(await fs.promises.readFile(buildPdf)).pages || null; } catch (e) { buildPages = null; }
    const cwd = path.dirname(buildPdf);
    await pool(list, 4, async (a) => {
      const p = A.pointOf(a);
      const t = await tool('synctex', ['edit', '-o', a.page + ':' + p.x.toFixed(1) + ':' + p.y.toFixed(1) + ':' + buildPdf, '-d', cwd]);
      const e = t.error ? null : A.parseSynctexEdit(t.out);
      if (e) { a.abs = path.resolve(cwd, e.input); a.line = e.line - 1; }
    });
  }
  return { list, pages: r.pages, buildPages, sync, mapped: list.filter((a) => a.abs && fs.existsSync(a.abs)) };
}

function reportMd(c, reviewPdf, buildPdf, root) {
  const rel = (abs) => path.relative(root, abs).replace(/\\/g, '/');
  const out = [tr('# Примітки рецензента — {0}', path.basename(reviewPdf)), ''];
  if (c.error) return out.concat([c.error, '']).join('\n');
  out.push(tr('Приміток: {0}; місце в джерелах знайдено для {1}.', c.list.length, c.mapped.length), '');
  if (!c.sync) out.push(tr('Місця в джерелах не шукались: у поточного PDF немає .synctex.gz (збери документ із SyncTeX).'), '');
  else if (c.buildPages && c.pages && c.buildPages !== c.pages) out.push(tr('⚠ У рецензованому PDF {0} с., у поточному {1} с.: документ змінився після рецензії, місця можуть бути зсунуті.', c.pages, c.buildPages), '');
  else out.push(tr('Місця знайдено через SyncTeX поточного PDF ({0}); він має бути тією самою версією, що й рецензована.', path.basename(buildPdf)), '');
  for (const a of c.list) {
    const where = a.abs && fs.existsSync(a.abs) ? rel(a.abs) + ':' + (a.line + 1) : tr('місце не знайдено');
    const who = a.author ? ' · ' + a.author : '';
    const body = [a.text, a.quote ? '«' + a.quote + '»' : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    out.push('- ' + (a.reply ? '↳ ' : '') + tr('с. {0}', a.page) + ' · ' + A.typeName(a.type) + who + (body ? ': ' + body : '') + ' → ' + where);
  }
  out.push('');
  return out.join('\n');
}

// a comment line above each place; several notes of one line keep their order
async function insertTodos(mapped) {
  const kw = (cfg().get('todoKeywords', ['TODO']) || ['TODO'])[0] || 'TODO';
  const we = new vscode.WorkspaceEdit();
  const docs = new Map();
  for (const a of mapped) {
    let doc = docs.get(a.abs);
    if (!doc) { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(a.abs)); docs.set(a.abs, doc); }
    const line = Math.min(a.line, doc.lineCount - 1);
    const indent = /^\s*/.exec(doc.lineAt(line).text)[0];
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    we.insert(doc.uri, new vscode.Position(line, 0), indent + A.todoComment(a, { keyword: kw, pageWord: tr('с.'), strike: tr('прибрати:') }) + eol);
  }
  return (await vscode.workspace.applyEdit(we)) ? docs.size : -1;
}

async function notesCmd() {
  const b = require('./build').activePdf();
  const buildPdf = b && !b.warn ? b.pdf : null;
  const root = projectRoot() || (buildPdf ? path.dirname(buildPdf) : null);
  if (!root) { warn(tr('Відкрий папку проєкту (workspace).')); return; }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false, filters: { PDF: ['pdf'] }, openLabel: tr('Прочитати примітки'),
    defaultUri: vscode.Uri.file(buildPdf ? path.dirname(buildPdf) : root), title: tr('PDF із примітками рецензента')
  });
  if (!picked || !picked.length) return;
  const reviewPdf = picked[0].fsPath;
  const run = () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Читаю примітки PDF…') }, () => compute(reviewPdf, buildPdf));
  const c = await run();
  await require('./projectRefactor').reportDoc(reportMd(c, reviewPdf, buildPdf, root), root, async () => reportMd(await run(), reviewPdf, buildPdf, root));
  if (c.error) return;
  if (!c.list.length) { info(tr('У {0} немає приміток (посилання й поля форм не рахуються).', path.basename(reviewPdf))); return; }
  if (!c.mapped.length) return;
  const yes = tr('Вставити');
  const go = await vscode.window.showInformationMessage(tr('Вставити {0} позначок TODO у джерела, рядком над місцем кожної примітки? Файли лишаться незбереженими, їх видно в панелі TODO.', c.mapped.length), { modal: true }, yes);
  if (go !== yes) return;
  const n = await insertTodos(c.mapped);
  if (n < 0) warn(tr('VS Code не прийняв зміни.'));
  else vscode.window.setStatusBarMessage(tr('Позначок TODO вставлено: {0} у {1} файлах', c.mapped.length, n), 6000);
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.importPdfNotes', notesCmd));
}

module.exports = { register, _t: { compute, reportMd, insertTodos } };
