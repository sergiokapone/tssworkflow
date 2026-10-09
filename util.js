'use strict';
/* util.js: helpers that need vscode and are shared by the feature modules (settings, file lists, document lines, messages). */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./corePure');

const EXCLUDE = '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**}';
const PIC_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif', '.tif', '.tiff'];
const SEL = [
  { language: 'latex', scheme: 'file', pattern: '**/*.tex' },
  { language: 'latex', scheme: 'file', pattern: '**/*.tikz' },
  { language: 'tex', scheme: 'file', pattern: '**/*.tex' },
  { scheme: 'file', pattern: '**/*.tikz' }
];
const SEL_ANY = [{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }];
const REF_CTX = new RegExp('\\\\(?:' + P.REF_CMDS + ')\\*?\\{([^}]*)$');

const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
const isTexDoc = (doc) =>
  doc.languageId === 'latex' || doc.languageId === 'tex' || doc.uri.fsPath.toLowerCase().endsWith('.tikz');
const info = (m, ...b) => vscode.window.showInformationMessage(m, ...b);
const warn = (m, ...b) => vscode.window.showWarningMessage(m, ...b);
const errText = (e) => (e && e.message ? e.message : String(e));
const isTex = (doc) => !!doc && (doc.languageId === 'latex' || doc.languageId === 'tex');

// the folder of the project: the workspace folder of the active editor, else the first one
function projectRoot() {
  const ed = vscode.window.activeTextEditor;
  const f = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  return f ? f.uri.fsPath : null;
}

// the text of a file: the open (maybe unsaved) document if there is one, else the disk
function textOfPath(abs) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (open) return open.getText();
  try { return fs.readFileSync(abs, 'utf8'); } catch (e) { return null; }
}

/* ------------------------------ helpers ------------------------------ */
function docLines(doc) {
  const a = [];
  for (let i = 0; i < doc.lineCount; i++) a.push(doc.lineAt(i).text);
  return a;
}
const linesOf = (doc, s, e) => docLines(doc).slice(s, e + 1);

async function replaceLines(ed, s, e, newLines) {
  const doc = ed.document;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const range = new vscode.Range(s, 0, e, doc.lineAt(e).text.length);
  await ed.edit((b) => b.replace(range, newLines.join(eol)));
}

// selected lines, or the paragraph around the cursor
function chunkRange(ed) {
  const doc = ed.document;
  if (!ed.selection.isEmpty) {
    const s = ed.selection.start.line;
    let e = ed.selection.end.line;
    if (ed.selection.end.character === 0 && e > s) e--;
    return { startLine: s, endLine: e };
  }
  const cur = ed.selection.active.line;
  if (P.lineKind(doc.lineAt(cur).text) === 'hard') {
    info('Постав курсор в абзац або виділи рядки.');
    return null;
  }
  let s = cur;
  let e = cur;
  while (s > 0 && P.canJoin(doc.lineAt(s - 1).text, doc.lineAt(s).text)) s--;
  while (e + 1 < doc.lineCount && P.canJoin(doc.lineAt(e).text, doc.lineAt(e + 1).text)) e++;
  return { startLine: s, endLine: e };
}

function listFiles(root, exts, depth, rel) {
  rel = rel || '';
  let out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (depth > 0) out = out.concat(listFiles(root, exts, depth - 1, r));
    } else if (exts.includes(path.extname(e.name).toLowerCase())) {
      out.push(r);
    }
  }
  return out;
}

function textOf(uri) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch (e) { return ''; }
}
const baseOf = (p) => path.basename(p, path.extname(p));
const texFiles = () => vscode.workspace.findFiles('**/*.{tex,tikz}', EXCLUDE, 3000);

module.exports = {
  EXCLUDE,
  PIC_EXTS,
  REF_CTX,
  SEL,
  SEL_ANY,
  baseOf,
  cfg,
  chunkRange,
  docLines,
  errText,
  info,
  isTex,
  isTexDoc,
  linesOf,
  listFiles,
  projectRoot,
  replaceLines,
  texFiles,
  textOf,
  textOfPath,
  warn,
};
