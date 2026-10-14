'use strict';
/* lwCompat.js: "Check compatibility with LaTeX Workshop" and a reminder at start when both automatic builds are on.
 * The rules are in lwCompatPure.js. The fixes are written into the latex-workshop.* settings (the workspace, see writeTarget). */
const vscode = require('vscode');
const L = require('./lwCompatPure');
const { cfg } = require('./util');

const LW_ID = 'James-Yu.latex-workshop';
const DISMISS_KEY = 'lwCompat.dismissed';

const lwInstalled = () => !!vscode.extensions.getExtension(LW_ID);

function readLw() {
  const c = vscode.workspace.getConfiguration('latex-workshop');
  const o = {};
  for (const k of Object.keys(L.LW_DEFAULTS)) o[k] = c.get(k);
  return o;
}
const readOurs = () => ({ compileOnSave: !!cfg().get('compileOnSave', false), pdfViewer: cfg().get('pdfViewer', 'vscode') });

const TARGETS = () => ({ folder: vscode.ConfigurationTarget.WorkspaceFolder, workspace: vscode.ConfigurationTarget.Workspace, global: vscode.ConfigurationTarget.Global });

// writes the fixes; returns how many settings were written
async function applyFixes(fixes) {
  const c = vscode.workspace.getConfiguration('latex-workshop');
  const hasWs = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
  let n = 0;
  for (const f of fixes) {
    let ins = null;
    try { ins = c.inspect(f.key); } catch (e) { /* the default target */ }
    const target = TARGETS()[L.writeTarget(ins, hasWs)];
    try { await c.update(f.key, f.value, target); n++; } catch (e) { vscode.window.showWarningMessage('Не вдалося записати latex-workshop.' + f.key + ': ' + (e && e.message ? e.message : e)); }
  }
  return n;
}

const fixText = (f) => f.fixes.map((x) => 'latex-workshop.' + x.key + ' → ' + JSON.stringify(x.value)).join(', ');

async function check() {
  if (!lwInstalled()) {
    vscode.window.showInformationMessage('LaTeX Workshop не встановлено: конфліктувати нема з чим. PDF відкриватиметься через vscode.open.');
    return { installed: false, findings: [], applied: 0 };
  }
  const findings = L.lwFindings(readLw(), readOurs());
  if (!findings.length) {
    vscode.window.showInformationMessage('Конфліктів із LaTeX Workshop не знайдено.');
    return { installed: true, findings, applied: 0 };
  }
  const items = findings.map((f) => ({
    label: (f.level === 'warning' ? '$(warning) ' : '$(info) ') + f.title,
    description: f.fixes.length ? fixText(f) : 'лише інформація',
    detail: f.why,
    picked: !f.optional && f.fixes.length > 0,
    f
  }));
  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'LaTeX Workshop: що може заважати цьому розширенню',
    placeHolder: 'Відмічені пункти буде виправлено (запис у налаштування робочого простору). Esc нічого не змінює'
  });
  if (!picks) return { installed: true, findings, applied: 0 };
  const fixes = [];
  for (const p of picks) fixes.push(...p.f.fixes);
  const applied = fixes.length ? await applyFixes(fixes) : 0;
  if (applied) vscode.window.setStatusBarMessage('LaTeX Workshop: записано налаштувань ' + applied + '. Перезавантажувати вікно не треба.', 6000);
  return { installed: true, findings, applied };
}

// at start: both automatic builds on = two builds per save into the same files; ask once per workspace
async function nudge(context) {
  if (!lwInstalled() || !cfg().get('lwCompat.notify', true) || context.workspaceState.get(DISMISS_KEY)) return null;
  const ours = readOurs();
  const findings = L.lwFindings(readLw(), ours);
  if (!L.needsNudge(findings, ours)) return null;
  const fix = 'Виправити…';
  const never = 'Не нагадувати';
  const pick = await vscode.window.showWarningMessage(
    'Увімкнені дві автозбірки: «Auto» цього розширення і autoBuild LaTeX Workshop. Кожне збереження запускає дві збірки в ті самі файли.',
    fix, never
  );
  if (pick === fix) return check();
  if (pick === never) await context.workspaceState.update(DISMISS_KEY, true);
  return null;
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.checkLatexWorkshop', check));
  const t = setTimeout(() => nudge(context).catch(() => {}), 8000);
  if (t && typeof t.unref === 'function') t.unref();
}

module.exports = { register, check, nudge, applyFixes };
