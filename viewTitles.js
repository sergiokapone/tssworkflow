'use strict';
/* viewTitles.js: the titles of the five panels of the Activity Bar in the language of the extension (tssworkflow.language).
 * package.json holds them as %view.*% (package.nls.json: English, package.nls.uk.json: Ukrainian) and VS Code picks one by
 * its own display language; this module then sets the title from the setting, so that the setting wins when the two differ,
 * and changes it at once when the setting changes. */
const { tr } = require('./i18n');

const TITLES = {
  'tssworkflow.commandsView': () => tr('Команди'),
  'tssworkflow.chaptersView': () => tr('Розділи'),
  'tssworkflow.startView': () => tr('Початок'),
  'tssworkflow.problemsView': () => tr('Проблеми'),
  'tssworkflow.labelsView': () => tr('Мітки')
};
const views = new Map();

function apply() {
  for (const [id, v] of views) {
    try { v.title = TITLES[id](); } catch (e) { /* a view that is already disposed */ }
  }
}
// remembers the view and gives it its title; returns the view (so that it can stay inside subscriptions.push(...))
function track(view, id) {
  if (view && TITLES[id]) { views.set(id, view); try { view.title = TITLES[id](); } catch (e) { /* ignore */ } }
  return view;
}

module.exports = { track, apply, TITLES };
