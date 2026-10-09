'use strict';
/* features.js: the door of the feature modules: registers their commands and providers and re-exports what other modules use. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const P = require('./corePure');
const { EXCLUDE, REF_CTX, SEL, SEL_ANY, cfg, isTexDoc, texFiles, textOf } = require('./util');
const { PREVIEW_SCHEME, applyWithPreview, convertEnv, displayToEquation, frameSectionsCmd, frameSettings, normalizeCmd, normalizeOptions, previewProvider, sentencesCmd, tableOps, typographyCmd, wrapParagraph } = require('./textCommands');
const { buildIndex, checkLabels, diagLabels, markLabelsDirty, refCompletion, renameProvider } = require('./labels');
const { checkCitations, diagCites, initProjectSettings, ltexDictionary } = require('./settingsCitations');
const { checkSyntax, diagSyntax, goToHeading, hoverProvider, imageHoverMd } = require('./checksHovers');
const { diagLog, onBuildFinished, outLog } = require('./buildLog');
const { picturesPanel, syncUserCode, typographyOnWillSave, unusedFiles } = require('./saveAndPictures');
const { QF, quickFixes, symbolProvider } = require('./quickFixes');

/* ------------------------------ register ----------------------------- */
function register(context, api) {
  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  const subs = context.subscriptions;
  syncUserCode();
  require('./macros').register(context, { log: (m) => outLog.appendLine(m), exclude: EXCLUDE });
  require('./tikzExtract').register(context);
  require('./wrapEnv').register(context);
  require('./wrapCmd').register(context);
  require('./projectInfo').register(context, {
    texFiles, textOf, buildIndex, EXCLUDE, log: (m) => outLog.appendLine(m), showLog: () => outLog.show(true)
  });
  subs.push(
    cmd('tssworkflow.wrap', wrapParagraph),
    cmd('tssworkflow.typography', typographyCmd),
    cmd('tssworkflow.sentences', sentencesCmd),
    cmd('tssworkflow.frameSections', () => frameSectionsCmd(false)),
    cmd('tssworkflow.reframeSections', () => frameSectionsCmd(true)),
    cmd('tssworkflow.normalize', normalizeCmd),
    cmd('tssworkflow.normalizeOptions', normalizeOptions),
    cmd('tssworkflow.goToHeading', goToHeading),
    cmd('tssworkflow.tableOps', tableOps),
    cmd('tssworkflow.convertEnv', convertEnv),
    cmd('tssworkflow.displayToEquation', displayToEquation),
    cmd('tssworkflow.pictures', picturesPanel),
    cmd('tssworkflow.unusedFiles', unusedFiles),
    cmd('tssworkflow.checkLabels', () => checkLabels(true)),
    cmd('tssworkflow.checkCitations', () => checkCitations(true)),
    cmd('tssworkflow.initProjectSettings', initProjectSettings),
    cmd('tssworkflow.showHooks', showHooks),
    cmd('tssworkflow.ltexDictionary', ltexDictionary),
    cmd('tssworkflow.toggleCompileOnSave', () =>
      cfg().update('compileOnSave', !cfg().get('compileOnSave', false), vscode.ConfigurationTarget.Global)),
    vscode.languages.registerCompletionItemProvider(SEL, refCompletion, '{', ','),
    vscode.languages.registerRenameProvider(SEL_ANY, renameProvider),
    vscode.languages.registerHoverProvider(SEL_ANY, hoverProvider),
    vscode.languages.registerCodeActionsProvider(SEL_ANY, quickFixes, { providedCodeActionKinds: [QF] }),
    vscode.languages.registerDocumentSymbolProvider(SEL_ANY, symbolProvider, { label: 'TSS Workflow headings' }),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),
    vscode.workspace.onWillSaveTextDocument(typographyOnWillSave),
    diagSyntax,
    diagLabels,
    diagCites,
    diagLog
  );

  // "compile on save" indicator
  const auto = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  auto.command = 'tssworkflow.toggleCompileOnSave';
  const refreshAuto = () => {
    const ed = vscode.window.activeTextEditor;
    auto.text = '$(sync) Auto: ' + (cfg().get('compileOnSave', false) ? 'on' : 'off');
    auto.tooltip = 'Компіляція при збереженні (розділ або рисунок). Клік перемикає.';
    if (ed && isTexDoc(ed.document)) auto.show(); else auto.hide();
  };
  subs.push(auto, vscode.window.onDidChangeActiveTextEditor(refreshAuto));
  refreshAuto();

  // quick error checks (debounced) and project label checks (on save)
  const timers = new Map();
  const later = (doc) => {
    const k = doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => checkSyntax(doc), 700));
  };
  let labelTimer = null;
  let citeTimer = null;
  subs.push(
    vscode.workspace.onDidOpenTextDocument(checkSyntax),
    vscode.workspace.onDidCloseTextDocument((d) => diagSyntax.delete(d.uri)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isTexDoc(e.document)) later(e.document);
      if (!e.contentChanges.length || !e.contentChanges[0].text) return;
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document !== e.document || !isTexDoc(e.document)) return;
      const pos = ed.selection.active;
      if (REF_CTX.test(e.document.lineAt(pos.line).text.slice(0, pos.character))) {
        clearTimeout(timers.get('suggest'));
        timers.set('suggest', setTimeout(() => vscode.commands.executeCommand('editor.action.triggerSuggest'), 30));
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if ((isTexDoc(d) || /\.bib$/i.test(d.fileName)) && cfg().get('diagnostics', true)) {
        clearTimeout(citeTimer);
        citeTimer = setTimeout(() => checkCitations(false), 800);
      }
      if (!isTexDoc(d)) return;
      markLabelsDirty();
      checkSyntax(d);
      if (api && api.onSave && cfg().get('compileOnSave', false)) api.onSave(d);
      if (cfg().get('diagnostics', true)) {
        clearTimeout(labelTimer);
        labelTimer = setTimeout(() => checkLabels(false), 500);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tssworkflow')) {
        syncUserCode();
        refreshAuto();
        vscode.workspace.textDocuments.forEach(checkSyntax);
      }
    })
  );
  vscode.workspace.textDocuments.forEach(checkSyntax);
}

// \ShowHook for the page output hooks: which packages put code into shipout
async function showHooks() {
  const ed = vscode.window.activeTextEditor;
  const folder = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Відкрий папку проєкту (workspace).'); return; }
  const cwd = folder.uri.fsPath;
  const mainFile = cfg().get('mainFile', 'main.tex') || 'main.tex';
  // a chapter (or figure) file of the project: the same document the compile button builds (alone.tex + \TargetChapter);
  // a root file or no editor: the whole document (mainFile)
  const target = ed && ed.document.uri.fsPath.startsWith(cwd) && !P.isPackageFile(ed.document.uri.fsPath)
    ? P.hooksTarget(path.relative(cwd, ed.document.uri.fsPath))
    : null;
  const input = target ? (cfg().get('driver', 'alone.tex') || 'alone.tex') : mainFile;
  if (!fs.existsSync(path.join(cwd, input))) {
    vscode.window.showWarningMessage('Не знайдено ' + input + ' у корені проєкту (налаштування tssworkflow.' + (target ? 'driver' : 'mainFile') + ').');
    return;
  }
  const what = target ? 'розділ «' + target.chapter + '»' + (target.tikz ? ', рисунок «' + target.tikz + '»' : '') + ' через ' + input : 'весь документ (' + input + ')';
  const jobname = path.basename(input, path.extname(input)) + '-hooks';
  const names = ['shipout/before', 'shipout/foreground', 'shipout/background', 'shipout/after', 'shipout/lastpage'];
  const inject = P.hooksInject(names, target, input);
  const exe = cfg().get('lualatex', 'lualatex');
  outLog.appendLine('[hooks] ' + what + ': ' + exe + ' -jobname=' + jobname + ' (зупиняється на початку документа)');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TSS: читаю хуки виводу сторінки…' }, () =>
    new Promise((resolve) => {
      cp.execFile(exe, ['-interaction=nonstopmode', '-file-line-error', '-shell-escape', '-jobname=' + jobname, inject],
        { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 180000, env: Object.assign({}, process.env, { max_print_line: '10000' }) }, (err) => {
          let log = '';
          try { log = fs.readFileSync(path.join(cwd, jobname + '.log'), 'utf8'); } catch (e) { /* no log */ }
          for (const f of fs.readdirSync(cwd)) {
            if (f.startsWith(jobname + '.')) { try { fs.unlinkSync(path.join(cwd, f)); } catch (e) { /* ignore */ } }
          }
          const hooks = P.parseShowHooks(log);
          if (!hooks.length) {
            // say what the log really shows instead of guessing
            const d = P.diagnoseHooksLog(log);
            let why;
            if (err && err.code === 'ENOENT') why = ': не запустився ' + exe;
            else if (err && err.killed) why = ': збірка перервана через 180 с';
            else if (d.empty) why = ': LaTeX не створив логу (дивись вивід TSS Workflow)';
            else if (d.old) why = ': LaTeX від ' + d.date + ' надто старий, хуки є від 2021 року';
            else if (d.error) why = ': збірка зупинилась до початку документа (' + d.error + ')';
            else why = ' (LaTeX' + (d.date ? ' від ' + d.date : '') + '; дивись вивід TSS Workflow)';
            vscode.window.showWarningMessage('Хуки не знайдено' + why + '. Запускалось: ' + what + '.');
            if (log) outLog.appendLine(log.slice(-3000));
            resolve();
            return;
          }
          const head = 'Код, який пакети додали в хуки виводу сторінки (LaTeX \\ShowHook, зупинка на початку документа).\n' +
            'Що запускалось: ' + what + '.\n' +
            'Підозрюй те, що малює чи друкує під час виводу: eso-pic, background, draftwatermark, tikzpagenodes, zref, tcolorbox (remember picture) тощо.\n' +
            'Хуки, які пакети додають пізніше, ніж у \\begin{document}, тут не видно.\n\n';
          const text = head + hooks.map((h) => '=== ' + h.hook + ' ===\n' + h.text).join('\n\n') + '\n';
          vscode.workspace.openTextDocument({ content: text, language: 'plaintext' }).then((doc) => vscode.window.showTextDocument(doc, { preview: false }));
          resolve();
        });
    }));
}

module.exports = { register, onBuildFinished, frameSettings, applyWithPreview, _t: { imageHoverMd, wrapParagraph, typographyCmd, sentencesCmd, tableOps, convertEnv, refCompletion, renameProvider } };
