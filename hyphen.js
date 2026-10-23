'use strict';
/* hyphen.js: "Hyphenation of words that stick into the margin". The log of the PDF the PDF button opens (build.activePdf) gives
 * the overfull lines with the points where TeX may break each word; hyphenPure.js picks the words TeX could not break and
 * suggests points after the syllables. For a word the user chooses: \hyphenation{...} in the preamble (every occurrence; not for
 * a word with an explicit hyphen, which \hyphenation cannot describe) or \- in the source at this place only. The suggestion is
 * edited in an input box before anything is written; the files are changed in the editor and not saved. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const H = require('./hyphenPure');
const L = require('./logPure');
const { tr } = require('./i18n');
const { cfg, info, projectRoot, textOfPath, warn } = require('./util');

// the overfull lines of the log and the words of each that TeX could not break: [{ c, abs, rel, it }]
function collect(log, cwd, root) {
  const out = [];
  for (const it of L.parseLog(log, 0)) {
    if (!it.box) continue;
    const abs = path.resolve(cwd, it.file);
    const text = textOfPath(abs);
    const src = text === null ? '' : text.split(/\r?\n/).slice(it.line, it.endLine + 1).join('\n');
    for (const c of H.candidates(it.box, src)) out.push({ c, abs, rel: path.relative(root, abs).replace(/\\/g, '/'), it });
  }
  return out;
}

// the file with the preamble of the document of this PDF: <job>.tex next to it, else the main file of the project
function preambleFile(cwd, job, root) {
  const own = path.join(cwd, job + '.tex');
  if (fs.existsSync(own)) return own;
  return path.join(root, String(cfg().get('mainFile', 'main.tex') || 'main.tex'));
}

async function replaceAll(abs, text) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
  return vscode.workspace.applyEdit(we);
}

async function addToPreamble(file, entry) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const r = H.addHyphenation(doc.getText(), [entry]);
  if (!r) { warn(tr('У {0} немає \\begin{document}: не знаю, куди записати \\hyphenation.', path.basename(file))); return false; }
  if (!r.added.length) { info(tr('«{0}» вже є в \\hyphenation.', entry)); return true; }
  if (!(await replaceAll(file, r.text))) return false;
  vscode.window.setStatusBarMessage(tr('\\hyphenation{{0}}: {1}:{2}. Збери документ ще раз.', entry, path.basename(file), r.line + 1), 6000);
  return true;
}

async function softHyphenHere(x, edited) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(x.abs));
  const lines = doc.getText().split(/\r?\n/);
  const at = H.findInLines(lines, x.it.line, x.it.endLine, x.c.source);
  const repl = H.softHyphens(x.c.source, edited);
  if (!at || repl === null) { warn(tr('Не знайшов «{0}» у рядках {1}–{2} файла {3}.', x.c.source, x.it.line + 1, x.it.endLine + 1, x.rel)); return false; }
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(at.line, at.col, at.line, at.col + x.c.source.length), repl);
  if (!(await vscode.workspace.applyEdit(we))) return false;
  vscode.window.setStatusBarMessage(x.c.source + ' → ' + repl + ' (' + x.rel + ':' + (at.line + 1) + ')', 6000);
  return true;
}

async function hyphenCmd() {
  const r = require('./build').activePdf();
  if (r.warn) { warn(r.warn); return; }
  if (!r.pdf) { warn(tr('PDF не знайдено. Спершу збери документ кнопкою ▷.')); return; }
  const cwd = path.dirname(r.pdf);
  const job = path.basename(r.pdf, path.extname(r.pdf));
  const root = projectRoot() || cwd;
  let log;
  try { log = fs.readFileSync(path.join(cwd, job + '.log'), 'utf8'); } catch (e) { warn(tr('Немає {0}.log поруч із PDF.', job)); return; }
  const items = collect(log, cwd, root);
  if (!items.length) { info(tr('У рядках, що вилазять на поле, немає слів, які TeX не зміг перенести.')); return; }
  const preamble = preambleFile(cwd, job, root);
  const ACT = { global: tr('$(symbol-text) \\hyphenation у преамбулі: усі входження'), here: tr('$(edit) \\- лише в цьому місці'), open: tr('$(go-to-file) Відкрити місце') };
  for (;;) {
    const pick = await vscode.window.showQuickPick(items.map((x) => ({
      label: x.c.shown,
      description: x.rel + ':' + (x.it.line + 1) + ' · ' + x.it.pts + 'pt',
      detail: (x.c.compound ? tr('складене слово: TeX переносить лише по дефісу') : tr('TeX не знайшов, де перенести')) + tr(' · пропозиція: {0}', H.suggest(x.c.compound ? x.c.source : x.c.letters)),
      x
    })), { placeHolder: tr('Слова, через які рядок вилазить на поле ({0}). Esc: закінчити', items.length), matchOnDescription: true, matchOnDetail: true });
    if (!pick) return;
    const x = pick.x;
    const acts = [];
    if (!x.c.compound) acts.push(ACT.global);
    if (x.c.source) acts.push(ACT.here);
    acts.push(ACT.open);
    const act = await vscode.window.showQuickPick(acts, { placeHolder: x.c.shown + (x.c.compound ? '' : tr(' — \\hyphenation записується в {0}', path.basename(preamble))) });
    if (!act) continue;
    if (act === ACT.open) {
      await vscode.window.showTextDocument(vscode.Uri.file(x.abs), { selection: new vscode.Range(x.it.line, 0, x.it.line, 0), preview: true });
      return;
    }
    const word = x.c.compound ? x.c.source : x.c.letters;
    const edited = await vscode.window.showInputBox({
      value: H.suggest(word),
      prompt: tr('Де TeX може переносити «{0}»: дефіс між складами. Перевір пропозицію, вона за складами, а не за словником.', word),
      validateInput: (v) => {
        const ok = act === ACT.global ? H.hyphenationEntry(word, v) : H.softHyphens(word, v);
        return ok === null ? tr('Ті самі літери, що в «{0}», з дефісами між ними', word) : null;
      }
    });
    if (edited === undefined) continue;
    const done = act === ACT.global ? await addToPreamble(preamble, H.hyphenationEntry(word, edited)) : await softHyphenHere(x, edited);
    if (done) items.splice(items.indexOf(x), 1);
    if (!items.length) return;
  }
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.hyphenHelper', hyphenCmd));
}

module.exports = { register, _t: { collect, preambleFile } };
