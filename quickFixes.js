'use strict';
/* quickFixes.js: quick fixes, the outline. */
const vscode = require('vscode');
const path = require('path');
const P = require('./corePure');
const { tr } = require('./i18n');
const { PIC_EXTS, baseOf, cfg, docLines, listFiles } = require('./util');
const { buildIndex, renameProvider } = require('./labels');
const { bibKeys } = require('./settingsCitations');

/* ------------------------------ quick fixes -------------------------- */
const QF = vscode.CodeActionKind.QuickFix;

function mkFix(title, d, edit) {
  const a = new vscode.CodeAction(title, QF);
  a.diagnostics = [d];
  a.edit = edit;
  return a;
}

// all label names of the project (cached index)
async function allLabelNames() {
  const names = new Set();
  for (const data of (await buildIndex(false)).values()) data.labels.forEach((l) => names.add(l.name));
  return names;
}

// last line of the block of non-blank lines that starts at `line`
function blockEndLine(doc, line) {
  let e = line;
  while (e + 1 < doc.lineCount && doc.lineAt(e + 1).text.trim() !== '') e++;
  return e;
}

const quickFixes = {
  async provideCodeActions(doc, range, ctx) {
    const out = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== 'TSS Workflow') continue;
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      const uri = doc.uri;
      const replaceWith = (title, text) => {
        const we = new vscode.WorkspaceEdit();
        we.replace(uri, d.range, text);
        out.push(mkFix(title, d, we));
      };
      if (code === 'missing-backslash') {
        const we = new vscode.WorkspaceEdit();
        we.insert(uri, d.range.start, '\\');
        out.push(mkFix(tr('Додати «\\»'), d, we));
      } else if (code === 'blank-in-math') {
        const ln = d.range.start.line;
        const del = new vscode.WorkspaceEdit();
        if (ln + 1 < doc.lineCount) del.delete(uri, new vscode.Range(ln, 0, ln + 1, 0));
        else del.delete(uri, new vscode.Range(ln, 0, ln, doc.lineAt(ln).text.length));
        out.push(mkFix(tr('Видалити порожній рядок'), d, del));
        const com = new vscode.WorkspaceEdit();
        com.replace(uri, new vscode.Range(ln, 0, ln, doc.lineAt(ln).text.length), '%');
        out.push(mkFix(tr('Замінити порожній рядок на «%»'), d, com));
      } else if (code === 'end-mismatch') {
        const m = /\\begin\{([^}]*)\}/.exec(d.message);
        if (m) replaceWith(tr('Замінити на \\end{{0}}', m[1]), '\\end{' + m[1] + '}');
      } else if (code === 'missing-end') {
        const m = /\\end\{([^}]*)\}/.exec(d.message);
        if (m) {
          const ln = d.range.start.line;
          const last = blockEndLine(doc, ln);
          const indent = /^\s*/.exec(doc.lineAt(ln).text)[0];
          const we = new vscode.WorkspaceEdit();
          we.insert(uri, new vscode.Position(last, doc.lineAt(last).text.length), '\n' + indent + '\\end{' + m[1] + '}');
          out.push(mkFix(tr('Додати \\end{{0}} після цього блоку (до порожнього рядка)', m[1]), d, we));
        }
      } else if (code === 'file-missing-tikz' || code === 'file-missing-pic') {
        const isTikz = code === 'file-missing-tikz';
        const name = doc.getText(d.range).trim();
        const dir = path.join(path.dirname(uri.fsPath), isTikz ? 'tikz' : 'Pictures');
        const names = [];
        for (const rel of listFiles(dir, isTikz ? ['.tikz', '.tex'] : PIC_EXTS, 3)) {
          names.push(isTikz ? rel : rel.slice(0, rel.length - path.extname(rel).length));
        }
        for (const s of P.suggest(name, names, 3)) replaceWith(tr('Замінити на «{0}»', s), s);
      } else if (code === 'label-undefined') {
        const name = doc.getText(d.range).trim();
        for (const s of P.suggest(name, [...(await allLabelNames())], 3)) replaceWith(tr('Замінити на «{0}»', s), s);
      } else if (code === 'cite-undefined') {
        const name = doc.getText(d.range).trim();
        for (const s of P.suggest(name, bibKeys(), 3)) replaceWith(tr('Замінити на «{0}»', s), s);
      } else if (code === 'figure-no-caption' || code === 'figure-no-label') {
        // the name of the environment is read from the file (the token \begin{name} under the diagnostic), not from the message, which depends on the language
        const nm = /\\begin\{([^}]*)\}/.exec(doc.lineAt(d.range.start.line).text.slice(d.range.start.character));
        const lines = docLines(doc);
        const end = nm && P.envEnd(lines, nm[1], d.range.start.line, d.range.end.character);
        if (end) {
          const endTok = '\\end{' + nm[1] + '}';
          const endCol = end.col - endTok.length;
          const before = lines[end.line].slice(0, Math.max(0, endCol));
          if (endCol >= 0 && before.trim() === '') {
            const isCap = code === 'figure-no-caption';
            const prefix = (cfg().get('labelPrefixes', {}) || {})[nm[1].replace(/\*$/, '')] || (/figure/.test(nm[1]) ? 'pic:' : '');
            const text = before + (isCap ? '\\caption{}' : '\\label{' + prefix + '}') + '\n';
            const we = new vscode.WorkspaceEdit();
            we.insert(uri, new vscode.Position(end.line, 0), text);
            out.push(mkFix(isCap ? tr('Додати \\caption{} перед {0}', endTok) : tr('Додати \\label{{0}} перед {1}', prefix, endTok), d, we));
          }
        }
      } else if (code === 'label-prefix') {
        // the prefix is found again from the file and the setting, not from the text of the message, which depends on the language
        const here = P.scanLabelsAndRefs(doc.getText(), baseOf(uri.fsPath)).labels.find((x) => x.line === d.range.start.line && x.col === d.range.start.character);
        const rule = here && P.labelPrefixRule(here, cfg().get('labelPrefixes', {}));
        const m = rule && rule.pre ? [null, rule.pre] : null;
        if (m && m[1]) {
          const newName = m[1] + doc.getText(d.range).trim();
          if (!(await allLabelNames()).has(newName)) {
            try {
              const we = await renameProvider.provideRenameEdits(doc, d.range.start, newName);
              if (we) out.push(mkFix(tr('Перейменувати мітку на «{0}» у всьому проєкті', newName), d, we));
            } catch (e) { /* e.g. a label defined by a macro: no fix */ }
          }
        }
      }
    }
    return out;
  }
};

/* ------------------------------- outline ----------------------------- */
const symbolProvider = {
  provideDocumentSymbols(doc) {
    const lines = docLines(doc);
    const kindOf = (lvl) =>
      lvl <= 1 ? vscode.SymbolKind.Module : lvl === 2 ? vscode.SymbolKind.Class : lvl === 3 ? vscode.SymbolKind.Method : vscode.SymbolKind.Field;
    const conv = (n) => {
      const range = new vscode.Range(n.line, 0, n.endLine, lines[n.endLine].length);
      const sel = new vscode.Range(n.line, 0, n.line, lines[n.line].length);
      const sym = new vscode.DocumentSymbol(n.title, n.kind + (n.star ? '*' : ''), kindOf(n.level), range, sel);
      sym.children = n.children.map(conv);
      return sym;
    };
    return P.outlineTree(lines).map(conv);
  }
};

module.exports = {
  QF,
  quickFixes,
  symbolProvider,
};
