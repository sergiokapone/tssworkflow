'use strict';
/* formulaCopy.js: the command "Copy formula as MathML" (tssworkflow.copyFormula, Ctrl+Alt+C). The formula under the caret (or
 * the selection) is drawn by KaTeX of the extension with the macros of the project and put into the clipboard as MathML (Word
 * and PowerPoint take it as an equation) or as TeX. SVG and PNG are not made: KaTeX draws HTML and fonts, not a picture.
 * The panels of the extension (preview, macro gallery, overview of formulas) copy a formula the same way from the page. */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const FP = require('./formulaCopyPure');
const TE = require('./tableEditor');
const { cfg, isTex, info, warn } = require('./util');

let katex = null;
let optFn = null;

// katex.min.js and mhchem.min.js are the files of the pages; mhchem asks for the module "katex", so it is given the same one
function load(extPath) {
  if (katex) return katex;
  const dir = path.join(extPath, 'media', 'katex');
  const k = require(path.join(dir, 'katex.min.js'));
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === 'katex' ? k : orig.call(this, request, ...rest); };
  try { require(path.join(dir, 'mhchem.min.js')); } catch (e) { /* \ce is then unknown: the formula with it is not copied */ } finally { Module._load = orig; }
  const win = {};
  try { vm.runInNewContext(fs.readFileSync(path.join(dir, 'optmacros.js'), 'utf8'), { window: win }); optFn = win.tssKatexMacros || null; } catch (e) { optFn = null; }
  katex = k;
  return k;
}

const isTexLike = (doc) => !!doc && (isTex(doc) || /\.tikz$/i.test(doc.uri.fsPath || ''));

async function run(context) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTexLike(ed.document)) { info('Відкрий .tex і постав курсор у формулу.'); return; }
  const doc = ed.document;
  let f = null;
  const sel = ed.selection;
  if (sel && !sel.isEmpty) f = FP.fromSelection(doc.getText(sel));
  else f = FP.formulaAt(doc.getText(), doc.offsetAt(sel.active));
  if (!f) { info('Курсор не у формулі: постав його всередину $…$, \\[…\\] чи equation/align або виділи формулу.'); return; }
  let fmt = String(cfg().get('copyFormula.format', 'mathml'));
  if (fmt === 'ask') {
    const pick = await vscode.window.showQuickPick([
      { label: 'MathML', description: 'для Word, PowerPoint, LibreOffice', v: 'mathml' },
      { label: 'LaTeX', description: 'код формули як у файлі', v: 'latex' }
    ], { placeHolder: 'Копіювати формулу як…' });
    if (!pick) return;
    fmt = pick.v;
  }
  if (fmt === 'latex') {
    await vscode.env.clipboard.writeText(f.tex);
    info('Формулу скопійовано як LaTeX.');
    return;
  }
  let text;
  try {
    const k = load(context.extensionPath);
    let macros = {};
    try { macros = await TE.katexMacros(doc); } catch (e) { macros = {}; }
    if (optFn) macros = optFn(macros);
    text = FP.mathmlOf(f.tex, f.display, k, macros);
  } catch (e) {
    warn('KaTeX не зміг прочитати формулу: ' + String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200));
    return;
  }
  await vscode.env.clipboard.writeText(text);
  info('Формулу скопійовано як MathML. У Word: Alt+= (рівняння), потім Ctrl+V.');
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.copyFormula', () => run(context)));
}

exports.register = register;
