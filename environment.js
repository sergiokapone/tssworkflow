'use strict';
/* TSS Workflow 0.4.3: "Check environment" - which programs, extensions and files the settings need and whether they
 * are found. The report (Markdown) opens in an editor tab. */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./pure');

const cfg = () => vscode.workspace.getConfiguration('tssworkflow');

// first line of `<program> --version`, '' if it does not answer in 4 s
function versionOf(file) {
  return new Promise((resolve) => {
    const shell = /\.(cmd|bat)$/i.test(file);
    try {
      execFile(shell ? '"' + file + '"' : file, ['--version'], { timeout: 4000, windowsHide: true, shell }, (err, out, errOut) => {
        const text = String(out || errOut || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
        resolve(err && !text ? '' : text.slice(0, 90));
      });
    } catch (e) { resolve(''); }
  });
}

async function checkEnvironment() {
  const logParser = String(cfg().get('logParser', 'builtin'));
  const pdfViewer = String(cfg().get('pdfViewer', 'vscode'));
  const tools = [
    { name: 'latexmk', hint: 'Встанови TeX Live (або MiKTeX) і додай теку `bin` у PATH; `tlmgr install latexmk`',  cmd: cfg().get('latexmk', 'latexmk'), what: 'збірка всього документа й розділів (`singlePass = false`)', need: true, ver: true },
    { name: 'lualatex', hint: 'Входить у TeX Live; додай теку `bin` у PATH або вкажи шлях у `tssworkflow.lualatex`',  cmd: cfg().get('lualatex', 'lualatex'), what: 'збірка розділу одним проходом, `Show page output hooks`', need: true, ver: true },
    { name: 'texlogsieve', hint: '`tlmgr install texlogsieve` (TeX Live 2022+), або `tssworkflow.logParser = builtin`',  cmd: cfg().get('texlogsieveCommand', 'texlogsieve'), what: 'звіт про проблеми збірки (`logParser = texlogsieve`)', need: logParser === 'texlogsieve', ver: true },
    { name: 'pplatex', hint: 'Потрібен лише для `logParser = pplatex`: `tlmgr install pplatex`',  cmd: cfg().get('pplatexCommand', 'ppluatex'), what: 'розбір логу (`logParser = pplatex`)', need: logParser === 'pplatex', ver: false },
    { name: 'biber', hint: '`tlmgr install biber`; потрібен для biblatex',  cmd: 'biber', what: 'бібліографія biblatex (повна збірка)', need: false, ver: true },
    { name: 'latexdiff', hint: '`tlmgr install latexdiff`',  cmd: cfg().get('latexdiffCommand', 'latexdiff'), what: 'команда `Changes of this chapter since a git revision`', need: false, ver: true },
    { name: 'git', hint: 'https://git-scm.com/downloads (Windows: `winget install Git.Git`)',  cmd: 'git', what: 'latexdiff проти ревізії git', need: false, ver: true },
    { name: 'PDF-вьюер', hint: 'Windows: `winget install SumatraPDF.SumatraPDF`, потім додай у PATH чи задай `tssworkflow.externalViewerCommand`',  cmd: cfg().get('externalViewerCommand', 'SumatraPDF'), what: 'кнопка `link-external` і SyncTeX (`pdfViewer = external`)', need: pdfViewer === 'external', ver: false }
  ];
  const rows = await Promise.all(tools.map(async (t) => {
    const found = P.findInPath(String(t.cmd || ''));
    if (!found) return { name: t.name + ' (`' + t.cmd + '`)', what: t.what, state: t.need ? 'missing' : 'optional', detail: 'не знайдено в PATH', hint: t.hint };
    const v = t.ver ? await versionOf(found) : '';
    return { name: t.name, what: t.what, state: 'ok', detail: '`' + found + '`' + (v ? '<br>' + v.replace(/\|/g, '/') : '') };
  }));

  const ext = (id, name, what, need) => {
    const e = vscode.extensions.getExtension(id);
    rows.push({ name, what, state: e ? 'ok' : (need ? 'missing' : 'optional'), detail: e ? 'версія ' + ((e.packageJSON && e.packageJSON.version) || '?') : 'не встановлено', hint: e ? '' : 'Розширення `' + id + '`: Extensions → Install' });
  };
  ext('James-Yu.latex-workshop', 'LaTeX Workshop', 'вкладка з PDF, SyncTeX, превʼю формул', pdfViewer === 'vscode' || pdfViewer === 'latexworkshop');
  ext('valentjn.vscode-ltex', 'LTeX', 'орфографія й граматика (`Add LTeX spelling hits to the dictionary`)', false);

  const folder = (vscode.workspace.workspaceFolders || [])[0];
  // 0.7.0: files the last build could not find
  try {
    const mf = require('./extra5').missingFromLog();
    if (mf.log) {
      const X5 = require('./extra5Pure');
      const cmds = X5.tlmgrCommands(mf.missing, String(cfg().get('tlmgrCommand', 'tlmgr install')));
      rows.push({ name: 'Пакети з останнього логу', what: 'рядки `File ... not found` у `' + path.basename(mf.log) + '`', state: mf.missing.length ? 'missing' : 'ok', detail: mf.missing.length ? mf.missing.map((m) => m.file).join(', ') : 'усе знайдено', hint: mf.missing.length ? (cmds.install ? '`' + cmds.install + '`; ' : '') + 'або `TSS Workflow: Missing packages from last log`' : '' });
    }
  } catch (e) { /* optional */ }
  if (folder) {
    const root = folder.uri.fsPath;
    const main = String(cfg().get('mainFile', 'main.tex'));
    const has = (f) => { try { return fs.existsSync(path.join(root, f)); } catch (e) { return false; } };
    rows.push({ name: 'Головний файл `' + main + '`', what: '`Shift+F5`, повна збірка', state: has(main) ? 'ok' : 'missing', detail: has(main) ? 'є в корені' : 'немає в корені: зміни `tssworkflow.mainFile`' });
    const drv = String(cfg().get('driver', 'alone.tex'));
    rows.push({ name: 'Драйвер `' + drv + '`', what: 'збірка окремого розділу чи рисунка (▷, `F5`)', state: has(drv) ? 'ok' : 'optional', detail: has(drv) ? 'є в корені' : 'немає: розділи окремо не збираються' });
    rows.push({ name: '`.vscode/settings.json`', what: 'налаштування проєкту (`Create .vscode/settings.json`)', state: has(path.join('.vscode', 'settings.json')) ? 'ok' : 'optional', detail: has(path.join('.vscode', 'settings.json')) ? 'є' : 'немає' });
  }

  const content = P.formatEnvReport(rows, { folder: folder ? folder.uri.fsPath : '' });
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.window.showTextDocument(doc, { preview: true });
  const bad = rows.filter((r) => r.state === 'missing').length;
  vscode.window.setStatusBarMessage(bad ? 'Бракує потрібного: ' + bad : 'Середовище в порядку', 4000);
  // 0.11: the install commands of the missing things in one click
  const cmds = [];
  for (const r of rows) {
    if (r.state === 'ok' || !r.hint) continue;
    const re = /`((?:sudo )?(?:tlmgr|winget|brew|apt(?:-get)?|mpm)[^`]*)`/g;
    let m;
    while ((m = re.exec(r.hint)) !== null) if (!cmds.includes(m[1])) cmds.push(m[1]);
  }
  if (cmds.length) {
    const pick = await vscode.window.showInformationMessage('Doctor: команд для встановлення відсутнього: ' + cmds.length, 'Скопіювати команди', 'Показати в терміналі');
    if (pick === 'Скопіювати команди') await vscode.env.clipboard.writeText(cmds.join('\n'));
    else if (pick === 'Показати в терміналі') { const t = vscode.window.createTerminal('TSS: install'); t.show(); t.sendText(cmds.join('\n'), false); }
  }
}

// a short silent check when a project is opened: only latexmk and lualatex, once, and it can be muted
async function startupCheck(context) {
  if (!cfg().get('doctorOnStartup', true) || context.globalState.get('tss.doctorMuted')) return;
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) return;
  const main = String(cfg().get('mainFile', 'main.tex'));
  try { if (!fs.existsSync(path.join(folder.uri.fsPath, main))) return; } catch (e) { return; }
  const miss = [['latexmk', cfg().get('latexmk', 'latexmk')], ['lualatex', cfg().get('lualatex', 'lualatex')]].filter(([n, c]) => !P.findInPath(String(c || n)));
  if (!miss.length) return;
  const pick = await vscode.window.showWarningMessage('TSS Workflow: у PATH немає ' + miss.map((m) => m[0]).join(', ') + ': збірка не запуститься.', 'Doctor', 'Не нагадувати');
  if (pick === 'Doctor') vscode.commands.executeCommand('tssworkflow.checkEnvironment');
  else if (pick === 'Не нагадувати') context.globalState.update('tss.doctorMuted', true);
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.checkEnvironment', checkEnvironment));
  setTimeout(() => startupCheck(context).catch(() => {}), 8000);
}

exports.register = register;
