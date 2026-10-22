'use strict';
/* webviewI18n.js: the texts of a page of a webview (media/<panel>/webview.js) in the language of the extension (i18n.js).
 * The page is a separate program: it cannot require i18n.js. So the host puts a JSON block into the HTML (<script type="application/json" id="tss-i18n">: it is not executed,
 * the policy of the page does not touch it), and the page asks for a text with T('Український текст {0}', arg) (media/common/i18n.js).
 *   keysOf(jsText)    the Ukrainian texts of the T('...') calls of a script: the keys;
 *   dictionary(jsText) { key: text in the language of the moment } (the {0}, {1} stay: the page fills them);
 *   block(files)      the HTML block for the scripts (absolute paths) of a page.
 * Everything that the page shows goes through T(...) or is sent by the host (and translated there with tr). tests/i18n.test.js checks that every key has an English text. */
const fs = require('fs');
const { tr } = require('./i18n');

const T_RE = /(?<![\w.$])T\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g; // a single- or a double-quoted literal

function keysOf(jsText) {
  const out = [];
  for (const m of String(jsText).matchAll(T_RE)) {
    let k;
    try { k = Function('return ' + m[1])(); } catch (e) { continue; }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function dictionary(jsText) {
  const d = {};
  for (const k of keysOf(jsText)) d[k] = tr(k);
  return d;
}

const cache = new Map(); // path -> the keys (the scripts do not change while the extension runs)
function block(files) {
  const d = {};
  for (const f of files) {
    if (!cache.has(f)) { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { /* no script: no texts */ } cache.set(f, keysOf(t)); }
    for (const k of cache.get(f)) d[k] = tr(k);
  }
  if (!Object.keys(d).length) return ''; // a page that asks for no texts needs neither the block nor the helper
  // < > & as \u escapes: nothing in a text can close the block or start a comment
  const json = JSON.stringify(d).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return '<script type="application/json" id="tss-i18n">' + json + '</script>';
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); // a text of the host inside the HTML of a page

module.exports = { keysOf, dictionary, block, esc, T_RE };
