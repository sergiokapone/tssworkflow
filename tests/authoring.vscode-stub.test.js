'use strict';
// node tests/authoring.vscode-stub.test.js [path/to/extension]
// authoring.js (new chapter, \iffalse, Unicode -> LaTeX, BibTeX by DOI) against the shared stub of vscode, in Ukrainian and in English (tssworkflow.language):
// the messages, the buttons of the question about \iffalse (the English button is understood), the errors of the input.
const assert = require('assert'), path = require('path'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
const { makeVscode } = require('./vscodeStub');
const I = require(path.join(EXT, 'i18n'));
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };

// what register() calls and the test does not look at (on…, register…, create…) is a no-op that returns something disposable
const lenient = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^(on|register|create)/.test(k) ? () => ({ dispose() {}, show() {}, hide() {}, onDidCreate() {}, onDidChange() {}, onDidDelete() {} }) : undefined) });

async function run(lang, { id, text, sel, folder, inputs, button }) {
  I.setLang(lang);
  const h = makeVscode(text || 'x\n', [sel || [0, 0, 0, 0]], {}, {});
  const { vs, doc, handlers } = h;
  doc.languageId = 'latex'; doc.uri = { fsPath: '/p/a.tex', toString: () => 'file:///p/a.tex', path: '/p/a.tex' };
  vs.msgs = []; vs.status = []; vs.inputs = [];
  vs.workspace.workspaceFolders = folder ? [{ uri: { fsPath: '/p' } }] : [];
  vs.workspace.getWorkspaceFolder = () => vs.workspace.workspaceFolders[0];
  vs.window.showInformationMessage = async (m, ...b) => { vs.msgs.push([m, ...b]); return undefined; };
  vs.window.showWarningMessage = async (m, ...b) => { vs.msgs.push(['W:' + m, ...b.filter((x) => typeof x === 'string')]); return b.includes(button) ? button : undefined; };
  vs.window.setStatusBarMessage = (m) => { vs.status.push(m); };
  vs.window.showInputBox = async (o) => { vs.inputs.push(o); return (inputs || []).shift(); };
  vs.window.createStatusBarItem = () => ({ show() {}, hide() {}, dispose() {} });
  vs.StatusBarAlignment = { Left: 1, Right: 2 };
  vs.Uri = { file: (f) => ({ fsPath: f, toString: () => f }), parse: (s) => ({ toString: () => s }) };
  vs.env = { clipboard: { async writeText() {} } };
  vs.DocumentDropEdit = class {}; vs.DocumentPasteEdit = class {}; vs.DocumentPasteEditKind = { Empty: {} }; vs.DocumentDropOrPasteEditKind = { Empty: {} };
  vs.CodeActionKind = { QuickFix: { value: 'quickfix' } };
  vs.languages.registerDocumentDropEditProvider = () => ({ dispose() {} });
  vs.languages.registerDocumentPasteEditProvider = () => ({ dispose() {} });
  vs.workspace.createFileSystemWatcher = () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} });
  vs.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
  vs.workspace.onDidSaveTextDocument = () => ({ dispose() {} });
  vs.window.onDidChangeActiveTextEditor = () => ({ dispose() {} });
  // the shared stub knows replace() in ed.edit(); \iffalse also needs insert(): the same, on a position
  h.ed.edit = async (fn) => {
    const reps = [];
    fn({ replace: (r, t) => reps.push([doc.offsetAt(r.start), doc.offsetAt(r.end), t]), insert: (p, t) => reps.push([doc.offsetAt(p), doc.offsetAt(p), t]) });
    reps.sort((a, b) => b[0] - a[0]);
    let all = doc.lines.join('\n');
    for (const [a, b, t] of reps) all = all.slice(0, a) + t + all.slice(b);
    doc.lines = all.split('\n');
    return true;
  };
  vs.workspace = lenient(vs.workspace); vs.window = lenient(vs.window); vs.languages = lenient(vs.languages);
  const orig = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
  for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && /\.js$/.test(k) && !/[\\/]i18n(En)?\.js$/.test(k)) delete require.cache[k];
  const mem = {};
  try {
    require(path.join(EXT, 'authoring')).register({ subscriptions: [], globalState: { get: (k) => mem[k], update: async (k, v) => { mem[k] = v; } } });
    await handlers[id]();
  } finally { Module._load = orig; }
  return { vs, doc };
}

(async () => {
  try {
    // no project folder
    eq((await run('uk', { id: 'tssworkflow.newChapter' })).vs.msgs, [['W:Відкрий папку проєкту.']]);
    eq((await run('en', { id: 'tssworkflow.newChapter' })).vs.msgs, [['W:Open the project folder.']]);

    // \iffalse around a selection with an unbalanced \if: the question and its buttons
    const IF = '\\if x\nfoo\n';
    const uk = await run('uk', { id: 'tssworkflow.toggleIffalse', text: IF, sel: [0, 0, 1, 3], button: 'Усе одно' });
    eq(uk.vs.msgs, [['W:У виділеному є \\if без \\fi: \\iffalse може зламати збірку. Усе одно обгорнути?', 'Усе одно', 'Скасувати']]);
    const en = await run('en', { id: 'tssworkflow.toggleIffalse', text: IF, sel: [0, 0, 1, 3], button: 'Anyway' });
    eq(en.vs.msgs, [['W:The selection has an \\if without \\fi: \\iffalse may break the build. Wrap it anyway?', 'Anyway', 'Cancel']]);
    eq(en.doc.lines, uk.doc.lines, 'the English button wraps the same way');
    ok(en.doc.lines.some((l) => /\\iffalse/.test(l)) && en.doc.lines.some((l) => /\\fi\b/.test(l)), 'wrapped: ' + en.doc.lines.join('|'));
    const refused = await run('en', { id: 'tssworkflow.toggleIffalse', text: IF, sel: [0, 0, 1, 3], button: 'Усе одно' });
    eq(refused.doc.lines, ['\\if x', 'foo', ''], 'the Ukrainian button is not an answer in English');
    const fi = await run('en', { id: 'tssworkflow.toggleIffalse', text: 'a\n\\fi\n', sel: [0, 0, 1, 3] });
    ok(/^W:The selection has a \\fi without \\if:/.test(fi.vs.msgs[0][0]), fi.vs.msgs[0][0]);

    // Unicode -> LaTeX
    eq((await run('en', { id: 'tssworkflow.unicodeToLatex', text: 'plain ascii\n', sel: [0, 0, 0, 5] })).vs.msgs, [['No Unicode characters to replace found.']]);
    eq((await run('uk', { id: 'tssworkflow.unicodeToLatex', text: 'plain ascii\n', sel: [0, 0, 0, 5] })).vs.msgs, [['Unicode-символів для заміни не знайдено.']]);
    const un = await run('en', { id: 'tssworkflow.unicodeToLatex', text: 'a α b\n', sel: [0, 0, 0, 5] });
    ok(un.vs.status.length === 1 && /^Unicode → LaTeX: replaced \d+$/.test(un.vs.status[0]), JSON.stringify(un.vs.status));

    // BibTeX by DOI: the prompt, the error of the input
    const bib = await run('en', { id: 'tssworkflow.bibFromDoi', folder: true, inputs: ['not a doi'] });
    eq(bib.vs.inputs[0].prompt, 'DOI or a doi.org link');
    eq(bib.vs.msgs, [['W:Does not look like a DOI (10.xxxx/… is expected).']]);
    eq((await run('uk', { id: 'tssworkflow.bibFromDoi', folder: true, inputs: ['not a doi'] })).vs.msgs, [['W:Не схоже на DOI (очікується 10.xxxx/…).']]);

    // new chapter: the validation of the name
    const nc = await run('en', { id: 'tssworkflow.newChapter', folder: true, inputs: [undefined] });
    const valid = nc.vs.inputs[0].validateInput;
    eq(nc.vs.inputs[0].prompt, 'Name of the chapter: the name of the folder and the file (Latin letters, digits, - and _)');
    eq([valid('Ab_1'), valid('1abc'), valid('глава')], [null, 'Latin letters, digits, - and _ only; start with a letter', 'Latin letters, digits, - and _ only; start with a letter']);
    I.setLang('uk');
  } finally { I.setLang('uk'); }
  console.log('authoring.vscode-stub: ' + n + ' checks passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
