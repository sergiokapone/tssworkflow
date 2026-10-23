'use strict';
/* floats.js: "Floats far from their first reference": the PDF the PDF button opens (build.activePdf), its .aux (with the
 * \@input of \include) and its .synctex; the labels and references of labels.js. The logic is in floatsPure.js.
 * Also a section of the check before print (preflight.js uses compute). */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const F = require('./floatsPure');
const X = require('./projectInfoPure');
const { tr } = require('./i18n');
const { cfg, projectRoot, warn } = require('./util');

const gunzip = promisify(zlib.gunzip);
const CI = process.platform === 'win32' || process.platform === 'darwin';

// label -> page from <job>.aux and the .aux files it \@input-s
async function auxPages(auxFile) {
  const map = new Map();
  const seen = new Set();
  const read = async (f, depth) => {
    if (depth > 3 || seen.has(f)) return;
    seen.add(f);
    let text;
    try { text = await fs.promises.readFile(f, 'utf8'); } catch (e) { return; }
    for (const [k, v] of X.parseAux(text)) if (!map.has(k)) map.set(k, v.page);
    for (const inc of X.auxInputs(text)) await read(path.resolve(path.dirname(f), inc), depth + 1);
  };
  await read(auxFile, 0);
  return map;
}

async function synctexText(pdf) {
  const stem = pdf.slice(0, pdf.length - path.extname(pdf).length);
  for (const ext of ['.synctex.gz', '.synctex']) {
    let buf;
    try { buf = await fs.promises.readFile(stem + ext); } catch (e) { continue; }
    return ext === '.synctex.gz' ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
  }
  return null;
}

const maxDist = () => Math.max(0, Number(cfg().get('floatMaxPages', 1)));

// { r } or { error } (a text for the user / the report)
async function compute(pdf, root) {
  const cwd = path.dirname(pdf);
  const job = path.basename(pdf, path.extname(pdf));
  const sx = await synctexText(pdf);
  if (sx === null) return { error: tr('Немає {0}.synctex.gz: збери документ із SyncTeX (-synctex=1), тоді стануть відомі сторінки посилань.', job) };
  const aux = await auxPages(path.join(cwd, job + '.aux'));
  if (!aux.size) return { error: tr('У {0}.aux немає міток: збери документ.', job) };
  const pageAt = F.synctexPages(sx, cwd, CI);
  const index = await require('./labels').buildIndex();
  const rel = (abs) => path.relative(root, abs).replace(/\\/g, '/');
  return { r: F.floatPlacement(index, (name) => aux.get(name) || null, pageAt, rel, maxDist()) };
}

async function floatsCmd() {
  const a = require('./build').activePdf();
  if (a.warn) { warn(a.warn); return; }
  if (!a.pdf) { warn(tr('PDF не знайдено. Спершу збери документ кнопкою ▷.')); return; }
  const root = projectRoot() || path.dirname(a.pdf);
  const md = async () => {
    const c = await compute(a.pdf, root);
    return c.error ? '# ' + tr('Плаваючі об\'єкти й перші посилання') + '\n\n' + c.error + '\n' : F.formatFloats(c.r, { maxDist: maxDist() });
  };
  await require('./projectRefactor').reportDoc(await md(), root, md);
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.floatPlacement', floatsCmd));
}

module.exports = { register, compute, maxDist, _t: { auxPages, synctexText } };
