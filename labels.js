'use strict';
/* labels.js: project-wide labels: completion, rename, checks. */
const vscode = require('vscode');
const { tr } = require('./i18n');
const path = require('path');
const P = require('./corePure');
const { REF_CTX, baseOf, cfg, info, texFiles, textOf } = require('./util');
const PI = require('./projectIndex');

/* ------------------------------- labels ------------------------------ */
// Map fsPath -> { labels, refs } of every .tex/.tikz file. The scan of a file is cached until the file changes (the version
// of an open document, the mtime of a closed file), so unsaved edits count at once and nothing is rescanned in vain.
async function buildIndex() {
  const files = await texFiles();
  return PI.mapOver('labels', files, (text, abs) => P.scanLabelsAndRefs(text, baseOf(abs)));
}

const refCompletion = {
  async provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const m = REF_CTX.exec(before);
    if (!m) return undefined;
    const typed = m[1].slice(m[1].lastIndexOf(',') + 1);
    const lead = typed.length - typed.trimStart().length;
    const range = new vscode.Range(pos.line, pos.character - typed.length + lead, pos.line, pos.character);
    const idx = await buildIndex();
    // the current document is in the index already (its entry is as fresh as the text); rescan only if it is not a project file
    const here = idx.get(doc.uri.fsPath) || P.scanLabelsAndRefs(doc.getText(), baseOf(doc.uri.fsPath));
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
    if (!hit) throw new Error(tr('Постав курсор на назву мітки (\\label або \\ref).'));
    return { range: new vscode.Range(pos.line, hit.col, pos.line, hit.col + hit.len), placeholder: hit.name };
  },
  async provideRenameEdits(doc, pos, newName) {
    const hit = P.labelAtPos(doc.lineAt(pos.line).text, pos.character);
    if (!hit) return undefined;
    if (!/^[^\s{},%\\]+$/.test(newName)) throw new Error(tr('Назва мітки не може містити пробіли, {}, кому, % або \\.'));
    const idx0 = await buildIndex();
    for (const data of idx0.values()) {
      if (data.labels.some((l) => l.macro && l.name === hit.name)) throw new Error(tr('Ця мітка задана макросом \\currfilebase: перейменуй файл, а не мітку.'));
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
    return edit;
  }
};

const diagLabels = vscode.languages.createDiagnosticCollection('tssworkflow-labels');
const labelDiags = PI.diagSetter(diagLabels);

async function checkLabels(showMessage) {
  const idx = await buildIndex();
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
  // plain entries: the Diagnostic objects are made only for the files whose set of problems changed (PI.diagSetter)
  const add = (file, l, message, sev, code) => {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ line: l.line, col: l.col, len: l.len, message, severity: sev, code });
  };
  let dup = 0;
  let undef = 0;
  let unused = 0;
  let badPrefix = 0;
  for (const [name, arr] of defs) {
    if (arr.length > 1) {
      dup++;
      arr.forEach((x) => add(x.file, x.l, tr('Мітка «{0}» визначена {1} разів', name, arr.length), vscode.DiagnosticSeverity.Error, 'label-duplicate'));
    }
  }
  for (const [file, data] of idx) {
    for (const r of data.refs) {
      if (!defs.has(r.name)) {
        undef++;
        add(file, r, tr('Мітку «{0}» не знайдено в проєкті', r.name), vscode.DiagnosticSeverity.Warning, 'label-undefined');
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
        add(file, l, tr('Мітка «{0}» ніде не використана', l.name), sevMap[sevName], 'label-unused');
      }
      for (let i = l.envs.length - 1; i >= 0; i--) {
        const pre = prefixes[l.envs[i]];
        if (typeof pre !== 'string') continue;
        if (pre && !l.name.startsWith(pre)) {
          badPrefix++;
          add(file, l, tr('Мітка в «{0}» має починатися з «{1}»', l.envs[i], pre), vscode.DiagnosticSeverity.Warning, 'label-prefix');
        }
        break;
      }
    }
  }
  labelDiags.set(byFile);
  if (showMessage) {
    info(tr('Мітки: дублікатів {0}, невизначених посилань {1}, без використання {2}, з неправильним префіксом {3} (див. Problems).', dup, undef, unused, badPrefix));
  }
}

module.exports = {
  buildIndex,
  checkLabels,
  diagLabels,
  refCompletion,
  renameProvider,
};
