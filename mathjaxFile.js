'use strict';
/* mathjaxFile.js: the macros file for the formula preview of LaTeX Workshop (mathjax-macros.tex, tssworkflow.mathjaxMacrosFile,
 * or the file in latex-workshop.hover.preview.newcommand.newcommandFile) as macros for KaTeX. They are added to the macros
 * taken from the .cls/.sty files (a definition in the file wins), so a command is known in the panel "Preview selection"
 * and in the table editor when it is known to the LaTeX Workshop preview. */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const MP = require('./macrosPure');
const { cfg } = require('./util');

// existing macro files for the project of this document
function files(doc) {
  const out = [];
  try {
    const ws = vscode.workspace;
    const folder = (doc && doc.uri && ws.getWorkspaceFolder && ws.getWorkspaceFolder(doc.uri)) || (ws.workspaceFolders || [])[0];
    if (!folder) return out;
    const root = folder.uri.fsPath;
    const mainDir = path.dirname(path.resolve(root, String(cfg().get('mainFile', 'main.tex') || 'main.tex')));
    const rels = [String(cfg().get('mathjaxMacrosFile', 'mathjax-macros.tex') || 'mathjax-macros.tex')];
    try {
      const lw = ws.getConfiguration('latex-workshop', folder.uri).get('hover.preview.newcommand.newcommandFile', '');
      if (lw && typeof lw === 'string') rels.push(lw);
    } catch (e) { /* no LaTeX Workshop settings */ }
    for (const rel of rels) {
      const cand = path.isAbsolute(rel) ? [rel] : [path.resolve(mainDir, rel), path.resolve(root, rel)];
      const hit = cand.find((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
      if (hit && !out.includes(hit)) out.push(hit);
    }
  } catch (e) { /* none */ }
  return out;
}

// changes when a macro file appears, disappears or is saved (the cache of the macros compares it)
function stamp(doc) {
  return files(doc).map((f) => { try { return f + ':' + Math.floor(fs.statSync(f).mtimeMs); } catch (e) { return f; } }).join('|');
}

// the KaTeX macros of the files (the later file wins)
function macros(doc) {
  const out = {};
  for (const f of files(doc)) {
    try { Object.assign(out, MP.parseKatexMacros(fs.readFileSync(f, 'utf8'))); } catch (e) { /* unreadable: skipped */ }
  }
  return out;
}

// the same files as definitions of commands for the TEXT of the panel (a copy \let, \newcommand with a body): name -> entry of
// macrosPure.scanMacros; the later file wins. A command that only the formula preview knew was drawn as unknown in a text.
function textMacros(doc) {
  const out = new Map();
  for (const f of files(doc)) {
    try { for (const e of MP.scanMacros(fs.readFileSync(f, 'utf8'))) if (e.kind === 'cmd') out.set(e.name, Object.assign(e, { file: f })); } catch (e) { /* unreadable: skipped */ }
  }
  return out;
}

// the commands of the files whose first argument is optional (macrosPure.parseKatexOptMacros); a plain definition of the
// same name in a later file wins, as it does in the formula preview
function optMacros(doc) {
  const out = {};
  for (const f of files(doc)) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const k of Object.keys(MP.parseKatexMacros(text))) delete out[k];
    Object.assign(out, MP.parseKatexOptMacros(text));
  }
  return out;
}

module.exports = { files, stamp, macros, optMacros, textMacros };
