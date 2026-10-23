'use strict';
/* tikzThumbs.js (0.25.0): thumbnails of the figures in tikz/ for the hover on \localinput. The hover asks status(); a figure without
 * a fresh thumbnail is queued and built in the background (one at a time), so the next hover shows the pictures. The cache lives in
 * the storage of the workspace, one folder per figure with key.txt: the key of the picture it holds (tikzThumbsPure.keyOf).
 * Nothing is built in an untrusted workspace, and with tssworkflow.tikzThumbs = false. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const T = require('./tikzThumbsPure');
const { cfg, run } = require('./util');
const { tr } = require('./i18n');

let storage = null; // the folder of the cache (register)
/** @type {(m: string) => void} */
let log = () => {};
const queue = [];      // [{ root, file, fig, key, dir }]
const queued = new Set(); // dir of the figures in the queue or being built
const failed = new Map(); // dir -> { key, msg }
let busy = false;
/** @type {(d: any) => void} */
let onBuilt = () => {}; // tests wait on it

const enabled = () => cfg().get('tikzThumbs', true) !== false && vscode.workspace.isTrusted !== false;

function sub() {
  try { return require('./filesAndLabels').legacySub('\\localinput', 'tikz') || 'tikz'; } catch (e) { return 'tikz'; }
}

const stat = (p) => { try { const s = fs.statSync(p); return { path: p, mtimeMs: s.mtimeMs, size: s.size }; } catch (e) { return { path: p, mtimeMs: 0, size: 0 }; } };

// the figure, its key and its folder in the cache; null when the file is not X/tikz/name.tikz of the root
function describe(root, file) {
  if (!storage) return null;
  const fig = T.figureOf(root, file, sub());
  if (!fig) return null;
  const driver = cfg().get('driver', 'alone.tex');
  let around = [];
  try { around = fs.readdirSync(root).filter((n) => /\.(cls|sty)$/i.test(n)).sort().map((n) => stat(path.join(root, n))); } catch (e) { /* no root */ }
  const key = T.keyOf([stat(file), stat(path.join(root, driver))].concat(around));
  return { root, file, fig, key, driver, dir: path.join(storage, T.folderOf(root + '|' + fig.rel)) };
}

function pngsOf(d) {
  try {
    if (fs.readFileSync(path.join(d.dir, 'key.txt'), 'utf8').trim() !== d.key) return null;
    const list = T.pages(fs.readdirSync(d.dir), 'thumb').map((n) => path.join(d.dir, n));
    return list.length ? list : null;
  } catch (e) { return null; }
}

/* what the hover can show: { state: 'ready', pngs } | 'building' | { state: 'failed', msg } | 'off' | 'none' (not a figure) */
function status(root, file) {
  const d = describe(root, file);
  if (!d) return { state: 'none' };
  const pngs = pngsOf(d);
  if (pngs) return { state: 'ready', pngs };
  const f = failed.get(d.dir);
  if (f && f.key === d.key) return { state: 'failed', msg: f.msg };
  if (!enabled()) return { state: 'off' };
  request(d);
  return { state: 'building' };
}

// whoever shows thumbnails (the panel "Preview selection") is told when a figure is done: onDidBuild(file => ...) -> Disposable
const listeners = new Set();
function onDidBuild(f) { listeners.add(f); return { dispose: () => listeners.delete(f) }; }

const waiters = new Map(); // dir -> [resolve]: the command of the chapter waits for its figures
const settle = (dir, how) => { for (const r of waiters.get(dir) || []) r(how); waiters.delete(dir); };

// queues the figure (once); the promise resolves with 'built' | 'failed' | 'cancelled' when its turn is over
function request(d) {
  const p = new Promise((resolve) => { if (!waiters.has(d.dir)) waiters.set(d.dir, []); waiters.get(d.dir).push(resolve); });
  if (!queued.has(d.dir)) {
    queued.add(d.dir);
    queue.push(d);
    if (!busy) pump();
  }
  return p;
}

// drops the queued (not yet started) figures of these folders
function cancel(dirs) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!dirs.has(queue[i].dir)) continue;
    const [d] = queue.splice(i, 1);
    queued.delete(d.dir);
    settle(d.dir, 'cancelled');
  }
}

async function pump() {
  busy = true;
  try {
    while (queue.length) {
      const d = queue.shift();
      try { await build(d); } finally { queued.delete(d.dir); }
      settle(d.dir, failed.has(d.dir) ? 'failed' : 'built');
      onBuilt(d);
      for (const f of listeners) { try { f(d.file); } catch (e) { /* a listener must not stop the queue */ } }
    }
  } finally { busy = false; }
}

/* "Build thumbnails of the chapter's figures": every X/tikz/*.tikz of the chapter of the active file (X/X.tex or a figure of X),
 * in the background with a cancellable progress; the fresh ones are not rebuilt. -> { built, fresh, failed: [rel], cancelled } */
async function buildChapter() {
  const ed = vscode.window.activeTextEditor;
  const folder = ed && vscode.workspace.getWorkspaceFolder(ed.document.uri);
  const chapter = folder && T.chapterOf(folder.uri.fsPath, ed.document.uri.fsPath, sub());
  if (!chapter) { vscode.window.showWarningMessage(tr('Відкрий файл розділу (X/X.tex) або рисунок із X/tikz/.')); return null; }
  if (!enabled()) { vscode.window.showWarningMessage(tr('Мініатюри вимкнено (tssworkflow.tikzThumbs) або робоча тека не довірена.')); return null; }
  const root = folder.uri.fsPath;
  const dir = path.join(root, chapter, sub());
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.tikz$/i.test(n)).sort((a, b) => a.localeCompare(b)); } catch (e) { /* no folder */ }
  const all = names.map((n) => describe(root, path.join(dir, n))).filter(Boolean);
  if (!all.length) { vscode.window.showInformationMessage(tr('У {0}/{1}/ немає рисунків .tikz.', chapter, sub())); return null; }
  const todo = all.filter((d) => !pngsOf(d));
  const res = { built: 0, fresh: all.length - todo.length, failed: [], cancelled: 0 };
  if (todo.length) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Мініатюри рисунків розділу {0}', chapter), cancellable: true }, async (progress, token) => {
      const dirs = new Set(todo.map((d) => d.dir));
      if (token) token.onCancellationRequested(() => cancel(dirs));
      let done = 0;
      progress.report({ message: '0 / ' + todo.length });
      await Promise.all(todo.map((d) => request(d).then((how) => {
        if (how === 'built') res.built++; else if (how === 'failed') res.failed.push(d.fig.rel); else res.cancelled++;
        done++;
        progress.report({ increment: 100 / todo.length, message: done + ' / ' + todo.length + ': ' + d.fig.tikz });
      })));
    });
  }
  const text = tr('Мініатюри розділу {0}: зібрано {1}, уже були {2}, помилок {3}.', chapter, res.built, res.fresh, res.failed.length) +
    (res.cancelled ? ' ' + tr('Скасовано: {0}.', res.cancelled) : '') +
    (res.failed.length ? ' ' + tr('Не зібрано: {0} (причина — у підказці на \\localinput).', res.failed.slice(0, 3).map((r) => path.basename(r)).join(', ') + (res.failed.length > 3 ? '…' : '')) : '');
  (res.failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(text);
  return res;
}

async function build(d) {
  const t0 = Date.now();
  fs.rmSync(d.dir, { recursive: true, force: true });
  fs.mkdirSync(d.dir, { recursive: true });
  if (!fs.existsSync(path.join(d.root, d.driver))) {
    failed.set(d.dir, { key: d.key, msg: tr('немає драйвера {0} у корені проєкту (tssworkflow.driver)', d.driver) });
    return;
  }
  try {
    await run('lualatex', T.latexArgs({ chapter: d.fig.chapter, tikz: d.fig.tikz, driver: d.driver, outDir: d.dir, job: 'thumb' }), { cwd: d.root, timeout: 120000 });
  } catch (e) {
    let reason = '';
    try { reason = T.logError(fs.readFileSync(path.join(d.dir, 'thumb.log'), 'utf8')); } catch (x) { /* no log */ }
    failed.set(d.dir, { key: d.key, msg: reason || (e && e.code === 'ENOENT' ? tr('lualatex не знайдено в PATH') : String(e && e.message || e).split('\n')[0]) });
    log('tikzThumbs: ' + d.fig.rel + ' failed: ' + failed.get(d.dir).msg);
    return;
  }
  try {
    await run('pdftocairo', T.cairoArgs(path.join(d.dir, 'thumb.pdf'), path.join(d.dir, 'thumb')), { cwd: d.dir, timeout: 60000 });
  } catch (e) {
    failed.set(d.dir, { key: d.key, msg: e && e.code === 'ENOENT' ? tr('pdftocairo не знайдено в PATH (Poppler; у TeX Live для Windows він є)') : String(e && e.message || e).split('\n')[0] });
    return;
  }
  // only the pictures stay; key.txt last, so a half-written folder is never taken for a thumbnail
  for (const n of fs.readdirSync(d.dir)) if (!/\.png$/i.test(n)) fs.rmSync(path.join(d.dir, n), { force: true });
  fs.writeFileSync(path.join(d.dir, 'key.txt'), d.key);
  failed.delete(d.dir);
  log('tikzThumbs: ' + d.fig.rel + ' in ' + (Date.now() - t0) + ' ms');
}

// the hover of \localinput{name}: the pictures when they are ready, else `fallback` (the code of the file) with a line of state
function hoverMd(root, file, fallback) {
  const st = status(root, file);
  if (st.state === 'ready') {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['vscode.open'] };
    md.appendMarkdown('**' + path.basename(file) + '**  ·  [' + tr('Відкрити файл') + '](command:vscode.open?' + encodeURIComponent(JSON.stringify([vscode.Uri.file(file)])) + ')\n\n');
    for (const p of st.pngs) md.appendMarkdown('![](' + vscode.Uri.file(p).toString() + ')\n\n');
    return md;
  }
  if (st.state === 'building') fallback.appendMarkdown('\n\n*' + tr('Мініатюра збирається; наведи ще раз за кілька секунд.') + '*');
  else if (st.state === 'failed') fallback.appendMarkdown('\n\n*' + tr('Мініатюру не зібрано: {0}', st.msg.replace(/[*_`[\]]/g, '\\$&')) + '*');
  return fallback;
}

function register(context, api) {
  if (api && api.log) log = api.log;
  const base = context.storageUri ? context.storageUri.fsPath : (context.globalStorageUri ? context.globalStorageUri.fsPath : context.globalStoragePath);
  storage = base ? path.join(base, 'tikz-thumbs') : null;
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.tikzThumbsChapter', () => buildChapter()));
}

module.exports = { register, status, hoverMd, buildChapter, onDidBuild, _describe: describe, _setOnBuilt: (f) => { onBuilt = f || (() => {}); }, _idle: () => !busy && !queue.length };
