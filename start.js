'use strict';
/* TSS Workflow 0.4.3: the "Початок" view of the Activity Bar and the context key `tssworkflow.hasTex`.
 * Without a .tex/.tikz file in the workspace only the welcome view (buttons "New from template" and "Create
 * .vscode/settings.json") is shown; as soon as such a file appears, the panels "Команди" and "Розділи" take its place.
 * Also: a one-time warning at the start when latexmk or lualatex is not in PATH. */
const vscode = require('vscode');
const P = require('./pure');

const EXCLUDE = '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**}';
const cfg = () => vscode.workspace.getConfiguration('tssworkflow');

class EmptyTree {
  getTreeItem(el) { return el; }
  getChildren() { return []; }
}

async function detectHasTex() {
  const found = await vscode.workspace.findFiles('**/*.{tex,tikz}', EXCLUDE, 1);
  return found.length > 0;
}

// programs without which nothing can be built; the names come from the settings
const requiredTools = () => [
  { name: 'latexmk', cmd: String(cfg().get('latexmk', 'latexmk') || 'latexmk') },
  { name: 'lualatex', cmd: String(cfg().get('lualatex', 'lualatex') || 'lualatex') }
];

async function offerEnvironmentCheck(context) {
  if (!cfg().get('checkEnvironmentOnStart', true)) return;
  if (context.globalState.get('tssworkflow.envPromptShown')) return;
  if (!(await detectHasTex())) return;
  const missing = requiredTools().filter((t) => !P.findInPath(t.cmd));
  if (!missing.length) return;
  await context.globalState.update('tssworkflow.envPromptShown', true);
  const pick = await vscode.window.showWarningMessage(
    'TSS Workflow: у PATH не знайдено ' + missing.map((t) => t.name).join(', ') + ': збірка не запуститься. Показати перевірку середовища?',
    'Перевірити', 'Не нагадувати'
  );
  if (pick === 'Перевірити') await vscode.commands.executeCommand('tssworkflow.checkEnvironment');
  else if (pick === 'Не нагадувати') await cfg().update('checkEnvironmentOnStart', false, vscode.ConfigurationTarget.Global);
}

function register(context) {
  let last = null;
  const apply = async () => {
    let v = false;
    try { v = await detectHasTex(); } catch (e) { v = false; }
    if (v !== last) {
      last = v;
      await vscode.commands.executeCommand('setContext', 'tssworkflow.hasTex', v);
    }
  };
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { apply(); }, 300); };

  context.subscriptions.push(
    vscode.window.createTreeView('tssworkflow.startView', { treeDataProvider: new EmptyTree() }),
    vscode.workspace.onDidChangeWorkspaceFolders(later),
    vscode.workspace.onDidSaveTextDocument((d) => { if (/\.(tex|tikz)$/i.test(d.fileName)) later(); })
  );
  if (vscode.workspace.createFileSystemWatcher) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.{tex,tikz}');
    context.subscriptions.push(w, w.onDidCreate(later), w.onDidDelete(later));
  }
  apply();
  setTimeout(() => offerEnvironmentCheck(context).catch(() => {}), 6000);
}

exports.register = register;
exports.detectHasTex = detectHasTex;
