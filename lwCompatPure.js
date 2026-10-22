'use strict';
/* lwCompatPure.js: what in the settings of LaTeX Workshop gets in the way of this extension (no VS Code API).
 * lw: the effective values of `latex-workshop.<key>`; ours: { compileOnSave, pdfViewer }. Keys not set arrive as undefined: the
 * defaults of LaTeX Workshop are applied here. */

const { tr } = require('./i18n');

const LW_DEFAULTS = {
  'latex.autoBuild.run': 'onFileChange',
  'latex.autoClean.run': 'never',
  'latex.outDir': '%DIR%',
  'view.pdf.viewer': 'tab',
  'hover.ref.enabled': true
};
const val = (lw, k) => (lw && lw[k] !== undefined && lw[k] !== null ? lw[k] : LW_DEFAULTS[k]);

/* -> [{ id, level: 'warning' | 'info', title, why, fixes: [{ key, value }], optional }]; a fix is a write into latex-workshop.<key>;
 * an optional fix is offered but not ticked */
function lwFindings(lw, ours) {
  const out = [];
  const o = ours || {};
  const run = val(lw, 'latex.autoBuild.run');
  if (run !== 'never') {
    out.push({
      id: 'autoBuild',
      level: 'warning',
      title: tr('LaTeX Workshop збирає проєкт сам (autoBuild: {0})', run),
      why: o.compileOnSave
        ? tr('Увімкнена ще й збірка при збереженні цього розширення (Auto): кожне збереження запускає дві збірки, які пишуть у ті самі main.pdf, main.aux, main.log.')
        : tr('Збірка розділу цього розширення пише в ті самі main.pdf, main.aux, main.log, що й автозбірка LaTeX Workshop: після збереження вона перезапише результат і змішає .aux.'),
      fixes: [{ key: 'latex.autoBuild.run', value: 'never' }],
      optional: false
    });
  }
  const clean = val(lw, 'latex.autoClean.run');
  if (clean !== 'never') {
    out.push({
      id: 'autoClean',
      level: 'warning',
      title: tr('LaTeX Workshop прибирає допоміжні файли після збірки (autoClean: {0})', clean),
      why: tr('Збірка розділу бере номери посилань і зміст із main.aux; якщо LaTeX Workshop щоразу його видаляє, розділ збирається з порожніми посиланнями (??).'),
      fixes: [{ key: 'latex.autoClean.run', value: 'never' }],
      optional: false
    });
  }
  const out_ = val(lw, 'latex.outDir');
  if (out_ && out_ !== '%DIR%' && out_ !== '.' && out_ !== './') {
    out.push({
      id: 'outDir',
      level: 'info',
      title: tr('LaTeX Workshop збирає в «{0}», а не в корінь проєкту', out_),
      why: tr('Це розширення шукає <job>.pdf, .aux, .log і .synctex.gz у корені проєкту (для .aux можна задати tssworkflow.auxFile). Результат збірки LaTeX Workshop воно не побачить.'),
      fixes: [{ key: 'latex.outDir', value: '%DIR%' }],
      optional: true
    });
  }
  const viewer = val(lw, 'view.pdf.viewer');
  const mine = o.pdfViewer || 'vscode';
  if (mine !== 'none') {
    const wantsTab = mine === 'vscode' || mine === 'latexworkshop';
    if (wantsTab && viewer === 'external') {
      out.push({
        id: 'viewer',
        level: 'info',
        title: tr('Рідна кнопка LaTeX Workshop відкриє зовнішній PDF, а збірка цього розширення вкладку'),
        why: tr('latex-workshop.view.pdf.viewer = external, а tssworkflow.pdfViewer = {0}. Два вьюери для одного PDF.', mine),
        fixes: [{ key: 'view.pdf.viewer', value: 'tab' }],
        optional: true
      });
    } else if (mine === 'external' && viewer !== 'external') {
      out.push({
        id: 'viewer',
        level: 'info',
        title: tr('Рідна кнопка LaTeX Workshop відкриє вкладку, а збірка цього розширення зовнішню програму'),
        why: tr('tssworkflow.pdfViewer = external, а latex-workshop.view.pdf.viewer = {0}. Два вьюери для одного PDF.', viewer),
        fixes: [{ key: 'view.pdf.viewer', value: 'external' }],
        optional: true
      });
    }
  }
  if (val(lw, 'hover.ref.enabled') !== false) {
    out.push({
      id: 'hoverRef',
      level: 'info',
      title: tr('Наведення на \\ref показують і LaTeX Workshop, і це розширення'),
      why: tr('Підказка цього розширення багатша (номер і сторінка з .aux, текст формули чи підпису), тож у вікні дві підказки. Ctrl+клік на мітці теж може дати «2 definitions»: це безпечно.'),
      fixes: [{ key: 'hover.ref.enabled', value: false }],
      optional: true
    });
  }
  return out;
}

// is a reminder at start worth showing: both automatic builds are on, so every save runs two builds into the same files
const needsNudge = (findings, ours) => !!(ours && ours.compileOnSave) && findings.some((f) => f.id === 'autoBuild');

// where to write a latex-workshop.<key>: where the value is set already, otherwise the workspace (the user may use the
// extension elsewhere with other settings), without a workspace the user settings. inspect: WorkspaceConfiguration.inspect()
function writeTarget(inspect, hasWorkspace) {
  const i = inspect || {};
  if (i.workspaceFolderValue !== undefined) return 'folder';
  if (i.workspaceValue !== undefined) return 'workspace';
  return hasWorkspace ? 'workspace' : 'global';
}

module.exports = { LW_DEFAULTS, lwFindings, needsNudge, writeTarget };
