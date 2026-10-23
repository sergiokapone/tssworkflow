'use strict';
/* preflight.js: "Check before print". One report about the finished PDF of the active document (the one the PDF button opens):
 * fonts that are not embedded or are Type 3 (pdffonts), raster pictures below tssworkflow.preflight.minDpi and RGB pictures
 * (pdfimages -list: the resolution as printed, not of the file), the log of the same build (errors, undefined references and
 * citations, missing glyphs, a pass still needed, Overfull \hbox), a PDF older than its sources, TODO / FIXME and \iffalse blocks.
 * pdffonts / pdfimages / pdfinfo come with TeX Live; without them that part of the report says so and the rest is done.
 * The parsing and the text of the report are in preflightPure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const F = require('./preflightPure');
const P = require('./corePure');
const PI = require('./projectIndex');
const { tr } = require('./i18n');
const { cfg, errText, excludeNow, excludePdfNow, projectRoot, run, texFiles, warn } = require('./util');

const TOOL_TIMEOUT = 60000;
const posix = (p) => String(p).replace(/\\/g, '/');

// the output of a tool, or { error } with a text for the report
async function tool(cmd, args) {
  try { return { out: await run(cmd, args, { timeout: TOOL_TIMEOUT, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }) }; }
  catch (e) {
    if (e && e.code === 'ENOENT') return { error: tr('{0} не знайдено в PATH (є в TeX Live; для MiKTeX встанови Poppler). Цю частину не перевірено.', cmd) };
    return { error: tr('{0} не спрацював: {1}', cmd, errText(e)) };
  }
}

// runs fn over the items, `width` at a time
async function pool(items, width, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

// the sources changed after the PDF (and the unsaved ones)
async function staleSources(pdfTime, root) {
  const out = [];
  const uris = (await texFiles()).concat(await vscode.workspace.findFiles('**/*.bib', excludeNow(), 200));
  const dirty = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.fsPath));
  for (const u of uris) {
    let t = 0;
    try { t = (await fs.promises.stat(u.fsPath)).mtimeMs; } catch (e) { continue; }
    if (t > pdfTime + 1000 || dirty.has(u.fsPath)) out.push(posix(path.relative(root, u.fsPath)));
  }
  return out.sort();
}

// a PDF that a build wrote (a .log or .synctex.gz of the same name stands next to it) is a document, not a picture
const isBuildOutput = (abs) => {
  const stem = abs.slice(0, abs.length - path.extname(abs).length);
  return ['.log', '.synctex.gz', '.synctex'].some((e) => fs.existsSync(stem + e));
};

// font name (without the subset prefix) -> the PDF pictures of the project that carry it, not embedded or as Type 3
async function fontSources(names, root) {
  const map = new Map();
  const pdfs = (await vscode.workspace.findFiles('**/*.pdf', excludePdfNow(), 300)).filter((u) => !isBuildOutput(u.fsPath));
  await pool(pdfs, 4, async (u) => {
    const r = await tool('pdffonts', [u.fsPath]);
    if (r.error) return;
    for (const f of F.parsePdffonts(r.out)) {
      if (!names.has(f.base) || (f.emb && !/Type 3/.test(f.type))) continue;
      if (!map.has(f.base)) map.set(f.base, []);
      map.get(f.base).push(posix(path.relative(root, u.fsPath)));
    }
  });
  return map;
}

// 'width×height' -> the PNG / JPEG files of the project with that pixel size (a picture of the PDF is found by its size)
async function pictureFiles(root) {
  const map = new Map();
  const files = await vscode.workspace.findFiles('**/*.{png,jpg,jpeg,PNG,JPG,JPEG}', excludeNow(), 3000);
  await pool(files, 8, async (u) => {
    let fh = null;
    try {
      fh = await fs.promises.open(u.fsPath, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const s = F.imageSize(buf.subarray(0, bytesRead));
      if (!s) return;
      const key = s.width + '×' + s.height;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(posix(path.relative(root, u.fsPath)));
    } catch (e) { /* unreadable: not matched */ } finally { if (fh) await fh.close(); }
  });
  return map;
}

// the lines that open \iffalse (outside comments), as `file:line`
async function iffalseBlocks(root) {
  const out = [];
  for (const u of await texFiles()) {
    const lines = PI.get('preflight.iffalse', u.fsPath, (text) => {
      const at = [];
      String(text).split(/\r?\n/).forEach((l, i) => { if (/\\iffalse(?![a-zA-Z])/.test(P.codePart(l))) at.push(i); });
      return at;
    });
    for (const i of lines || []) out.push(posix(path.relative(root, u.fsPath)) + ':' + (i + 1));
  }
  return out.sort();
}

async function todoPlaces(root) {
  const groups = await require('./projectInfo').collectTodos();
  const out = [];
  for (const g of groups) for (const it of g.items) out.push({ at: posix(path.relative(root, g.file.fsPath)) + ':' + (it.line + 1), kw: it.kw, text: it.text });
  return out;
}

async function compute(pdf, root, progress) {
  const step = (m) => progress && progress.report({ message: m });
  const cwd = path.dirname(pdf);
  const job = path.basename(pdf, path.extname(pdf));
  const minDpi = Math.max(1, Number(cfg().get('preflight.minDpi', 300)) || 300);
  step(tr('PDF: шрифти, рисунки…'));
  const [fontsR, imagesR, infoR] = await Promise.all([tool('pdffonts', [pdf]), tool('pdfimages', ['-list', pdf]), tool('pdfinfo', [pdf])]);
  const fonts = fontsR.error ? { error: fontsR.error } : { list: F.parsePdffonts(fontsR.out) };
  const images = imagesR.error ? { error: imagesR.error } : { list: F.parsePdfimages(imagesR.out) };
  let fontFiles = null, imageFiles = null;
  if (fonts.list) {
    const ff = F.fontFindings(fonts.list);
    const names = new Set(ff.notEmbedded.concat(ff.type3).map((f) => f.base));
    if (names.size) { step(tr('шукаю рисунки з цими шрифтами…')); fontFiles = await fontSources(names, root); }
  }
  if (images.list && F.imageFindings(images.list, { minDpi }).lowRes.length) { step(tr('шукаю файли рисунків…')); imageFiles = await pictureFiles(root); }
  step(tr('лог і джерела…'));
  let log = null;
  try { log = F.logFindings(await fs.promises.readFile(path.join(cwd, job + '.log'), 'utf8'), { cwd, root, overfull: cfg().get('overfullThreshold', 5) }); } catch (e) { log = null; }
  let pdfTime = 0;
  try { pdfTime = (await fs.promises.stat(pdf)).mtimeMs; } catch (e) { pdfTime = Date.now(); }
  const [stale, todos, iffalse] = await Promise.all([staleSources(pdfTime, root), todoPlaces(root), iffalseBlocks(root)]);
  return F.formatReport(
    { pdf, root, info: infoR.error ? null : F.parsePdfinfo(infoR.out), stale, fonts, fontFiles, images, imageFiles, log, todos, iffalse },
    { minDpi, cmyk: !!cfg().get('preflight.requireCmyk', false) }
  );
}

async function preflightCmd() {
  const r = require('./build').activePdf();
  if (r.warn) { warn(r.warn); return; }
  if (!r.pdf) { warn(tr('PDF не знайдено. Спершу збери документ кнопкою ▷.')); return; }
  const pdf = r.pdf;
  const root = projectRoot() || path.dirname(pdf);
  const withProgress = (fn) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Перевірка перед друком') }, fn);
  try {
    const md = await withProgress((progress) => compute(pdf, root, progress));
    await require('./projectRefactor').reportDoc(md, root, () => withProgress((progress) => compute(pdf, root, progress)));
  } catch (e) {
    warn(tr('Перевірка перед друком не вдалася: {0}', errText(e)));
  }
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.preflight', preflightCmd));
}

module.exports = { register, _t: { compute, pictureFiles, staleSources } };
