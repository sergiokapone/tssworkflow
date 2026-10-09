'use strict';
/* saveAndPictures.js: protected commands, typography on save, the pictures panel, unused files. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./corePure');
const { EXCLUDE, cfg, docLines, info, listFiles, texFiles, textOf } = require('./util');

/* ------- code that typography leaves alone: tssworkflow.protectedCommands ------ */
const syncUserCode = () => P.setProtectedCommands(cfg().get('protectedCommands', []));

/* ----------------------- typography on save -------------------------- */
function typographyOnWillSave(e) {
  const d = e.document;
  if (!cfg().get('typographyOnSave', false) || !/\.tex$/i.test(d.uri.fsPath)) return;
  if (d.languageId !== 'latex' && d.languageId !== 'tex') return;
  const old = docLines(d);
  const r = P.typography(old.join('\n'), { quotes: cfg().get('quoteStyle', 'guillemets') });
  if (!r.count) return;
  const neu = r.text.split('\n');
  if (neu.length !== old.length) return;
  const edits = [];
  for (let i = 0; i < old.length; i++) {
    if (neu[i] !== old[i]) edits.push(vscode.TextEdit.replace(new vscode.Range(i, 0, i, old[i].length), neu[i]));
  }
  if (edits.length) e.waitUntil(Promise.resolve(edits));
}

/* --------------------------- pictures panel -------------------------- */
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function picturesPanel() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const docUri = ed.document.uri;
  const dir = path.join(path.dirname(docUri.fsPath), 'Pictures');
  const files = fs.existsSync(dir) ? listFiles(dir, ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'], 3) : [];
  if (!files.length) { vscode.window.showWarningMessage('У ' + dir + ' немає зображень для перегляду.'); return; }
  const panel = vscode.window.createWebviewPanel(
    'tssworkflowPictures', 'Pictures', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(dir)] }
  );
  const w = panel.webview;
  const cards = files.map((rel) => {
    const uri = w.asWebviewUri(vscode.Uri.file(path.join(dir, rel)));
    const name = rel.replace(/\.[^.]+$/, '');
    return '<div class="c" data-n="' + esc(name) + '"><img src="' + uri + '"><div>' + esc(rel) + '</div></div>';
  }).join('');
  w.html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' + w.cspSource + '; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
    '<style>body{font-family:sans-serif;display:flex;flex-wrap:wrap;gap:10px;padding:8px}' +
    '.c{width:150px;cursor:pointer;border:1px solid #8884;border-radius:4px;padding:4px;font-size:11px;word-break:break-all}' +
    '.c:hover{border-color:#4a9eff}.c img{width:100%;height:110px;object-fit:contain;background:#fff}</style></head><body>' +
    cards +
    '<script>const vs=acquireVsCodeApi();document.querySelectorAll(".c").forEach(e=>e.onclick=()=>vs.postMessage({name:e.dataset.n}));</script>' +
    '</body></html>';
  panel.webview.onDidReceiveMessage(async (msg) => {
    const e = vscode.window.visibleTextEditors.find((x) => x.document.uri.toString() === docUri.toString());
    if (!e) return;
    const pos = e.selection.active;
    const text = e.document.lineAt(pos.line).text;
    const re = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g;
    let m;
    let ctx = null;
    while ((m = re.exec(text)) !== null) {
      const s = m.index + m[0].lastIndexOf('{') + 1;
      if (pos.character >= s && pos.character <= s + m[1].length) ctx = { s, e: s + m[1].length };
    }
    await e.edit((b) =>
      ctx
        ? b.replace(new vscode.Range(pos.line, ctx.s, pos.line, ctx.e), msg.name)
        : b.insert(pos, '\\includegraphics[width=\\linewidth]{' + msg.name + '}')
    );
  });
}

/* ---------------------------- unused files --------------------------- */
async function unusedFiles() {
  const tex = await texFiles();
  const texts = tex.map((f) => ({ p: f.fsPath, t: textOf(f) }));
  const pics = await vscode.workspace.findFiles('**/Pictures/**/*.{png,jpg,jpeg,gif,webp,svg,pdf,eps,tif,tiff}', EXCLUDE, 5000);
  const tikz = await vscode.workspace.findFiles('**/tikz/**/*.{tikz,tex}', EXCLUDE, 5000);
  const unused = pics.concat(tikz).filter((f) => {
    const base = path.basename(f.fsPath).replace(/\.[^.]+$/, '');
    const re = new RegExp('(?<![\\w-])' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    return !texts.some((x) => x.p !== f.fsPath && re.test(x.t));
  });
  if (!unused.length) { info('Файлів без посилань не знайдено.'); return; }
  const items = unused.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Файли, на які ніде немає посилань: ' + unused.length + ' (обери, щоб відкрити)'
  });
  if (pick) vscode.commands.executeCommand('vscode.open', pick.uri);
}

module.exports = {
  picturesPanel,
  syncUserCode,
  typographyOnWillSave,
  unusedFiles,
};
