'use strict';
/* build.js: building and showing the result. Compile the chapter / figure / standalone file or the whole document (runBuild and the
 * compile* commands), the build state (one build at a time, the status bar: spinner, seconds, passes, result), clean, the PDF in the
 * viewer (VS Code tab through LaTeX Workshop, or an external program with SyncTeX), the buttons of the status bar. The commands are
 * registered by register(); extension.js only composes the modules. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const P = require('./corePure');
const features = require('./features');
const SY = require('./synctex');
const { cancelTimer, debounce } = require('./util');

let LOG = null; // output channel "TSS Workflow" (given by register)

/* ------------------------------------------------------------------ *
 * 2. Compile / clean
 *    Chapter file  X/X.tex          -> job X,    \TargetChapter = X
 *    Figure file   X/tikz/name.tikz -> job name, \TargetChapter = X, \TargetTikz = name
 * ------------------------------------------------------------------ */
const AUX = new RegExp(
  '\\.(aux|log|fls|fdb_latexmk|out|toc|lof|lot|loa|lol|bbl|blg|bcf|idx|ind|ilg|nav|snm|vrb|xdv|' +
    'figlist|makefile|auxlock|glo|gls|glg|acn|acr|alg|ist|mtc\\d*|maf|table|gnuplot|' +
    'synctex\\.gz|synctex\\.gz\\(busy\\)|synctex\\(busy\\)|run\\.xml)$'
);

function target() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    vscode.window.showWarningMessage('Відкрий .tex розділу або .tikz рисунка.');
    return null;
  }
  const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
  if (!folder) {
    vscode.window.showWarningMessage('Файл не належить жодній відкритій папці (workspace).');
    return null;
  }
  const file = ed.document.uri.fsPath;
  const base = path.basename(file, path.extname(file));
  const dir = path.dirname(file);
  // jobname: setting (default "main"); empty string = use the file name
  const job = vscode.workspace.getConfiguration('tssworkflow').get('jobname', 'main') || base;
  if (path.basename(dir).toLowerCase() === 'tikz') {
    return { job, chapter: path.basename(path.dirname(dir)), tikz: base, folder };
  }
  return { job, chapter: base, tikz: null, folder };
}

function latexArgs(t, driver, force) {
  let pre = '\\def\\TargetChapter{' + t.chapter + '}';
  if (t.tikz) pre += '\\def\\TargetTikz{' + t.tikz + '}';
  return [
    ...(force ? ['-g'] : []),
    '-lualatex',
    '-interaction=nonstopmode',
    '-synctex=1',
    '-file-line-error',
    '-shell-escape',
    '-jobname=' + t.job,
    '-usepretex',
    '-pretex=' + pre,
    driver
  ];
}

// single pass: plain lualatex, no latexmk, so no reruns (references from other chapters come from the existing main.aux)
function singlePassArgs(t, driver) {
  let pre = '\\def\\TargetChapter{' + t.chapter + '}';
  if (t.tikz) pre += '\\def\\TargetTikz{' + t.tikz + '}';
  return [
    '-interaction=nonstopmode',
    '-synctex=1',
    '-file-line-error',
    '-shell-escape',
    '-jobname=' + t.job,
    pre + '\\input{' + driver + '}'
  ];
}

const openedJobs = new Set();
// the one build that may run at a time: { id, job, label, started, execution, abort }
let building = null;
let lastOutcome = null; // the result of the build that ended last: { ok } / { ok: false, code } / { stopped } (read by the build tasks, buildTasks.js)
let pendingDoc = null; // a chapter saved while a build was running: it is built when that one ends
let buildItem = null;
let spinItem = null; // constant '$(sync~spin)': a codicon restarts its rotation whenever the text of ITS item changes, so it must not share an item with the ticking seconds
let buildTimer = null;

const setBuildContext = (on) => {
  vscode.commands.executeCommand('setContext', 'tssworkflow.building', on);
  // the "State" group of the Activity Bar panel shows the running build
  try { require('./sidebar').setBuilding(on && building ? { label: building.label, job: building.job } : null); } catch (e) { /* the panel is optional */ }
};

// the status bar item that shows the running build (and its result for a few seconds)
function renderBuild() {
  if (!buildItem || !building) return;
  const secs = Math.round((Date.now() - building.started) / 1000);
  const pass = building.counter ? building.counter.pass : 0;
  const last = building.lastPasses || 0;
  const passTxt = pass ? ' · ' + pass + (last ? '/' + last : '') : '';
  const fixed = !!building.fixedPasses;
  const tip = 'Іде компіляція ' + building.job + '. Клік зупиняє її.' +
    (pass ? (fixed
      ? '\nПрохід LaTeX ' + pass + ' із ' + last + ' (tssworkflow.compilePasses.*)'
      : '\nПрохід LaTeX ' + pass + (last ? ' із ' + last + ' (стільки було минулого разу; повне число наперед невідоме)' : ' (число проходів ще невідоме: це перша збірка)')) : '');
  // the spinner item is written ONCE per build and never touched again: every property write (even a tooltip with the same
  // value) re-sends the whole entry to the status bar and may rebuild the icon, which restarts its rotation
  if (spinItem && !building.spinShown) {
    spinItem.text = '$(sync~spin)';
    spinItem.tooltip = 'Іде компіляція ' + building.job + '. Клік зупиняє її.';
    spinItem.command = 'tssworkflow.stopBuild';
    spinItem.show();
    building.spinShown = true;
  }
  const showSecs = vscode.workspace.getConfiguration('tssworkflow').get('buildSeconds', true);
  const text = building.label + passTxt + (showSecs ? ' · ' + secs + ' с' : '');
  if (buildItem.text !== text) buildItem.text = text; // no write when nothing changed
  if (building.tip !== tip) { building.tip = tip; buildItem.tooltip = tip; }
  if (!building.textShown) {
    buildItem.command = 'tssworkflow.stopBuild';
    buildItem.backgroundColor = undefined;
    buildItem.show();
    building.textShown = true;
  }
}

function showResult(b, outcome) {
  if (!buildItem) return;
  if (spinItem) spinItem.hide();
  cancelTimer('build.result');
  const secs = Math.max(1, Math.round((Date.now() - b.started) / 1000));
  let ms = 4000;
  if (outcome.stopped) {
    buildItem.text = '$(circle-slash) ' + b.label + ': зупинено';
    buildItem.backgroundColor = undefined;
    buildItem.command = undefined;
    ms = 3000;
  } else if (outcome.ok) {
    const n = b.counter ? b.counter.pass : 0;
    buildItem.text = '$(check) ' + b.label + ': готово за ' + secs + ' с' + (n > 1 ? ' (' + n + ' ' + P.passWord(n) + ')' : '');
    buildItem.backgroundColor = undefined;
    buildItem.command = undefined;
  } else {
    buildItem.text = '$(error) ' + b.label + ': помилки (код ' + outcome.code + ')';
    buildItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    buildItem.command = 'workbench.actions.view.problems';
    buildItem.tooltip = 'Відкрити Problems';
    ms = 10000;
  }
  buildItem.show();
  debounce('build.result', ms, () => { if (!building && buildItem) buildItem.hide(); });
}

function endBuild(id, outcome) {
  if (!building || building.id !== id) return;
  const b = building;
  building = null;
  lastOutcome = outcome;
  clearInterval(buildTimer);
  clearInterval(b.passTimer);
  if (!outcome.stopped && b.counter && b.counter.pass && extCtx) {
    try { extCtx.workspaceState.update('passes:' + b.job, b.counter.pass); } catch (e) { /* the total is only an estimate */ }
  }
  setBuildContext(false);
  showResult(b, outcome);
  if (outcome.stopped) { pendingDoc = null; return; }
  if (pendingDoc) { const d = pendingDoc; pendingDoc = null; setTimeout(() => compileOnSave(d), 0); }
}

function stopBuild() {
  if (!building) { vscode.window.setStatusBarMessage('Компіляція не запущена.', 2000); return; }
  const b = building;
  b.stopping = true;
  try { if (b.execution) b.execution.terminate(); } catch (e) { /* already gone */ }
  // the end event normally follows at once; if it never comes, do not leave the buttons blocked
  setTimeout(() => { if (building && building.id === b.id && b.abort) b.abort(); }, b.execution ? 4000 : 0);
}

function busyWarning() {
  const secs = building ? Math.round((Date.now() - building.started) / 1000) : 0;
  vscode.window.showWarningMessage(
    'Компіляція «' + (building ? building.label : '') + '» ще триває (' + secs + ' с). Дочекайся завершення, щоб логи не перемішались.',
    'Зупинити'
  ).then((pick) => { if (pick === 'Зупинити') stopBuild(); });
}

// compile the saved chapter / figure (used by the "Auto" switch); ignores the root and driver files
function compileOnSave(doc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document !== doc) return;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return;
  if (P.isPackageFile(doc.uri.fsPath)) return; // .cls / .sty ...: cannot be built on their own
  if (path.dirname(doc.uri.fsPath) === folder.uri.fsPath) return; // root files: main.tex, alone.tex ...
  if (P.hasDocumentClass(doc.getText())) {
    if (!docClassWarned.has(doc.uri.fsPath)) { docClassWarned.add(doc.uri.fsPath); warnDocumentClass(doc); }
    return;
  }
  if (building) { pendingDoc = doc; return; }
  const t = target();
  const first = t && !openedJobs.has(t.job + '|' + t.chapter + '|' + t.tikz);
  if (t) openedJobs.add(t.job + '|' + t.chapter + '|' + t.tikz);
  compile(!!first);
}

const isRootTex = (doc, folder) => path.dirname(doc.uri.fsPath) === folder.uri.fsPath && /\.tex$/i.test(doc.uri.fsPath);

// PDF that was built last (the external viewer button opens it when the active file does not tell)
let lastPdf = null;

// opens `pdf` in the external viewer (tssworkflow.externalViewerCommand / externalViewerArgs);
// in the arguments ${pdf}, ${file} (active .tex) and ${line} (cursor line, 1-based) are replaced
function launchExternal(pdf, ctx, argsKey) {
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const cmd = String(cfg.get('externalViewerCommand', 'SumatraPDF') || '').trim();
  if (!cmd) {
    vscode.window.showWarningMessage('Вкажи програму для PDF у налаштуванні tssworkflow.externalViewerCommand.');
    return;
  }
  let args = argsKey === 'externalSyncArgs'
    ? cfg.get('externalSyncArgs', ['-reuse-instance', '-forward-search', '${file}', '${line}', '${pdf}'])
    : cfg.get('externalViewerArgs', ['-reuse-instance', '${pdf}']);
  if (!Array.isArray(args)) args = [];
  const vars = { pdf, file: (ctx && ctx.file) || '', line: String((ctx && ctx.line) || 1) };
  let hasPdf = false;
  args = args.map((a) => String(a).replace(/\$\{(pdf|file|line)\}/g, (m, k) => {
    if (k === 'pdf') hasPdf = true;
    return vars[k];
  }));
  if (!hasPdf) args.push(pdf);
  const fail = (err) => vscode.window.showErrorMessage(
    'Не вдалося запустити «' + cmd + '»: ' + (err && err.message ? err.message : err) +
    '. Перевір, що програма є в PATH, або зміни tssworkflow.externalViewerCommand.'
  );
  try {
    const child = cp.spawn(cmd, args, { cwd: path.dirname(pdf), detached: true, stdio: 'ignore' });
    child.on('error', fail);
    child.unref();
  } catch (err) {
    fail(err);
  }
}

// the PDF that belongs to the active file (or the last built one): { pdf, ctx: { file, line } } or { warn } when its own PDF is not built yet
function activePdf() {
  const ed = vscode.window.activeTextEditor;
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  let pdf = null;
  const ctx = {};
  if (ed) {
    const file = ed.document.uri.fsPath;
    ctx.file = file;
    ctx.line = ed.selection.active.line + 1;
    const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    if (folder) {
      const cwd = folder.uri.fsPath;
      const mainFile = cfg.get('mainFile', 'main.tex') || 'main.tex';
      const isMain = path.dirname(file) === cwd && path.basename(file) === mainFile;
      const job = isMain
        ? path.basename(mainFile, path.extname(mainFile))
        : cfg.get('jobname', 'main') || path.basename(file, path.extname(file));
      // a file with its own \\documentclass (not the main file) is built on its own: its PDF is named after the file and
      // stands next to it (or in the project folder), see compileCurrent, not main.pdf
      if (!isMain && /\.(?:tex|ltx)$/i.test(file) && P.hasDocumentClass(ed.document.getText()) && !P.isPackageFile(file)) {
        try {
          const plan = P.standalonePlan(file, cwd, { workDir: cfg.get('compileCurrent.workDir', 'file'), engine: cfg.get('compileCurrent.engine', 'lualatex'), force: cfg.get('forceRebuild', true) });
          const own = path.join(plan.cwd, plan.job + '.pdf');
          if (fs.existsSync(own)) pdf = own;
          else {
            return { warn: 'PDF цього файла (' + path.basename(own) + ') ще немає. Збери його кнопкою ▶ («Зібрати цей файл окремо»); main.pdf не відкриваю, бо це інший документ.' };
          }
        } catch (e) { /* the usual way below */ }
      }
      const cand = path.join(cwd, job + '.pdf');
      if (!pdf && fs.existsSync(cand)) pdf = cand;
    }
  }
  if (!pdf && lastPdf && fs.existsSync(lastPdf)) pdf = lastPdf;
  return { pdf, ctx };
}

// the button: PDF of the active file (or the last built one) in the external viewer;
// `sync` (command tssworkflow.externalForwardSearch): jump to the cursor line with SyncTeX (tssworkflow.externalSyncArgs).
// Before the jump the synctex file is read: a PDF that does not contain this file (it was built from another chapter) gets a warning
// instead of a viewer that silently does nothing; a PDF that spells the path differently (case) is given the spelling of the PDF.
async function openPdfExternal(sync) {
  const r = activePdf();
  if (r.warn) { vscode.window.showWarningMessage(r.warn); return; }
  if (!r.pdf) {
    vscode.window.showWarningMessage('PDF не знайдено. Спершу збери документ кнопкою ▷.');
    return;
  }
  if (sync === true) {
    let pre = {};
    try { pre = SY.precheck(r.pdf, r.ctx); } catch (e) { pre = {}; } // the check is a help, never a reason not to open the viewer
    if (pre.file) r.ctx.file = pre.file;
    if (pre.warn) {
      const pick = await vscode.window.showWarningMessage(pre.warn, ...pre.buttons);
      if (pick === pre.buttons[1]) { vscode.commands.executeCommand('tssworkflow.synctexDiagnose'); return; }
      if (pick !== pre.buttons[0]) return;
    }
  }
  launchExternal(r.pdf, r.ctx, sync === true ? 'externalSyncArgs' : undefined);
}

// the PDF opened by vscode.open needs LW's viewer bound to *.pdf (workbench.editorAssociations); without it VS Code
// has no editor for a .pdf and shows an empty or binary tab. package.json sets it as a default; this is the safety net
let extCtx = null;
let assocPrompted = false;
const LW_ID = 'James-Yu.latex-workshop';
const PDF_HOOK = 'latex-workshop-pdf-hook';

function hasPdfAssociation(a) {
  if (Array.isArray(a)) return a.some((x) => x && /pdf/i.test(String(x.filenamePattern || '')));
  return !!a && typeof a === 'object' && Object.keys(a).some((k) => /pdf/i.test(k));
}

async function applyPdfAssociation() {
  const wb = vscode.workspace.getConfiguration('workbench');
  const ins = wb.inspect('editorAssociations');
  const cur = ins && ins.globalValue;
  let next;
  if (Array.isArray(cur)) next = cur.concat([{ filenamePattern: '*.pdf', viewType: PDF_HOOK }]);
  else next = Object.assign({}, cur && typeof cur === 'object' ? cur : {}, { '*.pdf': PDF_HOOK });
  await wb.update('editorAssociations', next, vscode.ConfigurationTarget.Global);
}

function checkPdfAssociation() {
  if (assocPrompted || !extCtx || extCtx.globalState.get('noPdfAssocPrompt')) return;
  if (!vscode.extensions.getExtension(LW_ID)) return; // no LaTeX Workshop: nothing to bind to
  if (hasPdfAssociation(vscode.workspace.getConfiguration('workbench').get('editorAssociations'))) return;
  assocPrompted = true;
  vscode.window.showWarningMessage(
    'Для *.pdf не задано вьюер (workbench.editorAssociations), тому PDF збоку може не відкритись. ' +
    'Прив\'язати *.pdf до вьюера LaTeX Workshop у користувацьких налаштуваннях?',
    'Застосувати', 'Не питати'
  ).then(async (pick) => {
    if (pick === 'Застосувати') {
      try {
        await applyPdfAssociation();
        vscode.window.showInformationMessage('Готово: *.pdf відкривається вьюером LaTeX Workshop. Збери ще раз кнопкою ▷.');
      } catch (err) {
        vscode.window.showErrorMessage('Не вдалося записати налаштування: ' + (err && err.message ? err.message : err));
      }
    } else if (pick === 'Не питати') {
      extCtx.globalState.update('noPdfAssocPrompt', true);
    }
  });
}

// diagnostics for "the PDF does not open / opens twice": settings that decide it and the tabs before and after opening.
// Written to Output -> TSS Workflow after every build that opens a PDF
function pdfDiag(stage) {
  if (!LOG) return;
  try {
    const val = (sec, key) => {
      const c = vscode.workspace.getConfiguration(sec);
      const ins = c.inspect(key) || {};
      return key + ' = ' + JSON.stringify({ eff: c.get(key), user: ins.globalValue, workspace: ins.workspaceValue, folder: ins.workspaceFolderValue });
    };
    const lw = vscode.extensions.getExtension(LW_ID);
    const lines = ['--- PDF diag: ' + stage + ' ---'];
    if (stage.indexOf('до') === 0) {
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      lines.push('LaTeX Workshop: ' + (lw ? lw.packageJSON.version + (lw.isActive ? ' (active)' : ' (not active)') : 'не встановлено'));
      lines.push('workspace trusted: ' + vscode.workspace.isTrusted + ', folder: ' + (folder ? folder.uri.fsPath : '-') +
        ', .vscode: ' + (folder ? fs.existsSync(path.join(folder.uri.fsPath, '.vscode')) : '-'));
      lines.push(val('workbench', 'editorAssociations'));
      lines.push(val('latex-workshop', 'view.pdf.viewer'));
      lines.push(val('latex-workshop', 'view.pdf.tab.editorGroup'));
      lines.push(val('latex-workshop', 'latex.autoBuild.run'));
      lines.push(val('tssworkflow', 'pdfViewer'));
      lines.push(val('tssworkflow', 'pdfBeside'));
    }
    const tg = vscode.window.tabGroups;
    if (!tg) lines.push('tabGroups API недоступний у цій версії VS Code');
    else {
      for (const g of tg.all) {
        lines.push('група ' + g.viewColumn + (g.isActive ? ' (активна)' : '') + ': ' + (g.tabs.map((t) => {
          const inp = t.input || {};
          return t.label + ' [' + (inp.viewType || (inp.uri ? 'file' : '?')) + ']';
        }).join(', ') || 'порожня'));
      }
    }
    LOG.appendLine(lines.join('\n'));
  } catch (err) {
    LOG.appendLine('PDF diag: помилка ' + (err && err.message ? err.message : err));
  }
}

// PDF through LaTeX Workshop's own viewer. vscode.open on a .pdf goes through LW's custom-editor hook: it leaves an
// empty tab in the side group and opens the real viewer in the current group. So ask LW directly (it picks the
// root file from `% !TeX root`, places the tab by latex-workshop.view.pdf.tab.editorGroup and reuses an open tab)
async function openInLatexWorkshop(pdf) {
  const ed = vscode.window.activeTextEditor;
  const col = ed && ed.viewColumn;
  // LW takes the PDF of its own root, found from the active file. A file it cannot find the root of (a .tikz: no \\documentclass,
  // no `% !TeX root`) leaves the viewer on the previous PDF, e.g. the standalone one: then the PDF that was just built is opened
  // by its path, the way the external viewer does it
  if (ed && !P.lwRootResolvable(ed.document.getText())) {
    LOG.appendLine('PDF: LaTeX Workshop не знайде корінь для ' + path.basename(ed.document.uri.fsPath) + ' (немає \\documentclass і % !TeX root): відкриваю ' + pdf + ' за шляхом');
    checkPdfAssociation();
    const beside = vscode.workspace.getConfiguration('tssworkflow').get('pdfBeside', true);
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdf), beside ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false } : { preview: false });
    return;
  }
  try {
    const cmds = await vscode.commands.getCommands(true);
    // 'latex-workshop.tab' opens the viewer tab regardless of latex-workshop.view.pdf.viewer (which may be 'external' in the
    // user settings when the project has no .vscode/settings.json); 'latex-workshop.view' obeys that setting
    const cmd = cmds.includes('latex-workshop.tab') ? 'latex-workshop.tab' : 'latex-workshop.view';
    if (!cmds.includes(cmd)) throw new Error('LaTeX Workshop не встановлено або не активний');
    await vscode.commands.executeCommand(cmd);
    // the viewer takes focus: give it back to the text
    if (ed && col) await vscode.window.showTextDocument(ed.document, { viewColumn: col, preserveFocus: false, selection: ed.selection });
  } catch (err) {
    vscode.window.showWarningMessage('PDF через LaTeX Workshop не відкрився: ' + (err && err.message ? err.message : err) + '. Відкриваю звичайним способом.');
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdf), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
  }
}

// runs latexmk and, when it finishes, parses the log and (optionally) opens the PDF
let buildSeq = 0;
async function runBuild({ folder, cwd: cwdOverride, args, job, label, openPdf, done, exe, repeat, steps }) {
  if (building) { busyWarning(); if (done) done(); return; }
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const cwd = cwdOverride || folder.uri.fsPath; // folder: the workspace folder of the task (or TaskScope.Workspace); cwd: where the build runs and writes
  // unwrapped log lines, so that the warnings can be attributed to files
  const env = { max_print_line: '10000', error_line: '254', half_error_line: '238' };
  const id = ++buildSeq;
  // from here on and until the process ends no other build can start (set before the first await)
  building = { id, job, label, started: Date.now(), execution: null, abort: null };
  // tssworkflow.compilePasses.*: the engine is run exactly N times in a row, with the bibliography tools between the first and the
  // second run when the build has them (a pass number that is known, not guessed from the log); without steps: one command, repeat times
  const stepList = steps && steps.length ? steps : Array.from({ length: Math.max(1, Math.min(9, Math.floor(Number(repeat) || 1))) }, () => ({ exe, args, tex: true }));
  const total = stepList.filter((s) => s.tex).length;
  let idx = -1; // the step that runs now
  let run = 0; // the runs of the engine that have started
  if (total > 1 || (steps && steps.length && cfg.get('showPasses', true))) {
    building.fixedPasses = true;
    building.lastPasses = total;
    building.counter = { pass: 0 };
  }
  const stepIO = { exists: (n) => fs.existsSync(path.join(cwd, n)), read: (n) => fs.readFileSync(path.join(cwd, n), 'utf8') };
  const nextStep = (from) => { for (let k = from; k < stepList.length; k++) if (P.stepApplies(stepList[k], stepIO)) return k; return -1; };
  // latexmk reruns LaTeX: show the number of the run, with the number of runs of the previous build as the total
  if (!exe && total === 1 && cfg.get('showPasses', true)) {
    const b = building;
    b.counter = P.makePassCounter(b.started);
    b.lastPasses = (extCtx && extCtx.workspaceState.get('passes:' + job)) || 0;
    const logPath = path.join(cwd, job + '.log');
    b.passTimer = setInterval(() => {
      let st;
      try { st = fs.statSync(logPath); } catch (e) { return; }
      const before = b.counter.pass;
      if (b.counter.feed(st.size, st.mtimeMs) !== before) renderBuild();
    }, 200);
  }
  cancelTimer('build.result');
  setBuildContext(true);
  renderBuild();
  clearInterval(buildTimer);
  buildTimer = setInterval(renderBuild, 1000); // writes only if the text changed (see renderBuild)
  let finished = false;
  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    endBuild(id, outcome || { stopped: true });
    if (done) done();
  };
  // subscribe BEFORE starting, so that a process that dies at once (latexmk not found) is not missed
  const sub = vscode.tasks.onDidEndTaskProcess((ev) => {
    if (!ev.execution || !ev.execution.task || ev.execution.task.definition.id !== id) return;
    // a build stopped by the user may end with any exit code
    const stopped = !!(building && building.id === id && building.stopping) || ev.exitCode === undefined;
    // the next step: after a run of the engine only if it succeeded; a failed bibliography tool does not stop the runs (latexmk goes on too)
    const cur = stepList[idx];
    if (!stopped && (ev.exitCode === 0 || (cur && !cur.tex))) {
      const nx = nextStep(idx + 1);
      if (nx >= 0) { startTask(nx); return; }
    }
    sub.dispose();
    try { Promise.resolve(features.onBuildFinished(cwd, job)).catch(() => {}); } catch (err) { /* log parsing is best effort */ }
    finish(stopped ? { stopped: true } : ev.exitCode === 0 ? { ok: true } : { ok: false, code: ev.exitCode });
    if (stopped) return;
    if (ev.exitCode === 0) {
      lastPdf = path.join(cwd, job + '.pdf');
      if (openPdf) {
        const viewer = cfg.get('pdfViewer', 'vscode');
        pdfDiag('до відкриття PDF (' + viewer + ')');
        debounce('build.pdfDiag', 3000, () => pdfDiag('через 3 с після відкриття'));
        if (viewer === 'external') {
          launchExternal(lastPdf, {});
        } else if (viewer === 'latexworkshop' || (viewer === 'vscode' && vscode.extensions.getExtension(LW_ID))) {
          // with LaTeX Workshop installed, 'vscode' goes through its command too: vscode.open on a .pdf depends on the hook,
          // and the hook depends on latex-workshop.view.pdf.viewer, i.e. on whether the project has .vscode/settings.json
          openInLatexWorkshop(lastPdf);
        } else if (viewer !== 'none') {
          checkPdfAssociation();
          const beside = cfg.get('pdfBeside', true);
          const opts = beside
            ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false }
            : { preview: false };
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(lastPdf), opts);
        }
      }
    } else {
      vscode.window.showWarningMessage('Компіляція ' + job + ' завершилась з помилками (код ' + ev.exitCode + '). Дивись вкладку Problems.');
    }
  });
  const startTask = async (at) => {
    try {
      idx = at === undefined ? nextStep(0) : at;
      const step = stepList[idx];
      if (step.tex) run++;
      if (step.tex && building && building.id === id && building.counter && building.fixedPasses) {
        building.counter.pass = run;
        renderBuild();
      }
      const cmd = step.exe || cfg.get('latexmk', 'latexmk');
      const exec = new vscode.ProcessExecution(cmd, step.args, { cwd, env });
      const task = new vscode.Task(
        { type: 'tssworkflow', job, id },
        folder,
        step.tex ? label : label + ' · ' + path.basename(String(step.exe)),
        'tssworkflow',
        exec,
        ['pplatex', 'texlogsieve'].includes(cfg.get('logParser', 'builtin')) ? [] : '$tssworkflow-latex'
      );
      task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Silent,
        clear: true,
        showReuseMessage: false
      };
      if (building && building.id === id) building.abort = () => { sub.dispose(); finish({ stopped: true }); };
      const execution = await vscode.tasks.executeTask(task);
      if (building && building.id === id) building.execution = execution;
    } catch (err) {
      sub.dispose();
      vscode.window.showErrorMessage('Не вдалося запустити ' + ((stepList[idx] && stepList[idx].exe) || exe || cfg.get('latexmk', 'latexmk')) + ': ' + (err && err.message ? err.message : err));
      finish({ ok: false, code: 'запуск' });
    }
  };
  await startTask();
}

// how many times the engine runs for this kind of build: 'main' (4), 'separate' (2), 'chapter' = a chapter or a figure (1);
// 0: latexmk decides. A value the user did not set yields the default (the old singlePass / passes count for a chapter only if passes > 0)
function passesFor(kind) {
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const key = { main: 'compilePasses.main', separate: 'compilePasses.separate', chapter: 'compilePasses.chapter' }[kind];
  let explicit;
  try {
    const ins = cfg.inspect(key);
    if (ins && [ins.globalValue, ins.workspaceValue, ins.workspaceFolderValue].some((v) => v !== undefined)) explicit = cfg.get(key);
  } catch (e) { /* the default */ }
  return P.resolvePasses(kind, { explicit, singlePass: cfg.get('singlePass', true), passes: cfg.get('passes', 0) });
}

// the program of a plain run: the engine of the build; lualatex may have its own path (tssworkflow.lualatex)
const engineExe = (name) => (name === 'lualatex' ? vscode.workspace.getConfiguration('tssworkflow').get('lualatex', 'lualatex') : name);

// does a build of this kind open the PDF when it has finished: the command asked for it and it is not switched off for the kind
// (tssworkflow.openPdf.main / .separate / .chapter, all on by default; the chapter setting covers figures too)
const OPEN_PDF_KEY = { main: 'openPdf.main', separate: 'openPdf.separate', chapter: 'openPdf.chapter' };
const openPdfFor = (kind, requested) => requested !== false && !!vscode.workspace.getConfiguration('tssworkflow').get(OPEN_PDF_KEY[kind], true);

// whole document: latexmk on the main file (tssworkflow.mainFile, default main.tex)
async function compileMain(openPdf, done, fileOverride) {
  openPdf = openPdfFor('main', openPdf);
  const ed = vscode.window.activeTextEditor;
  const folder = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) {
    vscode.window.showWarningMessage('Відкрий папку проєкту (workspace).');
    if (done) done();
    return;
  }
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const mainFile = fileOverride || cfg.get('mainFile', 'main.tex') || 'main.tex';
  if (!fs.existsSync(path.join(folder.uri.fsPath, mainFile))) {
    vscode.window.showWarningMessage('Не знайдено ' + mainFile + ' у корені проєкту (налаштування tssworkflow.mainFile).');
    if (done) done();
    return;
  }
  const job = path.basename(mainFile, path.extname(mainFile));
  const args = [
    ...(cfg.get('forceRebuild', true) ? ['-g'] : []),
    '-lualatex', '-interaction=nonstopmode', '-synctex=1', '-file-line-error', '-shell-escape',
    mainFile
  ];
  const n = passesFor('main');
  if (n === 0) return runBuild({ folder, args, job, label: 'Compile ' + mainFile, openPdf, done }); // latexmk decides
  // exactly n runs of the engine, biber / bibtex between the first and the second one
  const plain = P.plainFromLatexmk(args);
  const exe = engineExe(plain.exe);
  const steps = P.buildSteps({ exe, args: plain.args, n, tools: true, job, biber: cfg.get('biber', 'biber'), bibtex: cfg.get('bibtex', 'bibtex') });
  await runBuild({ folder, args: plain.args, exe, steps, job, label: 'Compile ' + mainFile, openPdf, done });
}

// a chapter / figure file with \documentclass is a whole document: it cannot be put into the driver (alone.tex).
// Root files (main.tex, alone.tex ...) are not checked: ▷ / F5 on them build the whole document
function warnDocumentClass(doc) {
  const name = path.basename(doc.uri.fsPath);
  const btn = 'Зібрати цей файл окремо';
  vscode.window.showWarningMessage(
    '«' + name + '» містить \\documentclass: це окремий документ, а не розділ чи рисунок, тож його не можна підставити в драйвер і зібрати кнопкою ▷ (F5). Збірку не запущено.',
    btn
  ).then((pick) => { if (pick === btn) compileCurrent(true); });
}
const docClassWarned = new Set(); // Auto-compile warns once per file and session

// .cls / .sty / ... are not documents: instead of putting them into the driver, offer to build the whole document
function warnPackageFile(doc, openPdf, done) {
  const name = path.basename(doc.uri.fsPath);
  const mainFile = vscode.workspace.getConfiguration('tssworkflow').get('mainFile', 'main.tex') || 'main.tex';
  const btn = 'Зібрати ' + mainFile;
  vscode.window.showWarningMessage(
    '«' + name + '» це клас чи пакет: його не можна зібрати окремо, лише разом з документом, що його підключає.',
    btn
  ).then((pick) => {
    if (pick === btn) compileMain(openPdf, done);
    else if (done) done();
  });
}

async function compile(openPdf, done) {
  const ed = vscode.window.activeTextEditor;
  if (ed && P.isPackageFile(ed.document.uri.fsPath)) return warnPackageFile(ed.document, openPdf, done);
  // a root file (main.tex, alone.tex, ...) is not a chapter: build the whole document
  if (ed) {
    const fo = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    if (fo && isRootTex(ed.document, fo)) return compileMain(openPdf, done);
  }
  if (ed && P.hasDocumentClass(ed.document.getText())) {
    warnDocumentClass(ed.document);
    if (done) done();
    return;
  }
  const t = target();
  if (!t) { if (done) done(); return; }
  openPdf = openPdfFor('chapter', openPdf);
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  // exactly N runs of plain lualatex (latexmk cannot be told "run exactly N times"); 0: latexmk decides how many runs are needed
  const n = passesFor('chapter');
  if (n === 0) {
    await runBuild({ folder: t.folder, args: latexArgs(t, cfg.get('driver', 'alone.tex'), cfg.get('forceRebuild', true)), job: t.job, label: 'Compile ' + t.job, openPdf, done });
    return;
  }
  const exe = cfg.get('lualatex', 'lualatex');
  const args = singlePassArgs(t, cfg.get('driver', 'alone.tex'));
  await runBuild({ folder: t.folder, exe, args, steps: P.buildSteps({ exe, args, n, tools: false, job: t.job }), job: t.job, label: 'Compile ' + t.job, openPdf, done });
}

/* The file in the active editor on its own, with its own preamble (a document with \documentclass that is not the project's
 * main file): latexmk runs on this file, not through the driver and not on mainFile. The job is named after the file and the
 * PDF stands next to it (tssworkflow.compileCurrent.workDir = 'file') or in the workspace folder ('workspace'). */
async function compileCurrent(openPdf, done) {
  const ed = vscode.window.activeTextEditor;
  const finish = () => { if (done) done(); };
  if (!ed || !/\.(?:tex|ltx)$/i.test(ed.document.uri.fsPath)) {
    vscode.window.showInformationMessage('Відкрий .tex-файл з \\documentclass, який треба зібрати окремо.');
    return finish();
  }
  const doc = ed.document;
  const file = doc.uri.fsPath;
  if (P.isPackageFile(file)) return warnPackageFile(doc, openPdf, done);
  if (!P.hasDocumentClass(doc.getText())) {
    const asChapter = 'Зібрати як розділ (▷)';
    const whole = 'Зібрати весь документ';
    const pick = await vscode.window.showWarningMessage(
      '«' + path.basename(file) + '» не має \\documentclass, тож окремо його не зібрати: немає преамбули.',
      asChapter, whole
    );
    if (pick === asChapter) return compile(openPdf, done);
    if (pick === whole) return compileMain(openPdf, done);
    return finish();
  }
  if (doc.isDirty && !(await doc.save())) { vscode.window.showWarningMessage('Не вдалося зберегти файл перед збіркою.'); return finish(); }
  openPdf = openPdfFor('separate', openPdf);
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const fo = vscode.workspace.getWorkspaceFolder(doc.uri);
  const { cwd, args, job } = P.standalonePlan(file, fo ? fo.uri.fsPath : null, {
    workDir: cfg.get('compileCurrent.workDir', 'file'), engine: cfg.get('compileCurrent.engine', 'lualatex'), force: cfg.get('forceRebuild', true)
  });
  const label = 'Compile ' + path.basename(file) + ' (окремо)';
  const folderArg = fo || vscode.TaskScope.Workspace;
  const n = passesFor('separate');
  if (n === 0) return runBuild({ folder: folderArg, cwd, args, job, label, openPdf, done }); // latexmk decides
  const plain = P.plainFromLatexmk(args);
  const exe = engineExe(plain.exe);
  const steps = P.buildSteps({ exe, args: plain.args, n, tools: true, job, biber: cfg.get('biber', 'biber'), bibtex: cfg.get('bibtex', 'bibtex') });
  await runBuild({ folder: folderArg, cwd, args: plain.args, exe, steps, job, label, openPdf, done });
}

/* The one build command (F5, the button of the tab bar): it does what the button of the status bar does for the same file.
 * A document with its own preamble (Separate) is built on its own; a chapter / figure goes through the driver (alone.tex);
 * the main file, the driver and the other .tex of the project root build the whole document. The PDF is opened as the
 * settings tssworkflow.openPdf.<kind> say. */
async function compileSmart(openPdf, done) {
  const ed = vscode.window.activeTextEditor;
  if (ed && /\.(?:tex|ltx)$/i.test(ed.document.uri.fsPath)) {
    const cfg = vscode.workspace.getConfiguration('tssworkflow');
    const fo = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    const kind = P.statusKind({ file: ed.document.uri.fsPath, text: ed.document.getText(), folder: fo ? fo.uri.fsPath : '', mainFile: cfg.get('mainFile', 'main.tex'), driver: cfg.get('driver', 'alone.tex') });
    if (kind === 'separate') return compileCurrent(openPdf, done);
  }
  return compile(openPdf, done);
}

function clean(withPdf) {
  if (building) { busyWarning(); return; }
  const t = target();
  if (!t) return;
  const cwd = t.folder.uri.fsPath;
  const pdfName = (t.job + '.pdf').toLowerCase();
  let removed = 0;
  const failed = [];
  for (const f of fs.readdirSync(cwd)) {
    if (!f.startsWith(t.job + '.')) continue;
    const full = path.join(cwd, f);
    let isFile = false;
    try { isFile = fs.statSync(full).isFile(); } catch (e) { /* ignore */ }
    if (!isFile) continue;
    if (AUX.test(f) || (withPdf && f.toLowerCase() === pdfName)) {
      try { fs.unlinkSync(full); removed++; } catch (e) { failed.push(f); }
    }
  }
  const minted = path.join(cwd, '_minted-' + t.job);
  if (fs.existsSync(minted)) {
    try { fs.rmSync(minted, { recursive: true, force: true }); removed++; } catch (e) { failed.push('_minted-' + t.job); }
  }
  let msg = t.job + ': видалено ' + removed + (withPdf ? ' (разом з PDF)' : ' (PDF залишено)');
  if (failed.length) msg += '. Не вдалося видалити: ' + failed.join(', ');
  vscode.window.showInformationMessage(msg);
}

/* ------------------------------------------------------------------ *
 * 3. Status bar buttons: the build button (Chapter / Figure / Separate / Main) and the optional Main button
 * ------------------------------------------------------------------ */
function registerStatusButtons(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.tooltip = 'Compile + open PDF';
  item.command = 'tssworkflow.compilePdf';
  // second button (off by default, tssworkflow.statusBarMain): build the whole document and open the PDF
  const mainItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  mainItem.tooltip = 'Build the whole document + open PDF';
  mainItem.command = 'tssworkflow.compileMainPdf';
  mainItem.text = '$(run-all) Main';
  const STATUS_LOOK = {
    chapter: { text: 'Chapter', tip: 'Compile this chapter + open PDF', command: 'tssworkflow.compilePdf' },
    figure: { text: 'Figure', tip: 'Compile this figure + open PDF', command: 'tssworkflow.compilePdf' },
    separate: { text: 'Separate', tip: 'Compile this file on its own (own preamble) + open PDF', command: 'tssworkflow.compileCurrent' },
    main: { text: 'Main', tip: 'Build the whole document + open PDF', command: 'tssworkflow.compilePdf' }
  };
  const refresh = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { item.hide(); mainItem.hide(); return; }
    const id = ed.document.languageId;
    const file = ed.document.uri.fsPath;
    const isTikz = file.toLowerCase().endsWith('.tikz');
    if (id === 'latex' || id === 'tex' || isTikz) {
      const cfg = vscode.workspace.getConfiguration('tssworkflow');
      const fo = vscode.workspace.getWorkspaceFolder(ed.document.uri);
      const kind = P.statusKind({ file, text: ed.document.getText(), folder: fo ? fo.uri.fsPath : '', mainFile: cfg.get('mainFile', 'main.tex'), driver: cfg.get('driver', 'alone.tex') });
      const look = STATUS_LOOK[kind] || STATUS_LOOK.chapter;
      item.text = '$(play) ' + look.text;
      item.tooltip = look.tip;
      item.command = look.command;
      item.show();
      // the second button builds the whole document: not needed beside the button that does it already
      if (cfg.get('statusBarMain', false) && kind !== 'main') mainItem.show(); else mainItem.hide();
    } else {
      item.hide();
      mainItem.hide();
    }
  };
  context.subscriptions.push(item, mainItem, vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow.statusBarMain')) refresh(); }));
  refresh();

  // the button "Compile this file" is shown only in a document with its own preamble (\documentclass)
  let docClassLast = null;
  const updateDocClass = () => {
    const ed = vscode.window.activeTextEditor;
    const on = !!(ed && /\.(?:tex|ltx)$/i.test(ed.document.uri.fsPath) && P.hasDocumentClass(ed.document.getText()));
    if (on === docClassLast) return;
    docClassLast = on;
    vscode.commands.executeCommand('setContext', 'tssworkflow.hasDocumentClass', on);
    refresh(); // the label of the compile button depends on it: Separate / Chapter
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateDocClass),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      debounce('build.docClass', 400, updateDocClass);
    })
  );
  updateDocClass();
}

/* ------------------------------------------------------------------ *
 * 4. Registration
 * ------------------------------------------------------------------ */
// a build for a VS Code task (buildTasks.js): the same build as the button; lastOutcome is reset first so that a build that never
// started (a warning, a build already running) is not mistaken for the previous one
function runForTask(target, openPdf, done) {
  lastOutcome = null;
  const start = target === 'main' ? compileMain(openPdf, done) : compileSmart(openPdf, done);
  Promise.resolve(start).catch(() => done());
}

// api: { channel } the output channel "TSS Workflow"
function register(context, api) {
  extCtx = context;
  LOG = (api && api.channel) || null;
  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.compilePdf', () => compileSmart(true)),
    vscode.commands.registerCommand('tssworkflow.compileCurrent', () => compileCurrent(true)),
    vscode.commands.registerCommand('tssworkflow.compileMainPdf', () => compileMain(true)),
    // 0.5.0: a copy of the main file with only some \part's (see projectRefactor.js); not in the palette
    vscode.commands.registerCommand('tssworkflow._compileFile', (a) => compileMain(!a || a.openPdf !== false, undefined, a && a.file)),
    vscode.commands.registerCommand('tssworkflow.clean', () => clean(true)),
    vscode.commands.registerCommand('tssworkflow.cleanAux', () => clean(false)),
    vscode.commands.registerCommand('tssworkflow.openPdfExternal', () => openPdfExternal(false)),
    vscode.commands.registerCommand('tssworkflow.externalForwardSearch', () => openPdfExternal(true)),
    vscode.commands.registerCommand('tssworkflow.stopBuild', stopBuild)
  );
  buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  spinItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102); // left of buildItem
  context.subscriptions.push(buildItem, spinItem);
  registerStatusButtons(context);
}

module.exports = {
  register,
  runForTask,
  outcome: () => lastOutcome,
  compile,
  compileCurrent,
  compileMain,
  compileSmart,
  compileOnSave,
  clean,
  stopBuild,
  openPdfExternal,
  activePdf,
  target
};
