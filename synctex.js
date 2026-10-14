'use strict';
/* synctex.js: does the PDF contain the file of the editor? Used before the jump to a line in the external viewer
 * (extension.js openPdfExternal) and by the command "Diagnose SyncTeX". The logic is in synctexPure.js. */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const S = require('./synctexPure');

const HEAD_BYTES = 262144; // the inputs are in the header: the first 256 KB of the (compressed) file are enough
const cache = new Map();    // path -> { stamp, inputs }
const CI = process.platform === 'win32' || process.platform === 'darwin';

function synctexPathFor(pdf) {
  const stem = String(pdf).replace(/\.pdf$/i, '');
  for (const ext of ['.synctex.gz', '.synctex']) if (fs.existsSync(stem + ext)) return stem + ext;
  return null;
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const chunk = buf.subarray(0, n);
    if (!/\.gz$/i.test(file)) return chunk.toString('utf8');
    // a truncated gzip stream: Z_SYNC_FLUSH returns what could be unpacked instead of throwing
    return zlib.gunzipSync(chunk, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// { path, mtime, inputs } of the synctex file that belongs to the PDF, or null
function load(pdf) {
  const p = synctexPathFor(pdf);
  if (!p) return null;
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  const stamp = st.mtimeMs + ':' + st.size;
  const c = cache.get(p);
  if (c && c.stamp === stamp) return { path: p, mtime: st.mtimeMs, inputs: c.inputs };
  let inputs = [];
  try { inputs = S.parseSynctexInputs(readHeader(p)); } catch (e) { inputs = []; }
  cache.set(p, { stamp, inputs });
  return { path: p, mtime: st.mtimeMs, inputs };
}

const rootOfFile = (file) => { const f = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)); return f ? f.uri.fsPath : ''; };

function reportFor(pdf, file) {
  const sx = load(pdf);
  if (!sx) return { sx: null, report: null };
  const report = S.synctexReport({ inputs: sx.inputs, file, base: path.dirname(sx.path), root: rootOfFile(file), ci: CI });
  return { sx, report };
}

/* Before the jump: { file } the file in the spelling of the PDF (when only the case differs), { warn, buttons } when the PDF does
 * not contain the file, {} when all is well or there is nothing to judge by (no synctex file: the build may be unusual). */
function precheck(pdf, ctx) {
  if (!ctx || !ctx.file) return {};
  const { sx, report } = reportFor(pdf, ctx.file);
  if (!sx || !sx.inputs.length) return {};
  const name = path.basename(ctx.file);
  if (report.status === 'ok') return {};
  if (report.status === 'case') { const f = S.spelledAsRecorded(report, ctx.file); return f ? { file: f } : {}; }
  const why = report.status === 'name'
    ? 'У ' + path.basename(pdf) + ' є файл «' + name + '», але з іншого шляху (' + report.candidates.join(', ') + ').'
    : 'У ' + path.basename(pdf) + ' немає файла «' + name + '»: PDF зібрано з іншого розділу?';
  return { warn: why + ' Вьюер відкриє PDF, але не перейде до рядка. Збери цей файл (▷) і повтори.', buttons: ['Відкрити PDF без переходу', 'Діагностика SyncTeX'] };
}

async function diagnose(api) {
  const r = api.activePdf();
  if (r.warn) { vscode.window.showWarningMessage(r.warn); return null; }
  if (!r.pdf) { vscode.window.showWarningMessage('PDF не знайдено. Спершу збери документ кнопкою ▷.'); return null; }
  if (!r.ctx || !r.ctx.file) { vscode.window.showInformationMessage('Відкрий .tex-файл, для якого перевірити SyncTeX.'); return null; }
  const { sx, report } = reportFor(r.pdf, r.ctx.file);
  const ed = vscode.window.activeTextEditor;
  let fileMtime = 0;
  if (ed && ed.document.isDirty) fileMtime = Date.now();
  else { try { fileMtime = fs.statSync(r.ctx.file).mtimeMs; } catch (e) { /* no mtime */ } }
  const lines = S.formatSynctexReport(report, {
    pdf: r.pdf, synctex: sx && sx.path, synctexMtime: sx && sx.mtime, fileMtime, file: r.ctx.file, line: r.ctx.line, root: rootOfFile(r.ctx.file)
  });
  const content = lines.join('\n') + '\n';
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: false });
  return content;
}

// api: { activePdf() -> { pdf, ctx: { file, line }, warn } } from extension.js
function register(context, api) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.synctexDiagnose', () => diagnose(api)));
}

module.exports = { register, precheck, load, diagnose, reportFor };
