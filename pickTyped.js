'use strict';
/* pickTyped.js: QuickPick over grouped items that also accepts a typed value (shared by wrapEnv and wrapCmd).
 *   base   QuickPick items; every selectable one has `.pick` (the payload returned) with `.name`
 *   parse  text -> { pick, name, label, withArgs } | null; the typed text as a payload
 * Returns the chosen payload, or undefined when the list is dismissed. */
const vscode = require('vscode');

function pickTyped(base, placeHolder, parse) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.placeholder = placeHolder;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = base;
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); qp.dispose(); };
    qp.onDidChangeValue((v) => {
      const p = parse(v);
      if (!p) { qp.items = base; return; }
      const exact = base.some((b) => b.pick && b.pick.name === p.name);
      if (exact && !p.withArgs) { qp.items = base; return; }
      const typed = { label: '$(add) ' + p.label, description: 'ввести як є', pick: p.pick, alwaysShow: true };
      // with arguments typed the typed entry is the one wanted; a bare name must not hide the usual matches
      qp.items = p.withArgs ? [typed, ...base] : [...base, typed];
    });
    qp.onDidAccept(() => { const sel = qp.selectedItems[0]; finish(sel && sel.pick ? sel.pick : undefined); });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });

module.exports = { pickTyped, sep };
