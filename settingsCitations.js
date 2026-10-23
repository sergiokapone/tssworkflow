'use strict';
/* settingsCitations.js: project .vscode/settings.json, citations (.bib keys), the LTeX dictionary. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./corePure');
const { excludeNow, cfg, findCached, info, openDocByPath, texFiles, textOf } = require('./util');
const { SEV } = require('./checksHovers');
const PI = require('./projectIndex');
const { tr } = require('./i18n');

/* ------------------- project .vscode/settings.json -------------------- */
// Creates .vscode/settings.json from the template (P.PROJECT_SETTINGS_TEMPLATE or the file in tssworkflow.projectSettingsTemplate);
// if the file exists, only the missing top-level keys are added. `arg` may be the folder path (from the prompt on opening).
async function initProjectSettings(arg) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) { info(tr('Відкрий папку проєкту: .vscode/settings.json створюється в робочій папці.')); return; }
  let folder = typeof arg === 'string' ? folders.find((f) => f.uri.fsPath === arg) : undefined;
  if (!folder && folders.length === 1) folder = folders[0];
  if (!folder) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: tr('У якій папці створити .vscode/settings.json?') }
    );
    if (!pick) return;
    folder = pick.folder;
  }
  const file = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
  if (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file && d.isDirty)) {
    vscode.window.showWarningMessage(tr('.vscode/settings.json має незбережені зміни. Збережи або закрий його і повтори.'));
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
      if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw new Error(tr('шаблон має бути JSON-об\'єктом'));
    } catch (err) {
      vscode.window.showWarningMessage(tr('Не вдалося прочитати шаблон «{0}»: {1}', tplPath, err && err.message ? err.message : err));
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
          { placeHolder: tr('У папці кілька .tex і немає main.tex. Який файл головний (mainFile)?') }
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
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{sty,cls}'), excludeNow(), 60);
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
  if (res.error) { vscode.window.showWarningMessage(tr('.vscode/settings.json: {0}. Файл не змінено.', res.error)); return; }
  if (exists && !res.added.length) {
    info(tr('У .vscode/settings.json уже є всі ключі шаблону.'));
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return;
  }
  if (exists) {
    const ok = await vscode.window.showInformationMessage(
      tr('У .vscode/settings.json немає {0} ключів шаблону: {1}. Додати їх? Наявні ключі й коментарі не чіпаються.', res.added.length, res.added.slice(0, 4).join(', ') + (res.added.length > 4 ? ', …' : '')),
      tr('Додати'), tr('Скасувати')
    );
    if (ok !== tr('Додати')) return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, res.text, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  info(exists ? tr('Додано ключів: {0}.', res.added.length) : tr('Створено .vscode/settings.json, ключів: {0}.', res.added.length));
}

/* ------------------------------ citations ---------------------------- */
const diagCites = vscode.languages.createDiagnosticCollection('tssworkflow-cites');
const citeDiags = PI.diagSetter(diagCites);
let bibKeyCache = [];
const bibKeys = () => bibKeyCache; // for other modules

// \cite keys against the .bib files of the workspace: undefined keys (in .tex), duplicate and unused entries (in .bib).
// The scan of each file is cached until the file changes; Problems is rewritten only for the files whose diagnostics changed.
async function checkCitations(showMessage) {
  if (!cfg().get('citationChecks', true)) { citeDiags.clear(); return; }
  const bibs = await findCached('**/*.bib', 200);
  if (!bibs.length) {
    citeDiags.clear();
    if (showMessage) info(tr('У проєкті немає .bib файлів: перевіряти нічого.'));
    return;
  }
  const keys = new Map();
  for (const f of bibs) {
    for (const k of PI.get('bibkeys', f.fsPath, (text) => P.parseBibKeys(text))) {
      if (!keys.has(k.name)) keys.set(k.name, []);
      keys.get(k.name).push({ file: f.fsPath, k });
    }
  }
  bibKeyCache = [...keys.keys()];
  const byFile = new Map();
  const add = (file, x, message, sev, code) => {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ line: x.line, col: x.col, len: x.len, message, severity: sev, code });
  };
  const used = new Set();
  let nociteAll = false;
  let undef = 0;
  let dup = 0;
  let unused = 0;
  const texs = await texFiles();
  const scans = PI.mapOver('cites', texs, (text) => P.scanCites(text));
  for (const f of texs) {
    const r = scans.get(f.fsPath);
    if (r.nociteAll) nociteAll = true;
    for (const c of r.cites) {
      used.add(c.name);
      if (!keys.has(c.name)) {
        undef++;
        add(f.fsPath, c, tr('Ключа «{0}» немає в .bib файлах проєкту', c.name), vscode.DiagnosticSeverity.Warning, 'cite-undefined');
      }
    }
  }
  for (const [name, arr] of keys) {
    if (arr.length > 1) {
      dup++;
      arr.forEach((x) => add(x.file, x.k, tr('Ключ «{0}» у .bib визначений {1} разів', name, arr.length), vscode.DiagnosticSeverity.Warning, 'bib-duplicate'));
    }
  }
  const sevName = cfg().get('unusedBibEntries', 'hint');
  if (SEV[sevName] !== undefined && sevName !== 'error' && !nociteAll) {
    for (const [name, arr] of keys) {
      if (used.has(name)) continue;
      unused++;
      add(arr[0].file, arr[0].k, tr('Запис «{0}» ніде не цитується', name), SEV[sevName], 'bib-unused');
    }
  }
  citeDiags.set(byFile);
  if (showMessage) {
    info(tr('Цитування: невизначених ключів {0}, дублікатів у .bib {1}, нецитованих записів {2}', undef, dup, unused) +
      (nociteAll ? tr(' (є \\nocite{*}: нецитовані не рахуються)') : '') + tr(' (див. Problems).'));
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
      // files by the Map of open documents; other schemes (untitled, git:) are not in it and are searched by uri
      const doc = uri.scheme === 'file' ? openDocByPath(uri.fsPath) : vscode.workspace.textDocuments.find((x) => x.uri.toString() === uri.toString());
      const word = (doc ? doc.getText(d.range) : textOf(uri).split(/\r?\n/)[d.range.start.line].slice(d.range.start.character, d.range.end.character)).trim();
      if (word && !/\s/.test(word)) counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  if (!counts.size) {
    info(tr('Орфографічних діагностик LTeX немає. LTeX перевіряє лише відкриті файли: відкрий потрібні розділи й зачекай кінця перевірки.'));
    return;
  }
  const lang = String(vscode.workspace.getConfiguration('ltex').get('language', 'en-US'));
  if (lang === 'auto') { info(tr('Для ltex.language = "auto" невідомо, до якої мови додавати слова. Вкажи конкретну мову, напр. uk-UA.')); return; }
  const items = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 300)
    .map(([w, n]) => ({ label: w, description: '×' + n }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: tr('Слова для ltex.dictionary ({0})', lang), placeHolder: tr('Познач слова, які треба вважати правильними') });
  if (!picked || !picked.length) return;
  const conf = vscode.workspace.getConfiguration('ltex');
  const cur = conf.inspect('dictionary');
  const next = Object.assign({}, (cur && cur.globalValue) || {});
  next[lang] = [...new Set([...(next[lang] || []), ...picked.map((p) => p.label)])];
  await conf.update('dictionary', next, vscode.ConfigurationTarget.Global);
  info(tr('До ltex.dictionary ({0}, User settings) додано слів: {1}. LTeX може перевірити файли заново з затримкою.', lang, picked.length));
}

module.exports = {
  bibKeys,
  checkCitations,
  diagCites,
  initProjectSettings,
  ltexDictionary,
};
