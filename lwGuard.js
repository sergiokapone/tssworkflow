'use strict';
/* lwGuard.js: the build of this extension does not start while LaTeX Workshop is building the same document (the same
 * <job>.aux, .log, .pdf, .synctex.gz would be written by two builds at once and both results are spoiled).
 * The rules of the match are in lwGuardPure.js. There is no timer and no listener here: the list of processes is read on demand,
 * when a build, an automatic build or a clean is about to start (and a few times a second while the user chose to wait).
 * tssworkflow.lwGuard: 'job' (default: the same document), 'project' (any build under the project folder), 'off'.
 * A list that cannot be read (no ps / PowerShell, a timeout) never blocks: the build starts as it did before this module. */
const vscode = require('vscode');
const L = require('./lwGuardPure');
const { cfg, debounce, cancelTimer, execFileT } = require('./util');

const LW_ID = 'James-Yu.latex-workshop';
const CACHE_MS = 1000; // two requests within a second (a save and a button) share one reading
const LIST_TIMEOUT = 5000;
const WAIT_STEP = 1200;
const WAIT_MAX = 5 * 60 * 1000;

let cached = null; // { at, p: Promise<[{ pid, args }] | null> }

function listProcesses(fresh) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.p;
  const c = L.listCommand(process.platform);
  const p = new Promise((resolve) => {
    try {
      execFileT(c.cmd, c.args, { timeout: LIST_TIMEOUT, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        if (err && !stdout) return resolve(null);
        resolve(c.parse(stdout));
      });
    } catch (e) { resolve(null); }
  });
  cached = { at: Date.now(), p };
  return p;
}

const mode = () => {
  const v = cfg().get('lwGuard', 'job');
  return v === 'project' || v === 'off' ? v : 'job';
};
const lwInstalled = () => { try { return !!vscode.extensions.getExtension(LW_ID); } catch (e) { return false; } };

// the builds of the same document that run now: [] (none or unknown) / [{ pid, program, args }]
async function busyNow(b, fresh) {
  const procs = await listProcesses(fresh);
  if (!procs) return [];
  return L.findBusy(procs, { cwd: b.cwd, folder: b.folder, job: b.job, scope: mode(), platform: process.platform, selfPids: [process.pid] });
}

// is the check needed at all: not with the switch off, not without LaTeX Workshop (it is the one that builds)
const applicable = () => mode() !== 'off' && lwInstalled();

// resolves after ms, or at once when the token is cancelled (a timer of util.debounce, one key per wait: cleared with the extension)
let sleepSeq = 0;
function sleep(ms, token) {
  return new Promise((resolve) => {
    const key = 'lwGuard.sleep:' + (++sleepSeq);
    let sub = null;
    debounce(key, ms, () => { if (sub) sub.dispose(); resolve(); });
    if (token && token.onCancellationRequested) sub = token.onCancellationRequested(() => { cancelTimer(key); sub.dispose(); resolve(); });
  });
}

// waits until nothing of the document runs; true when it is free, false after the cancel or after maxMs
async function waitFree(b, token, maxMs) {
  const until = Date.now() + (maxMs || WAIT_MAX);
  for (;;) {
    if (token && token.isCancellationRequested) return false;
    if (!(await busyNow(b, true)).length) return true;
    if (Date.now() > until) return false;
    await sleep(WAIT_STEP, token);
  }
}

/* b: { cwd, folder, job, what } (what: 'збірку' / 'прибирання', for the text); opts.interactive: false for the automatic build
 * (skip it quietly, with a line in the status bar), true for a command (ask).
 * Returns null when the check does not apply (no await needed), else a Promise<boolean>: may the action start. */
function guard(b, opts) {
  if (!applicable()) return null;
  return decide(b, !opts || opts.interactive !== false);
}

async function decide(b, interactive) {
  const busy = await busyNow(b, false);
  if (!busy.length) return true;
  const what = b.what || 'збірку';
  const text = 'LaTeX Workshop ' + L.describe(busy, b.job) + '. Паралельна збірка пише в ті самі ' + b.job + '.aux, .log і .pdf, тому ' + what + ' плагіна не запущено.';
  if (!interactive) {
    vscode.window.setStatusBarMessage('$(circle-slash) ' + b.job + ': автозбірку пропущено, LaTeX Workshop ще збирає', 5000);
    return false;
  }
  const wait = 'Дочекатися й запустити';
  const stop = 'Зупинити збірку LaTeX Workshop';
  const force = 'Все одно запустити';
  const pick = await vscode.window.showWarningMessage(text, wait, stop, force);
  if (pick === force) return true;
  if (pick === wait) {
    const free = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Чекаю, поки LaTeX Workshop закінчить збірку ' + b.job + '…', cancellable: true },
      (progress, token) => waitFree(b, token)
    );
    return !!free;
  }
  if (pick === stop) {
    try { await vscode.commands.executeCommand('latex-workshop.kill'); } catch (e) { /* the command may be absent in another version */ }
    const free = await waitFree(b, null, 10000);
    if (!free) vscode.window.showWarningMessage('Збірка LaTeX Workshop не зупинилась за 10 с. Дочекайся її кінця або зупини процес самостійно, потім повтори.');
    return !!free;
  }
  return false; // the message was closed: nothing starts
}

const reset = () => { cached = null; };

module.exports = { guard, busyNow, applicable, waitFree, reset, _t: { listProcesses, mode } };
