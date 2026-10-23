'use strict';
// node tests/labelsMessages.vscode-stub.test.js [path/to/extension]
// labels.js: the check of the labels of the project says the same things in Ukrainian and in English (tssworkflow.language), the codes of the diagnostics do not depend on the language.
// vscode, util.js and projectIndex.js are replaced: only the messages of checkLabels are looked at.
const path = require('path'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const I = require(path.join(ext, 'i18n'));

const lab = (name, line, envs, o) => Object.assign({ name, line, col: 0, len: name.length, envs: envs || [], macro: false }, o || {});
const IDX = new Map([
  ['A.tex', { labels: [lab('eq:dup', 0, ['equation']), lab('x1', 3, ['equation']), lab('fig:ok', 5, ['figure'])], refs: [{ name: 'nope', line: 2, col: 0, len: 4 }, { name: 'fig:ok', line: 6, col: 0, len: 6 }] }],
  ['B.tex', { labels: [lab('eq:dup', 1, ['equation']), lab('eq:unused', 4, ['equation'])], refs: [] }]
]);
const infos = [];
let got = null;
const fake = {
  vscode: { DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 }, languages: { createDiagnosticCollection: () => ({}) } },
  util: { REF_CTX: /x/, baseOf: (f) => f, cfg: () => ({ get: (k, d) => (k === 'labelPrefixes' ? { equation: 'eq:' } : d) }), info: (m) => { infos.push(m); }, texFiles: async () => [], textOf: () => '' },
  projectIndex: { mapOver: async () => IDX, diagSetter: () => ({ set: (m) => { got = m; } }) }
};
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fake.vscode;
  if (parent && /[\\/]labels\.js$/.test(parent.filename)) {
    if (request === './util') return fake.util;
    if (request === './projectIndex') return fake.projectIndex;
  }
  return orig.apply(this, arguments);
};
const L = require(path.join(ext, 'labels'));

(async () => {
  const msgs = (m) => [].concat(...[...m.values()]).map((d) => [d.code, d.message]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  const run = async (lang) => { I.setLang(lang); infos.length = 0; got = null; await L.checkLabels(true); return { d: msgs(got), info: infos.slice() }; };
  const uk = await run('uk'), en = await run('en');
  I.setLang('uk');
  assert.deepStrictEqual(uk.d.map((x) => x[0]), en.d.map((x) => x[0]), 'the codes of the diagnostics are the same in both languages');
  assert.deepStrictEqual(uk.d.filter((x) => x[0] === 'label-duplicate').map((x) => x[1]), ['Мітка «eq:dup» визначена 2 разів', 'Мітка «eq:dup» визначена 2 разів']);
  assert.deepStrictEqual(en.d.filter((x) => x[0] === 'label-duplicate').map((x) => x[1]), ['The label “eq:dup” is defined 2 times', 'The label “eq:dup” is defined 2 times']);
  assert.deepStrictEqual(uk.d.filter((x) => x[0] === 'label-undefined').map((x) => x[1]), ['Мітку «nope» не знайдено в проєкті']);
  assert.deepStrictEqual(en.d.filter((x) => x[0] === 'label-undefined').map((x) => x[1]), ['The label “nope” was not found in the project']);
  assert.deepStrictEqual(en.d.filter((x) => x[0] === 'label-prefix').map((x) => x[1]), ['A label in “equation” must start with “eq:”']);
  assert.deepStrictEqual(uk.d.filter((x) => x[0] === 'label-prefix').map((x) => x[1]), ['Мітка в «equation» має починатися з «eq:»']);
  assert.ok(en.d.filter((x) => x[0] === 'label-unused').every((x) => /^The label “[^”]+” is not used anywhere$/.test(x[1])) && en.d.filter((x) => x[0] === 'label-unused').length > 0, JSON.stringify(en.d));
  assert.ok(uk.info[0].startsWith('Мітки: дублікатів 1, невизначених посилань 1, без використання '), uk.info[0]);
  assert.ok(/^Labels: duplicates 1, undefined references 1, unused \d+, with a wrong prefix 1 \(see Problems\)\.$/.test(en.info[0]), en.info[0]);
  console.log('labelsMessages: all ok');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
