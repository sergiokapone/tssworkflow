'use strict';
// node tests/tableEditor.webview.test.js [path/to/extension]  - media/tableEditor/webview.js in a real DOM (needs the jsdom package; skipped without it)
const path = require('path'), fs = require('fs'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
let JSDOM;
try { JSDOM = require(require.resolve('jsdom', { paths: [process.cwd(), __dirname, path.join(__dirname, '..')] })).JSDOM; }
catch (e) { console.log('skip: jsdom is not installed (npm i -D jsdom)'); process.exit(0); }
const T = require(path.join(ext, 'tableEditorPure.js'));
const MP = require(path.join(ext, 'macrosPure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const SRC = String.raw`\begin{tblr}{colspec={Q[l]Q[l]Q[l]}, row{1}={c}, cell{2-4}{2-Z}={mode=dmath}}
Рівняння & Інтегральна & Диференціальна \\
Гаусс & \oint\limits_S \Bfield\cdot d\vect{S} = 0 & \divg\Bfield = 0 \\
Невідома & \unknownmacro x & y \\
Кирилиця & Теорема & \text{Теорема} + x \\
\end{tblr}`;
const env = T.locateTables(SRC)[0];
const view = T.toView(T.parseTable(SRC, env).model, new Map());
const macros = MP.toKatexMacros(MP.scanMacros(['\\newcommand{\\vect}[1]{\\symbf{#1}}', '\\newcommand{\\Bfield}{\\vect{B}}', '\\newcommand{\\divg}{\\nabla\\cdot}'].join('\n')));

const dom = new JSDOM('<!DOCTYPE html><body><div id="bar"><span id="what"></span><span id="size"></span></div><div id="warn"></div><div id="info"></div><div id="toast"></div><div id="wrap" tabindex="0"><table id="t"></table></div><div id="hint"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window, posted = [];
w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), getState: () => null, setState: () => {} });
w.eval(fs.readFileSync(path.join(ext, 'media', 'katex', 'katex.min.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(ext, 'media', 'tableEditor', 'webview.js'), 'utf8'));
w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'model', view, macros, where: 't.tex:1' } }));
const td = (r, c) => w.document.querySelector('#t td[data-r="' + r + '"][data-c="' + c + '"]');
const isMath = (el) => /class="katex"/.test(el.innerHTML);

t('the editor tells the host it is ready', () => assert.ok(posted.some((m) => m.type === 'ready')));
t('mode=dmath cells are formulas, the header and the first column are not', () => {
  assert.ok(isMath(td(1, 1)) && isMath(td(1, 2)));
  assert.ok(!isMath(td(0, 1)) && !isMath(td(1, 0)));
});
t('project macros are expanded: no error class, no tooltip', () => {
  for (const c of [1, 2]) { assert.ok(!td(1, c).classList.contains('matherr')); assert.ok(!td(1, c).title); }
});
t('an unknown macro is marked and named in the tooltip', () => {
  assert.ok(td(2, 1).classList.contains('matherr'));
  assert.ok(td(2, 1).title.includes('unknownmacro'), td(2, 1).title);
});
t('Cyrillic outside \\text{} in a math cell gets a warning, inside \\text{} not', () => {
  assert.ok(td(3, 1).classList.contains('mathwarn'));
  assert.ok(!td(3, 2).classList.contains('mathwarn'));
});
t('a cell with $...$ inside a math cell is drawn the usual way', () => {
  const d = td(1, 1);
  d.dataset.mode = 'dmath';
  // the same function the editor uses when a cell is edited
  w.eval('renderCell(document.querySelector(\'#t td[data-r="1"][data-c="1"]\'), "$x^2$ and \\\\(y\\\\)")');
  assert.strictEqual((d.innerHTML.match(/class="katex"/g) || []).length, 2);
});
console.log('\n' + n + ' tests passed');
