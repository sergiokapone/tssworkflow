'use strict';
/* debugState.js: the command "TSS Workflow: Show state (leaks, timers, caches)". A Markdown report beside the editor with the
 * numbers that grow when something leaks: the length of context.subscriptions, the pending timers, the sizes of the caches,
 * the open panels and the memory of the extension host. A second call shows the change since the first (debugStatePure.js). */
const vscode = require('vscode');
const { tr } = require('./i18n');
const U = require('./util');
const D = require('./debugStatePure');

let previous = null; // counters() of the previous report

const PANELS = () => [[tr('Перегляд виділеного'), './selectionPreview'], [tr('Таблиця'), './tableEditor'], [tr('Галерея макросів'), './macroGallery'], [tr('Формули проєкту'), './formulaOverview']];

function collect(context) {
  const panels = {};
  for (const [name, mod] of PANELS()) {
    try { const m = require(mod); panels[name] = typeof m.isOpen === 'function' ? !!m.isOpen() : false; } catch (e) { panels[name] = false; }
  }
  let index = {};
  try { index = require('./projectIndex').stats(); } catch (e) { /* no index */ }
  const cache = U.cacheStats();
  let version = '?';
  try { version = context.extension.packageJSON.version; } catch (e) { /* stub */ }
  return {
    version,
    vscodeVersion: vscode.version,
    platform: process.platform,
    node: process.version,
    uptimeSec: process.uptime(),
    subscriptions: context.subscriptions.length,
    timers: U.timerKeys(),
    caching: cache.caching,
    findCache: cache.findCache,
    docMap: cache.docMap,
    index,
    panels,
    openDocs: vscode.workspace.textDocuments.length,
    memory: process.memoryUsage()
  };
}

async function showState(context) {
  const state = collect(context);
  const content = D.report(state, previous);
  previous = D.counters(state);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: false });
}

function register(context) {
  context.subscriptions.push(vscode.commands.registerCommand('tssworkflow.debugState', () => showState(context)));
}

module.exports = { register, collect };
