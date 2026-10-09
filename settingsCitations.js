'use strict';
/* settingsCitations.js: project .vscode/settings.json, citations (.bib keys), the LTeX dictionary. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./corePure');
const { EXCLUDE, cfg, info, texFiles, textOf } = require('./util');
const { SEV } = require('./checksHovers');

/* ------------------- project .vscode/settings.json -------------------- */
// Creates .vscode/settings.json from the template (P.PROJECT_SETTINGS_TEMPLATE or the file in tssworkflow.projectSettingsTemplate);
// if the file exists, only the missing top-level keys are added. `arg` may be the folder path (from the prompt on opening).
async function initProjectSettings(arg) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) { info('Відкрий папку проєкту: .vscode/settings.json створюється в робочій папці.'); return; }
  let folder = typeof arg === 'string' ? folders.find((f) => f.uri.fsPath === arg) : undefined;
  if (!folder && folders.length === 1) folder = folders[0];
  if (!folder) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: 'У якій папці створити .vscode/settings.json?' }
    );
    if (!pick) return;
    folder = pick.folder;
  }
  const file = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
  if (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file && d.isDirty)) {
    vscode.window.showWarningMessage('.vscode/settings.json має незбережені зміни. Збережи або закрий його і повтори.');
    return;
  }
  const exists = fs.existsSync(file);
  const existing = exists ? fs.readFileSync(file, 'utf8') : '';
  let tpl = null;
  const tplPath = String(cfg().get('projectSettingsTemplate', '') || '').trim();
  if (tplPath) {
    // the user's own template: used as it is
    try {
      tpl = JSON.parse(P.dropTrailingCommas(P.stripJsonc(fs.readFileSync(tplPath, 'utf8').replace(/^\uFEFF/, ''))));
      if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw new Error('шаблон має бути JSON-об\'єктом');
    } catch (err) {
      vscode.window.showWarningMessage('Не вдалося прочитати шаблон «' + tplPath + '»: ' + (err && err.message ? err.message : err));
      return;
    }
  } else {
    // built-in template: main file = the only .tex of the root, else main.tex, else ask
    const cur = P.parseSettings(existing) || {};
    let mainFile = typeof cur['tssworkflow.mainFile'] === 'string' && cur['tssworkflow.mainFile'] ? cur['tssworkflow.mainFile'] : null;
    if (!mainFile) {
      let names = [];
      try { names = fs.readdirSync(folder.uri.fsPath); } catch (e) { names = []; }
      const r = P.pickMainTex(names, cfg().get('driver', 'alone.tex'));
      if (r.choose) {
        const pick = await vscode.window.showQuickPick(
          r.choose.map((n) => ({ label: n })),
          { placeHolder: 'У папці кілька .tex і немає main.tex. Який файл головний (mainFile)?' }
        );
        if (!pick) return;
        mainFile = pick.label;
      } else {
        mainFile = r.file;
      }
    }
    // .sty/.cls in subfolders (the ones in the root are found through the preamble of the main file)
    let macroFiles = [];
    try {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{sty,cls}'), EXCLUDE, 60);
      macroFiles = found.map((u) => path.relative(folder.uri.fsPath, u.fsPath).split(path.sep).join('/'))
        .filter((p) => p.includes('/')).sort().slice(0, 10);
    } catch (e) { macroFiles = []; }
    tpl = P.buildProjectSettings({
      mainFile,
      macroFiles,
      texlogsieve: !!P.findInPath(String(cfg().get('texlogsieveCommand', 'texlogsieve') || 'texlogsieve'))
    });
  }
  const res = P.mergeMissingSettings(existing, tpl, tplPath ? null : P.PROJECT_SETTINGS_COMMENTS);
  if (res.error) { vscode.window.showWarningMessage('.vscode/settings.json: ' + res.error + '. Файл не змінено.'); return; }
  if (exists && !res.added.length) {
    info('У .vscode/settings.json уже є всі ключі шаблону.');
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return;
  }
  if (exists) {
    const ok = await vscode.window.showInformationMessage(
      'У .vscode/settings.json немає ' + res.added.length + ' ключів шаблону: ' + res.added.slice(0, 4).join(', ') + (res.added.length > 4 ? ', …' : '') + '. Додати їх? Наявні ключі й коментарі не чіпаються.',
      'Додати', 'Скасувати'
    );
    if (ok !== 'Додати') return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, res.text, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  info((exists ? 'Додано ключів: ' : 'Створено .vscode/settings.json, ключів: ') + res.added.length + '.');
}

/* ------------------------------ citations ---------------------------- */
const diagCites = vscode.languages.createDiagnosticCollection('tssworkflow-cites');
let bibKeyCache = [];
const bibKeys = () => bibKeyCache; // for other modules

// \cite keys against the .bib files of the workspace: undefined keys (in .tex), duplicate and unused entries (in .bib)
async function checkCitations(showMessage) {
  diagCites.clear();
  if (!cfg().get('citationChecks', true)) return;
  const bibs = await vscode.workspace.findFiles('**/*.bib', EXCLUDE, 200);
  if (!bibs.length) {
    if (showMessage) info('У проєкті немає .bib файлів: перевіряти нічого.');
    return;
  }
  const keys = new Map();
  for (const f of bibs) {
    for (const k of P.parseBibKeys(textOf(f))) {
      if (!keys.has(k.name)) keys.set(k.name, []);
      keys.get(k.name).push({ file: f.fsPath, k });
    }
  }
  bibKeyCache = [...keys.keys()];
  const byFile = new Map();
  const add = (file, x, message, sev, code) => {
    if (!byFile.has(file)) byFile.set(file, []);
    const d = new vscode.Diagnostic(new vscode.Range(x.line, x.col, x.line, x.col + x.len), message, sev);
    d.source = 'TSS Workflow';
    d.code = code;
    byFile.get(file).push(d);
  };
  const used = new Set();
  let nociteAll = false;
  let undef = 0;
  let dup = 0;
  let unused = 0;
  for (const f of await texFiles()) {
    const r = P.scanCites(textOf(f));
    if (r.nociteAll) nociteAll = true;
    for (const c of r.cites) {
      used.add(c.name);
      if (!keys.has(c.name)) {
        undef++;
        add(f.fsPath, c, 'Ключа «' + c.name + '» немає в .bib файлах проєкту', vscode.DiagnosticSeverity.Warning, 'cite-undefined');
      }
    }
  }
  for (const [name, arr] of keys) {
    if (arr.length > 1) {
      dup++;
      arr.forEach((x) => add(x.file, x.k, 'Ключ «' + name + '» у .bib визначений ' + arr.length + ' разів', vscode.DiagnosticSeverity.Warning, 'bib-duplicate'));
    }
  }
  const sevName = cfg().get('unusedBibEntries', 'hint');
  if (SEV[sevName] !== undefined && sevName !== 'error' && !nociteAll) {
    for (const [name, arr] of keys) {
      if (used.has(name)) continue;
      unused++;
      add(arr[0].file, arr[0].k, 'Запис «' + name + '» ніде не цитується', SEV[sevName], 'bib-unused');
    }
  }
  for (const [file, ds] of byFile) diagCites.set(vscode.Uri.file(file), ds);
  if (showMessage) {
    info('Цитування: невизначених ключів ' + undef + ', дублікатів у .bib ' + dup + ', нецитованих записів ' + unused +
      (nociteAll ? ' (є \\nocite{*}: нецитовані не рахуються)' : '') + ' (див. Problems).');
  }
}

/* ------------------------- LTeX: project dictionary ------------------- */
// Collects the spelling hits of the LTeX extension (it checks only the files that are open), lets the user pick
// words and adds them to the user setting ltex.dictionary for the language of ltex.language.
async function ltexDictionary() {
  const counts = new Map();
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      if (!/ltex/i.test(String(d.source || ''))) continue;
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      const isSpell = /MORFOLOGIK|HUNSPELL|SPELL/i.test(String(code || '')) || /spell|орфограф|правопис/i.test(d.message);
      if (!isSpell) continue;
      const doc = vscode.workspace.textDocuments.find((x) => x.uri.toString() === uri.toString());
      const word = (doc ? doc.getText(d.range) : textOf(uri).split(/\r?\n/)[d.range.start.line].slice(d.range.start.character, d.range.end.character)).trim();
      if (word && !/\s/.test(word)) counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  if (!counts.size) {
    info('Орфографічних діагностик LTeX немає. LTeX перевіряє лише відкриті файли: відкрий потрібні розділи й зачекай кінця перевірки.');
    return;
  }
  const lang = String(vscode.workspace.getConfiguration('ltex').get('language', 'en-US'));
  if (lang === 'auto') { info('Для ltex.language = "auto" невідомо, до якої мови додавати слова. Вкажи конкретну мову, напр. uk-UA.'); return; }
  const items = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 300)
    .map(([w, n]) => ({ label: w, description: '×' + n }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Слова для ltex.dictionary (' + lang + ')', placeHolder: 'Познач слова, які треба вважати правильними' });
  if (!picked || !picked.length) return;
  const conf = vscode.workspace.getConfiguration('ltex');
  const cur = conf.inspect('dictionary');
  const next = Object.assign({}, (cur && cur.globalValue) || {});
  next[lang] = [...new Set([...(next[lang] || []), ...picked.map((p) => p.label)])];
  await conf.update('dictionary', next, vscode.ConfigurationTarget.Global);
  info('До ltex.dictionary (' + lang + ', User settings) додано слів: ' + picked.length + '. LTeX може перевірити файли заново з затримкою.');
}

module.exports = {
  bibKeys,
  checkCitations,
  diagCites,
  initProjectSettings,
  ltexDictionary,
};
