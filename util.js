'use strict';
/* util.js: helpers that need vscode and are shared by the feature modules (settings, file lists, document lines, messages). */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./corePure');

// folders that are never project text; the only place where this list is written (macros.js, filesAndLabels.js and the rest import it)
const EXCLUDED_DIRS = ['**/build/**', '**/.archive/**', '**/node_modules/**', '**/.git/**'];
const excludeGlob = (extra) => '{' + EXCLUDED_DIRS.concat(extra || []).join(',') + '}';
const EXCLUDE = excludeGlob();
// the list of the labels panel and of the renames: the copies kept in pdf-versions are not part of the project either
const EXCLUDE_PDF_VERSIONS = excludeGlob(['**/pdf-versions/**']);
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
  const open = openDocByPath(abs);
  if (open) return open.getText();
  try { return fs.readFileSync(abs, 'utf8'); } catch (e) { return null; }
}

/* ------------------------------ helpers ------------------------------ */
function docLines(doc) {
  // one getText + split is much cheaper than lineCount calls of lineAt (VS Code splits on \r\n, \r and \n)
  if (typeof doc.getText === 'function') {
    const t = doc.getText();
    if (typeof t === 'string') return t.split(/\r\n|\r|\n/);
  }
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
  const open = openDocByPath(uri.fsPath);
  if (open) return open.getText();
  try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch (e) { return ''; }
}
const baseOf = (p) => path.basename(p, path.extname(p));

/* ------------------------------ timers ------------------------------- *
 * debounce(key, ms, fn): runs fn once, ms after the LAST call with this key (every call restarts the wait). One place for the
 * "clearTimeout + setTimeout" pairs that every module wrote for itself: a finished timer is forgotten (no entry per document that
 * was ever edited), a pending one can be asked about and cancelled, and all pending ones are cleared when the extension is disposed.
 * Keys are strings, one per concern ('labels.refresh', 'syntax:' + uri). unref: a timer that must not keep the process alive. */
const timers = new Map();
function debounce(key, ms, fn, unref) {
  clearTimeout(timers.get(key));
  const t = setTimeout(() => { if (timers.get(key) === t) timers.delete(key); fn(); }, ms);
  if (unref && typeof t.unref === 'function') t.unref();
  timers.set(key, t);
  return t;
}
function cancelTimer(key) {
  const t = timers.get(key);
  if (t === undefined) return false;
  clearTimeout(t);
  timers.delete(key);
  return true;
}
const timerPending = (key) => timers.has(key);
function disposeTimers() { for (const t of timers.values()) clearTimeout(t); timers.clear(); }

/* ------------------------------ caches ------------------------------- *
 * Enabled by initCaches(context) once the file watcher exists: then (1) the open documents are looked up in a Map
 * instead of a linear search over workspace.textDocuments for every file, and (2) the lists of project files are
 * kept until a .tex/.tikz/.cls/.sty/.bib file is created, deleted or renamed. Without initCaches (unit tests with a
 * stub, a failed watcher) every call goes to VS Code and the disk exactly as before. */
let caching = false;
let docMap = null;
const findCache = new Map(); // glob|limit -> { at, p: Promise<Uri[]> }
const FIND_TTL = 300000;    // a safety net in case the watcher misses an event

function openDocByPath(abs) {
  if (!caching) return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (!docMap) {
    docMap = new Map();
    // a diff view (git:, scheme other than file) shares the fsPath with the real file: the real one wins
    for (const d of vscode.workspace.textDocuments) if (!docMap.has(d.uri.fsPath) || d.uri.scheme === 'file') docMap.set(d.uri.fsPath, d);
  }
  return docMap.get(abs);
}

// workspace.findFiles with EXCLUDE (or the given exclude), cached while the watcher is alive; always returns a fresh array (callers may push into it)
function findCached(glob, limit, exclude) {
  const ex = exclude === undefined ? EXCLUDE : exclude;
  if (!caching) return Promise.resolve(vscode.workspace.findFiles(glob, ex, limit));
  const key = glob + '|' + limit + '|' + ex;
  const c = findCache.get(key);
  if (c && Date.now() - c.at < FIND_TTL) return c.p.then((a) => a.slice());
  const p = Promise.resolve(vscode.workspace.findFiles(glob, ex, limit));
  findCache.set(key, { at: Date.now(), p });
  p.catch(() => { if (findCache.get(key) && findCache.get(key).p === p) findCache.delete(key); });
  return p.then((a) => a.slice());
}

const texFiles = () => findCached('**/*.{tex,tikz}', 3000);

function initCaches(context) {
  if (caching) return true;
  context.subscriptions.push({ dispose: disposeTimers }); // pending timers are cleared with the extension
  let w = null;
  try { w = vscode.workspace.createFileSystemWatcher('**/*.{tex,tikz,cls,sty,bib}'); } catch (e) { w = null; }
  if (!w || typeof w.onDidCreate !== 'function') return false;
  const subs = context.subscriptions;
  const dropFiles = () => findCache.clear();
  const dropDocs = () => { docMap = null; };
  const on = (ev, fn) => { if (typeof ev === 'function') subs.push(ev(fn)); };
  subs.push(w);
  on(w.onDidCreate, dropFiles);
  on(w.onDidDelete, dropFiles);
  const ws = vscode.workspace;
  on(ws.onDidOpenTextDocument, dropDocs);
  on(ws.onDidCloseTextDocument, dropDocs);
  on(ws.onDidChangeWorkspaceFolders, dropFiles);
  on(ws.onDidCreateFiles, dropFiles);
  on(ws.onDidDeleteFiles, dropFiles);
  on(ws.onDidRenameFiles, dropFiles);
  caching = true;
  return true;
}
const cachingOn = () => caching;

// saves the open documents among the files (fsPath) that have unsaved changes (after a WorkspaceEdit on several files)
async function saveDirtyDocs(paths) {
  let saved = 0;
  for (const abs of paths) {
    const d = openDocByPath(abs);
    if (d && d.isDirty) { try { await d.save(); saved++; } catch (e) { /* stays modified */ } }
  }
  return saved;
}

module.exports = {
  EXCLUDE,
  cancelTimer,
  debounce,
  disposeTimers,
  timerPending,
  EXCLUDE_PDF_VERSIONS,
  excludeGlob,
  saveDirtyDocs,
  cachingOn,
  findCached,
  initCaches,
  openDocByPath,
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
