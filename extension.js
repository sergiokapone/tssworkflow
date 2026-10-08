const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const P = require('./corePure');
const features = require('./features');

/* ------------------------------------------------------------------ *
 * 1. Clickable file names
 *    \localinput{name}                -> <dir of current file>/tikz/name
 *    \includegraphics[opts]{name}     -> <dir of current file>/Pictures/name
 * ------------------------------------------------------------------ */
const RULES = [
  { re: /\\localinput\{([^}]+)\}/g, sub: 'tikz', macro: '\\localinput', exts: ['.tikz', '.tex'] },
  {
    re: /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g,
    sub: 'Pictures',
    macro: '\\includegraphics',
    exts: ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif', '.tif', '.tiff']
  }
];

// 0.7.0: folder of a legacy macro from the table tssworkflow.fileMacros (filesAndLabels.js)
function subOf(macro, fallback) {
  try { return require('./filesAndLabels').legacySub(macro, fallback); } catch (e) { return fallback; }
}

function resolveFile(dir, sub, name, exts) {
  const base = path.join(dir, sub, name);
  if (fs.existsSync(base)) return base;
  if (!path.extname(name)) {
    for (const e of exts) {
      if (fs.existsSync(base + e)) return base + e;
    }
  }
  return base; // let VS Code report "file not found"
}

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
let pendingDoc = null; // a chapter saved while a build was running: it is built when that one ends
let buildItem = null;
let spinItem = null; // constant '$(sync~spin)': a codicon restarts its rotation whenever the text of ITS item changes, so it must not share an item with the ticking seconds
let buildTimer = null;
let resultTimer = null;

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
      ? '\nПрохід LaTeX ' + pass + ' із ' + last + ' (tssworkflow.passes)'
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
  clearTimeout(resultTimer);
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
  resultTimer = setTimeout(() => { if (!building && buildItem) buildItem.hide(); }, ms);
}

function endBuild(id, outcome) {
  if (!building || building.id !== id) return;
  const b = building;
  building = null;
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

// the button: PDF of the active file (or the last built one) in the external viewer;
// `sync` (command tssworkflow.externalForwardSearch): jump to the cursor line with SyncTeX (tssworkflow.externalSyncArgs)
function openPdfExternal(sync) {
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
      const cand = path.join(cwd, job + '.pdf');
      if (fs.existsSync(cand)) pdf = cand;
    }
  }
  if (!pdf && lastPdf && fs.existsSync(lastPdf)) pdf = lastPdf;
  if (!pdf) {
    vscode.window.showWarningMessage('PDF не знайдено. Спершу збери документ кнопкою ▷.');
    return;
  }
  launchExternal(pdf, ctx, sync === true ? 'externalSyncArgs' : undefined);
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
async function runBuild({ folder, args, job, label, openPdf, done, exe, repeat }) {
  if (building) { busyWarning(); if (done) done(); return; }
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const cwd = folder.uri.fsPath;
  // unwrapped log lines, so that the warnings can be attributed to files
  const env = { max_print_line: '10000', error_line: '254', half_error_line: '238' };
  const id = ++buildSeq;
  // from here on and until the process ends no other build can start (set before the first await)
  building = { id, job, label, started: Date.now(), execution: null, abort: null };
  // tssworkflow.passes = N: the same command is run exactly N times in a row (a pass number that is known, not guessed from the log)
  const total = Math.max(1, Math.min(9, Math.floor(Number(repeat) || 1)));
  let run = 0;
  if (total > 1) {
    building.fixedPasses = true;
    building.lastPasses = total;
    building.counter = { pass: 0 };
  }
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
  clearTimeout(resultTimer);
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
    if (!stopped && ev.exitCode === 0 && run < total) { startTask(); return; } // the next of N runs
    sub.dispose();
    try { Promise.resolve(features.onBuildFinished(cwd, job)).catch(() => {}); } catch (err) { /* log parsing is best effort */ }
    finish(stopped ? { stopped: true } : ev.exitCode === 0 ? { ok: true } : { ok: false, code: ev.exitCode });
    if (stopped) return;
    if (ev.exitCode === 0) {
      lastPdf = path.join(cwd, job + '.pdf');
      if (openPdf) {
        const viewer = cfg.get('pdfViewer', 'vscode');
        pdfDiag('до відкриття PDF (' + viewer + ')');
        setTimeout(() => pdfDiag('через 3 с після відкриття'), 3000);
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
  const startTask = async () => {
    try {
      run++;
      if (building && building.id === id && building.counter && building.fixedPasses) {
        building.counter.pass = run;
        renderBuild();
      }
      const cmd = exe || cfg.get('latexmk', 'latexmk');
      const exec = new vscode.ProcessExecution(cmd, args, { cwd, env });
      const task = new vscode.Task(
        { type: 'tssworkflow', job, id },
        folder,
        label,
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
      vscode.window.showErrorMessage('Не вдалося запустити ' + (exe || cfg.get('latexmk', 'latexmk')) + ': ' + (err && err.message ? err.message : err));
      finish({ ok: false, code: 'запуск' });
    }
  };
  await startTask();
}

// whole document: latexmk on the main file (tssworkflow.mainFile, default main.tex)
async function compileMain(openPdf, done, fileOverride) {
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
  await runBuild({ folder, args, job, label: 'Compile ' + mainFile, openPdf, done });
}

// a chapter / figure file with \documentclass is a whole document: it cannot be put into the driver (alone.tex).
// Root files (main.tex, alone.tex ...) are not checked: ▷ / F5 on them build the whole document
function warnDocumentClass(doc) {
  const name = path.basename(doc.uri.fsPath);
  vscode.window.showWarningMessage(
    '«' + name + '» містить \\documentclass: це окремий документ, а не розділ чи рисунок, тож його не можна підставити в драйвер і зібрати кнопкою ▷ (F5). Збірку не запущено.'
  );
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
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const single = cfg.get('singlePass', true);
  // singlePass = false and passes = N > 0: exactly N runs of plain lualatex (latexmk cannot be told "run exactly N times");
  // passes = 0: latexmk decides how many runs are needed
  const passes = single ? 1 : Math.max(0, Math.min(9, Math.floor(Number(cfg.get('passes', 0)) || 0)));
  const fixed = !single && passes > 0;
  await runBuild({
    folder: t.folder,
    exe: single || fixed ? cfg.get('lualatex', 'lualatex') : undefined,
    args: single || fixed
      ? singlePassArgs(t, cfg.get('driver', 'alone.tex'))
      : latexArgs(t, cfg.get('driver', 'alone.tex'), cfg.get('forceRebuild', true)),
    job: t.job,
    label: 'Compile ' + t.job,
    openPdf,
    done,
    repeat: fixed ? passes : 1
  });
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
 * 3. Linked editing of \begin{env} / \end{env}
 *    (needs "editor.linkedEditing": true, enabled for [latex] by default)
 * ------------------------------------------------------------------ */
const ENV_TOKEN = /\\(begin|end)\{([^{}]*)\}/g;

function envTokens(doc) {
  const toks = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    ENV_TOKEN.lastIndex = 0;
    let m;
    while ((m = ENV_TOKEN.exec(text)) !== null) {
      // skip commented-out tokens (unescaped %)
      if (text.slice(0, m.index).replace(/\\./g, '').includes('%')) continue;
      const start = m.index + m[0].indexOf('{') + 1;
      toks.push({ type: m[1], name: m[2], range: new vscode.Range(i, start, i, start + m[2].length) });
    }
  }
  return toks;
}

// pair by nesting (not by name), so it keeps working while the name is being edited
function envPartner(toks, idx) {
  const stack = [];
  const pair = new Map();
  toks.forEach((t, i) => {
    if (t.type === 'begin') stack.push(i);
    else if (stack.length) {
      const b = stack.pop();
      pair.set(b, i);
      pair.set(i, b);
    }
  });
  return pair.get(idx);
}

const linkedEnv = {
  provideLinkedEditingRanges(doc, pos) {
    const toks = envTokens(doc);
    const idx = toks.findIndex((t) => t.range.contains(pos));
    if (idx < 0) return undefined;
    const partner = envPartner(toks, idx);
    if (partner === undefined) return undefined;
    return new vscode.LinkedEditingRanges([toks[idx].range, toks[partner].range], /[^{}\\\s]+/);
  }
};

/* ------------------------------------------------------------------ *
 * 4. Ctrl+click / F12 on \ref{label}, \eqref{label} ... -> \label{label}
 * ------------------------------------------------------------------ */
const REF_RE = new RegExp('\\\\(?:' + P.REF_CMDS + ')\\*?\\{([^}]*)\\}', 'g');

function labelAt(doc, pos) {
  const text = doc.lineAt(pos.line).text;
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(text)) !== null) {
    const argStart = m.index + m[0].indexOf('{') + 1;
    const argEnd = argStart + m[1].length;
    if (pos.character < argStart || pos.character > argEnd) continue;
    let off = argStart;
    for (const part of m[1].split(',')) {
      const s = off;
      const e = off + part.length;
      if (pos.character >= s && pos.character <= e) {
        const name = part.trim();
        const lead = part.length - part.trimStart().length;
        return { name, range: new vscode.Range(pos.line, s + lead, pos.line, s + lead + name.length) };
      }
      off = e + 1;
    }
  }
  return null;
}

function findLabelIn(text, name, base) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\\\label\\{' + (base && name === base ? '(?:' + esc + '|\\\\currfilebase)' : esc) + '\\}');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && !lines[i].slice(0, m.index).replace(/\\./g, '').includes('%')) {
      return new vscode.Position(i, m.index);
    }
  }
  return null;
}

const refDefinition = {
  async provideDefinition(doc, pos) {
    const hit = labelAt(doc, pos);
    if (!hit) return undefined;
    // 1) current file
    const here = findLabelIn(doc.getText(), hit.name, path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath)));
    if (here) return new vscode.Location(doc.uri, here);
    // 2) other .tex/.tikz files of the workspace (same folder first)
    const files = await vscode.workspace.findFiles('**/*.{tex,tikz}', '{**/build/**,**/.archive/**,**/node_modules/**}', 1000);
    const dir = path.dirname(doc.uri.fsPath);
    files.sort((a, b) => Number(b.fsPath.startsWith(dir)) - Number(a.fsPath.startsWith(dir)));
    for (const f of files) {
      if (f.fsPath === doc.uri.fsPath) continue;
      let txt;
      try { txt = fs.readFileSync(f.fsPath, 'utf8'); } catch (e) { continue; }
      const p = findLabelIn(txt, hit.name, path.basename(f.fsPath, path.extname(f.fsPath)));
      if (p) return new vscode.Location(f, p);
    }
    return undefined;
  }
};

/* ------------------------------------------------------------------ *
 * 5. File-name completion inside \localinput{...} and \includegraphics[..]{...}
 *    \localinput      -> files of <dir of current file>/tikz  (with extension)
 *    \includegraphics -> files of <dir of current file>/Pictures (without extension)
 * ------------------------------------------------------------------ */
const PIC_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif', '.tif', '.tiff'];
const COMPLETE = [
  { re: /\\localinput\{([^}]*)$/, macro: '\\localinput', sub: 'tikz', exts: ['.tikz', '.tex'], stripExt: false },
  { re: /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/, macro: '\\includegraphics', sub: 'Pictures', exts: PIC_EXTS, stripExt: true }
];

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

let LOG = null; // output channel "TSS Workflow"
let triggerTimer = null;

const fileCompletion = {
  provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (LOG && /\\(localinput|includegraphics)/.test(before)) LOG.appendLine('completion asked: ' + before.slice(-60));
    for (const c of COMPLETE) {
      const m = c.re.exec(before);
      if (!m) continue;
      const range = new vscode.Range(pos.line, pos.character - m[1].length, pos.line, pos.character);
      const dir = path.join(path.dirname(doc.uri.fsPath), subOf(c.macro, c.sub));
      const seen = new Set();
      const items = [];
      for (const rel of listFiles(dir, c.exts, 3)) {
        const text = c.stripExt ? rel.slice(0, rel.length - path.extname(rel).length) : rel;
        if (seen.has(text)) continue;
        seen.add(text);
        const it = new vscode.CompletionItem(text, vscode.CompletionItemKind.File);
        it.detail = c.sub + '/' + rel;
        it.range = range;
        it.filterText = text;
        it.sortText = '0_' + text;
        items.push(it);
      }
      if (LOG) LOG.appendLine('  -> ' + items.length + ' items from ' + dir);
      return items;
    }
    return undefined;
  }
};

/* ------------------------------------------------------------------ *
 * 6. Command: pick a file name from a list (Ctrl+Alt+I) for the argument
 *    of \localinput{...} / \includegraphics[...]{...} under the cursor
 * ------------------------------------------------------------------ */
const ARG_RULES = [
  { re: /\\localinput\{([^}]*)\}/g, c: COMPLETE[0] },
  { re: /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g, c: COMPLETE[1] }
];

function argContext(text, col) {
  for (const r of ARG_RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(text)) !== null) {
      const start = m.index + m[0].lastIndexOf('{') + 1;
      const end = start + m[1].length;
      if (col >= start && col <= end) return { c: r.c, start, end };
    }
  }
  return null;
}

async function pickFile() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const pos = ed.selection.active;
  const ctx = argContext(ed.document.lineAt(pos.line).text, pos.character);
  if (!ctx) {
    vscode.window.showInformationMessage('Постав курсор усередину {...} у \\localinput або \\includegraphics.');
    return;
  }
  const dir = path.join(path.dirname(ed.document.uri.fsPath), subOf(ctx.c.macro, ctx.c.sub));
  const seen = new Set();
  const items = [];
  for (const rel of listFiles(dir, ctx.c.exts, 3)) {
    const text = ctx.c.stripExt ? rel.slice(0, rel.length - path.extname(rel).length) : rel;
    if (seen.has(text)) continue;
    seen.add(text);
    items.push({ label: text, description: ctx.c.sub + '/' + rel });
  }
  if (!items.length) {
    vscode.window.showWarningMessage('У папці ' + dir + ' немає підхожих файлів.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Файл із ' + ctx.c.sub + '/' });
  if (!picked) return;
  await ed.edit((b) => b.replace(new vscode.Range(pos.line, ctx.start, pos.line, ctx.end), picked.label));
}

/* ------------------------------------------------------------------ *
 * 7. Align table columns at & (like TeXstudio)
 *    - selection      -> aligns the selected lines
 *    - no selection   -> aligns the rows of the innermost tblr/tabular/align/... around the cursor
 *    Only rows that sit on ONE physical line and end with \\ (or are the last row) are touched.
 * ------------------------------------------------------------------ */
function envPairs(toks) {
  const stack = [];
  const pairs = [];
  toks.forEach((t, i) => {
    if (t.type === 'begin') stack.push(i);
    else if (stack.length) pairs.push([stack.pop(), i]);
  });
  return pairs;
}

async function alignTable() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  let startLine;
  let endLine;
  if (!ed.selection.isEmpty) {
    startLine = ed.selection.start.line;
    endLine = ed.selection.end.line;
    if (ed.selection.end.character === 0 && endLine > startLine) endLine--;
  } else {
    const toks = envTokens(doc);
    const cur = ed.selection.active.line;
    let best = null;
    for (const [b, e] of envPairs(toks)) {
      if (!P.ALIGN_ENVS.has(toks[b].name)) continue;
      if (toks[b].range.start.line > cur || toks[e].range.start.line < cur) continue;
      if (!best || toks[b].range.start.line >= toks[best[0]].range.start.line) best = [b, e];
    }
    if (!best) {
      vscode.window.showInformationMessage('Постав курсор усередину таблиці (tblr, tabular, align...) або виділи рядки.');
      return;
    }
    const bt = toks[best[0]];
    const et = toks[best[1]];
    // skip the arguments of \begin{env}: [..] and {..} groups (they may span several lines)
    const text = doc.getText();
    let off = doc.offsetAt(new vscode.Position(bt.range.end.line, bt.range.end.character + 1));
    for (;;) {
      let o = off;
      while (text[o] === ' ' || text[o] === '\t') o++;
      const c = text[o];
      if (c !== '{' && c !== '[') break;
      const close = c === '{' ? '}' : ']';
      let d = 0;
      let k = o;
      for (; k < text.length; k++) {
        const ch = text[k];
        if (ch === '\\') { k++; continue; }
        if (ch === c) d++;
        else if (ch === close) { d--; if (d === 0) break; }
      }
      off = k + 1;
    }
    startLine = doc.positionAt(off).line + 1;
    endLine = et.range.start.line - 1;
  }
  if (endLine < startLine) {
    vscode.window.showInformationMessage('У таблиці немає рядків для вирівнювання.');
    return;
  }
  const oldLines = [];
  for (let i = startLine; i <= endLine; i++) oldLines.push(doc.lineAt(i).text);
  const newLines = P.alignLines(oldLines);
  if (newLines.every((l, i) => l === oldLines[i])) {
    vscode.window.setStatusBarMessage('Таблицю вже вирівняно', 2000);
    return;
  }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const range = new vscode.Range(startLine, 0, endLine, oldLines[oldLines.length - 1].length);
  await ed.edit((b) => b.replace(range, newLines.join(eol)));
}

/* ------------------------------------------------------------------ *
 * 8. Join hard line breaks inside a paragraph (unwrap), like TeXstudio "hard line breaks"
 *    - selection      -> unwraps all paragraphs inside the selected lines
 *    - no selection   -> unwraps the paragraph around the cursor
 *    Never joins across: blank lines, comment lines, lines with a trailing % comment,
 *    lines ending with \\, table rows (&), \begin/\end, sectioning commands, \[ \].
 *    A line starting with \item or \caption may begin a joined block but is never glued to the previous line.
 * ------------------------------------------------------------------ */
async function unwrapParagraph() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  let startLine;
  let endLine;
  if (!ed.selection.isEmpty) {
    startLine = ed.selection.start.line;
    endLine = ed.selection.end.line;
    if (ed.selection.end.character === 0 && endLine > startLine) endLine--;
  } else {
    const cur = ed.selection.active.line;
    if (P.lineKind(doc.lineAt(cur).text) === 'hard') {
      vscode.window.showInformationMessage('Постав курсор в абзац або виділи рядки.');
      return;
    }
    startLine = cur;
    endLine = cur;
    while (startLine > 0 && P.canJoin(doc.lineAt(startLine - 1).text, doc.lineAt(startLine).text)) startLine--;
    while (endLine + 1 < doc.lineCount && P.canJoin(doc.lineAt(endLine).text, doc.lineAt(endLine + 1).text)) endLine++;
  }
  const oldLines = [];
  for (let i = startLine; i <= endLine; i++) oldLines.push(doc.lineAt(i).text);
  const newLines = P.unwrapLines(oldLines);
  if (newLines.length === oldLines.length) {
    vscode.window.setStatusBarMessage('Немає рядків для об\'єднання', 2000);
    return;
  }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const range = new vscode.Range(startLine, 0, endLine, oldLines[oldLines.length - 1].length);
  await ed.edit((b) => b.replace(range, newLines.join(eol)));
}

/* ------------------------------------------------------------------ */
// asks once per start for each workspace folder that has .tex files and no .vscode/settings.json
async function offerProjectSettings(context) {
  if (!vscode.workspace.getConfiguration('tssworkflow').get('offerProjectSettings', true)) return;
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (fs.existsSync(path.join(f.uri.fsPath, '.vscode', 'settings.json'))) continue;
    const key = 'tssworkflow.noSettingsPrompt:' + f.uri.fsPath.toLowerCase();
    if (context.globalState.get(key)) continue;
    const tex = await vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/*.tex'), '{**/node_modules/**,**/.git/**,**/build/**}', 1);
    if (!tex.length) continue;
    const pick = await vscode.window.showInformationMessage(
      'У «' + f.name + '» немає .vscode/settings.json. Створити його із шаблону?',
      'Створити', 'Не питати для цієї папки'
    );
    if (pick === 'Створити') await vscode.commands.executeCommand('tssworkflow.initProjectSettings', f.uri.fsPath);
    else if (pick === 'Не питати для цієї папки') await context.globalState.update(key, true);
  }
}

function activate(context) {
  extCtx = context;
  const provider = {
    provideDocumentLinks(doc) {
      const links = [];
      const dir = path.dirname(doc.uri.fsPath);
      for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        for (const rule of RULES) {
          rule.re.lastIndex = 0;
          let m;
          while ((m = rule.re.exec(text)) !== null) {
            const name = m[1].trim();
            const start = m.index + m[0].lastIndexOf('{') + 1;
            const range = new vscode.Range(i, start, i, start + m[1].length);
            const link = new vscode.DocumentLink(range, vscode.Uri.file(resolveFile(dir, subOf(rule.macro, rule.sub), name, rule.exts)));
            link.tooltip = 'Open ' + name;
            links.push(link);
          }
        }
      }
      return links;
    }
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider([{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }], provider),
    vscode.commands.registerCommand('tssworkflow.compilePdf', () => compile(true)),
    vscode.commands.registerCommand('tssworkflow.compile', () => compile(false)),
    vscode.commands.registerCommand('tssworkflow.compileMainPdf', () => compileMain(true)),
    vscode.commands.registerCommand('tssworkflow.compileMain', () => compileMain(false)),
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

  LOG = vscode.window.createOutputChannel('TSS Workflow');
  context.subscriptions.push(LOG);
  const SEL = [{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }];
  context.subscriptions.push(
    vscode.languages.registerLinkedEditingRangeProvider(SEL, linkedEnv),
    vscode.languages.registerDefinitionProvider(SEL, refDefinition),
    // this selector (language + scheme + pattern) is the one that worked in 0.0.9 (Ctrl+Space)
    vscode.languages.registerCompletionItemProvider(
      [
        { language: 'latex', scheme: 'file', pattern: '**/*.tex' },
        { language: 'latex', scheme: 'file', pattern: '**/*.tikz' },
        { language: 'tex', scheme: 'file', pattern: '**/*.tex' },
        { scheme: 'file', pattern: '**/*.tikz' }
      ],
      fileCompletion,
      '{',
      '/'
    ),
    vscode.commands.registerCommand('tssworkflow.pickFile', pickFile),
    vscode.commands.registerCommand('tssworkflow.alignTable', alignTable),
    vscode.commands.registerCommand('tssworkflow.unwrap', unwrapParagraph),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document || !e.contentChanges.length) return;
      if (!e.contentChanges[0].text) return; // deletion
      const id = e.document.languageId;
      if (id !== 'latex' && id !== 'tex' && !e.document.uri.fsPath.toLowerCase().endsWith('.tikz')) return;
      const pos = ed.selection.active;
      if (!argContext(e.document.lineAt(pos.line).text, pos.character)) return;
      clearTimeout(triggerTimer);
      triggerTimer = setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 30);
    })
  );

  // status bar button
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.tooltip = 'Compile + open PDF';
  item.command = 'tssworkflow.compilePdf';
  // second button (off by default, tssworkflow.statusBarMain): build the whole document and open the PDF
  const mainItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  mainItem.tooltip = 'Build the whole document + open PDF';
  mainItem.command = 'tssworkflow.compileMainPdf';
  mainItem.text = '$(run-all) Main';
  const refresh = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { item.hide(); mainItem.hide(); return; }
    const id = ed.document.languageId;
    const file = ed.document.uri.fsPath;
    const isTikz = file.toLowerCase().endsWith('.tikz');
    if (id === 'latex' || id === 'tex' || isTikz) {
      item.text = '$(play) ' + (isTikz ? 'Figure' : 'Chapter');
      item.show();
      if (vscode.workspace.getConfiguration('tssworkflow').get('statusBarMain', false)) mainItem.show(); else mainItem.hide();
    } else {
      item.hide();
      mainItem.hide();
    }
  };
  context.subscriptions.push(item, mainItem, vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow.statusBarMain')) refresh(); }));
  refresh();

  features.register(context, { onSave: compileOnSave });
  require('./authoring').register(context);
  require('./templates').register(context);
  require('./sidebar').register(context);
  require('./chapters').register(context);
  require('./environment').register(context);
  require('./projectRefactor').register(context, { frameSettings: features.frameSettings });
  require('./formatters').register(context, { applyWithPreview: features.applyWithPreview });
  require('./filesAndLabels').register(context, { applyWithPreview: features.applyWithPreview });
  require('./tableEditor').register(context);
  require('./start').register(context);
  // a project with .tex files but without .vscode/settings.json: offer to create it from the template
  setTimeout(() => offerProjectSettings(context).catch(() => {}), 3000);
}

exports.activate = activate;
exports.compile = compile;
