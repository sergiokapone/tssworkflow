'use strict';
/* labels.js: project-wide labels: completion, rename, checks. */
const vscode = require('vscode');
const path = require('path');
const P = require('./corePure');
const { REF_CTX, baseOf, cfg, info, texFiles, textOf } = require('./util');

/* ------------------------------- labels ------------------------------ */
let labelCache = null;
let labelDirty = true;
const markLabelsDirty = () => { labelDirty = true; }; // for other modules: a module-level let cannot be shared

async function buildIndex(force) {
  if (!labelCache || labelDirty || force) {
    const m = new Map();
    for (const f of await texFiles()) m.set(f.fsPath, P.scanLabelsAndRefs(textOf(f), baseOf(f.fsPath)));
    labelCache = m;
    labelDirty = false;
  }
  return labelCache;
}

const refCompletion = {
  async provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const m = REF_CTX.exec(before);
    if (!m) return undefined;
    const typed = m[1].slice(m[1].lastIndexOf(',') + 1);
    const lead = typed.length - typed.trimStart().length;
    const range = new vscode.Range(pos.line, pos.character - typed.length + lead, pos.line, pos.character);
    const idx = await buildIndex(false);
    const here = P.scanLabelsAndRefs(doc.getText(), baseOf(doc.uri.fsPath));
    const items = [];
    const seen = new Set();
    const add = (l, file, rank) => {
      if (seen.has(l.name)) return;
      seen.add(l.name);
      const it = new vscode.CompletionItem(l.name, vscode.CompletionItemKind.Reference);
      it.detail = path.basename(file) + ':' + (l.line + 1);
      it.documentation = l.ctx || '';
      it.range = range;
      it.filterText = l.name;
      it.sortText = rank + '_' + l.name;
      items.push(it);
    };
    here.labels.forEach((l) => add(l, doc.uri.fsPath, '0'));
    for (const [file, data] of idx) {
      if (file === doc.uri.fsPath) continue;
      const near = path.dirname(file) === path.dirname(doc.uri.fsPath) ? '1' : '2';
      data.labels.forEach((l) => add(l, file, near));
    }
    return items;
  }
};

const renameProvider = {
  prepareRename(doc, pos) {
    const hit = P.labelAtPos(doc.lineAt(pos.line).text, pos.character);
    if (!hit) throw new Error('Постав курсор на назву мітки (\\label або \\ref).');
    return { range: new vscode.Range(pos.line, hit.col, pos.line, hit.col + hit.len), placeholder: hit.name };
  },
  async provideRenameEdits(doc, pos, newName) {
    const hit = P.labelAtPos(doc.lineAt(pos.line).text, pos.character);
    if (!hit) return undefined;
    if (!/^[^\s{},%\\]+$/.test(newName)) throw new Error('Назва мітки не може містити пробіли, {}, кому, % або \\.');
    const idx0 = await buildIndex(false);
    for (const data of idx0.values()) {
      if (data.labels.some((l) => l.macro && l.name === hit.name)) throw new Error('Ця мітка задана макросом \\currfilebase: перейменуй файл, а не мітку.');
    }
    const edit = new vscode.WorkspaceEdit();
    const files = await texFiles();
    if (!files.some((f) => f.fsPath === doc.uri.fsPath)) files.push(doc.uri);
    for (const f of files) {
      const text = textOf(f);
      if (!text.includes(hit.name)) continue;
      for (const p of P.renamePositions(text, hit.name)) {
        edit.replace(f, new vscode.Range(p.line, p.col, p.line, p.col + p.len), newName);
      }
    }
    labelDirty = true;
    return edit;
  }
};

const diagLabels = vscode.languages.createDiagnosticCollection('tssworkflow-labels');

async function checkLabels(showMessage) {
  const idx = await buildIndex(true);
  const defs = new Map();
  const used = new Set();
  for (const [file, data] of idx) {
    for (const l of data.labels) {
      if (!defs.has(l.name)) defs.set(l.name, []);
      defs.get(l.name).push({ file, l });
    }
    for (const r of data.refs) used.add(r.name);
  }
  const byFile = new Map();
  const add = (file, l, message, sev, code) => {
    if (!byFile.has(file)) byFile.set(file, []);
    const d = new vscode.Diagnostic(new vscode.Range(l.line, l.col, l.line, l.col + l.len), message, sev);
    d.source = 'TSS Workflow';
    d.code = code;
    byFile.get(file).push(d);
  };
  let dup = 0;
  let undef = 0;
  let unused = 0;
  let badPrefix = 0;
  for (const [name, arr] of defs) {
    if (arr.length > 1) {
      dup++;
      arr.forEach((x) => add(x.file, x.l, 'Мітка «' + name + '» визначена ' + arr.length + ' разів', vscode.DiagnosticSeverity.Error, 'label-duplicate'));
    }
  }
  for (const [file, data] of idx) {
    for (const r of data.refs) {
      if (!defs.has(r.name)) {
        undef++;
        add(file, r, 'Мітку «' + r.name + '» не знайдено в проєкті', vscode.DiagnosticSeverity.Warning, 'label-undefined');
      }
    }
  }
  // labels nobody refers to, and label prefixes by environment
  const sevName = cfg().get('unusedLabels', 'hint');
  const sevMap = { hint: vscode.DiagnosticSeverity.Hint, information: vscode.DiagnosticSeverity.Information, warning: vscode.DiagnosticSeverity.Warning };
  const prefixes = cfg().get('labelPrefixes', {}) || {};
  for (const [file, data] of idx) {
    for (const l of data.labels) {
      if (l.macro) continue;
      if (sevMap[sevName] !== undefined && !used.has(l.name)) {
        unused++;
        add(file, l, 'Мітка «' + l.name + '» ніде не використана', sevMap[sevName], 'label-unused');
      }
      for (let i = l.envs.length - 1; i >= 0; i--) {
        const pre = prefixes[l.envs[i]];
        if (typeof pre !== 'string') continue;
        if (pre && !l.name.startsWith(pre)) {
          badPrefix++;
          add(file, l, 'Мітка в «' + l.envs[i] + '» має починатися з «' + pre + '»', vscode.DiagnosticSeverity.Warning, 'label-prefix');
        }
        break;
      }
    }
  }
  diagLabels.clear();
  for (const [file, ds] of byFile) diagLabels.set(vscode.Uri.file(file), ds);
  if (showMessage) {
    info('Мітки: дублікатів ' + dup + ', невизначених посилань ' + undef + ', без використання ' + unused + ', з неправильним префіксом ' + badPrefix + ' (див. Problems).');
  }
}

module.exports = {
  buildIndex,
  checkLabels,
  diagLabels,
  markLabelsDirty,
  refCompletion,
  renameProvider,
};
