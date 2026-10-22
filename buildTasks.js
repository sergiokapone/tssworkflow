'use strict';
/* buildTasks.js: the builds of this extension as VS Code tasks (type "tssworkflow"), so that Terminal > Run Build Task (Ctrl+Shift+B)
 * and tasks.json can start them. A task does not run a process itself: it starts the same build as the button ▷ (status bar,
 * log parsing, PDF in the viewer, one build at a time) and ends with its result.
 *   { "type": "tssworkflow", "target": "current" }   the file of the editor: chapter, figure or standalone document (F5)
 *   { "type": "tssworkflow", "target": "main" }      the whole document (Shift+F5)
 * "openPdf": false builds without opening the PDF. */
const vscode = require('vscode');
const { tr } = require('./i18n');

const TARGETS = {
  current: { label: 'Build current file (chapter / figure / standalone) and open PDF', labelNoPdf: 'Build current file (no PDF)' },
  main: { label: 'Build whole document and open PDF', labelNoPdf: 'Build whole document (no PDF)' }
};

// api: { run(target, openPdf, done), outcome(), stop() } from extension.js; outcome() is the result of the last build or null when none started
function makeTask(def, api) {
  const target = def.target;
  const openPdf = def.openPdf !== false;
  const definition = { type: 'tssworkflow', target };
  if (def.openPdf === false) definition.openPdf = false;
  const name = openPdf ? TARGETS[target].label : TARGETS[target].labelNoPdf;
  const exec = new vscode.CustomExecution(async () => {
    const w = new vscode.EventEmitter();
    const c = new vscode.EventEmitter();
    let closed = false;
    const end = (code) => { if (!closed) { closed = true; c.fire(code); } };
    return {
      onDidWrite: w.event,
      onDidClose: c.event,
      open() {
        w.fire('TSS Workflow: ' + name + '\r\n');
        api.run(target, openPdf, () => {
          const o = api.outcome();
          if (!o) { w.fire(tr('Збірку не запущено (див. повідомлення в правому нижньому куті).') + '\r\n'); end(1); }
          else if (o.stopped) { w.fire(tr('Збірку зупинено.') + '\r\n'); end(1); }
          else if (o.ok) { w.fire(tr('Готово.') + '\r\n'); end(0); }
          else { w.fire(tr('Збірка завершилась з помилками (код {0}). Дивись Problems.', o.code) + '\r\n'); end(1); }
        });
      },
      // the terminal of the task closed (Terminate Task) while the build runs: stop it, as the button ⏹ does
      close() { if (!closed) { closed = true; if (api.stop) api.stop(); } }
    };
  });
  const task = new vscode.Task(definition, vscode.TaskScope.Workspace, name, 'tssworkflow', exec);
  task.group = vscode.TaskGroup.Build;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true, showReuseMessage: false };
  return task;
}

function register(context, api) {
  const provider = {
    provideTasks() { return Object.keys(TARGETS).map((target) => makeTask({ target }, api)); },
    // a task of tasks.json: only the ones with a known target are ours (the internal build tasks have job / id and are never resolved here)
    resolveTask(task) {
      const d = task.definition || {};
      return TARGETS[d.target] ? makeTask(d, api) : undefined;
    }
  };
  context.subscriptions.push(vscode.tasks.registerTaskProvider('tssworkflow', provider));
}

module.exports = { register, makeTask, TARGETS };
