'use strict';
// node tests/tableEditor.chem.test.js [path/to/extension]
// \ce{...} and \pu{...} (mhchem) in a cell of the table editor, outside $...$ and inside it: fmt() of media/tableEditor/webview.js
// runs here without a DOM, with the real katex.min.js and mhchem.min.js of the extension
const path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const src = fs.readFileSync(path.join(ext, 'media', 'tableEditor', 'webview.js'), 'utf8');
const from = src.indexOf('const esc = ');
const a = src.indexOf('let mathErr', from), b = src.indexOf('// spreadtab:', a);
assert.ok(from >= 0 && a > 0 && b > a, 'the cell renderer was not found in webview.js');
const box = vm.createContext({});
box.window = box; box.self = box;
box.T = (k, ...a) => k.replace(/\{(\d+)\}/g, (m, i) => (+i < a.length ? String(a[+i]) : m)); // media/common/i18n.js: the page asks its texts through T(...)
vm.runInContext(fs.readFileSync(path.join(ext, 'media', 'katex', 'katex.min.js'), 'utf8'), box);
vm.runInContext(fs.readFileSync(path.join(ext, 'media', 'katex', 'mhchem.min.js'), 'utf8'), box);
vm.runInContext('var macros = {}; var view = null;\n' + src.slice(from, src.indexOf('\n', from)) + '\n' + src.slice(a, b) + '\nthis.fmt = fmt; this.getErr = () => mathErr;', box);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const fmt = (s) => box.fmt(s);
const count = (h) => (h.match(/class="katex"/g) || []).length;

let h = fmt('Вода \\ce{H2O} кипить');
ok(count(h) === 1 && h.startsWith('Вода ') && h.endsWith(' кипить'), 'a \\ce in a text is a formula: ' + h.slice(0, 120));
ok(!h.includes('\\ce'), 'the command itself is not shown');
ok(/<sub>|vlist/.test(h), 'the index is drawn');
h = fmt('\\ce{2H2 + O2 -> 2H2O}');
ok(count(h) === 1 && !box.getErr(), 'a reaction: ' + box.getErr());
h = fmt('\\ce{^{238}_{92}U} і \\ce{SO4^2-}');
ok(count(h) === 2 && !box.getErr(), 'nested braces are balanced, two formulas: ' + box.getErr());
h = fmt('\\pu{5 mol/L}');
ok(count(h) === 1 && !box.getErr(), '\\pu');
h = fmt('$\\ce{H2O}$ і $x^2$');
ok(count(h) === 2 && !box.getErr(), 'inside $ ... $ as before');
h = fmt('\\ce{H2O');
ok(count(h) === 0 && h.includes('\\ce{H2O'), 'not closed: stays a text: ' + h);
h = fmt('\\cell{x} \\ceil');
ok(count(h) === 0, 'other commands that start with ce are not touched: ' + h);
h = fmt('a \\$ b \\ce{H2O}');
ok(count(h) === 1 && h.includes('$'), 'an escaped dollar stays a dollar');
h = fmt('Текст без хімії');
ok(count(h) === 0, 'a plain text');
console.log('tableEditor.chem: ' + n + ' checks passed');
