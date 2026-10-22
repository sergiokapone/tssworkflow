'use strict';
// node tests/trArgs.test.js [path/to/extension]
// 0.21.10: every tr('text {0} {1}', a, b) in the code gets as many arguments as the highest placeholder asks for, and no more
// (a forgotten or an extra argument shows "{1}" or hides a value in the message, and no other test sees it in the modules without a stub).
const assert = require('assert'), path = require('path'), fs = require('fs');
const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const bad = [];
// texts that contain braces of LaTeX code and are shown as they are, without arguments
const LITERAL_BRACES = /cell\{1-3\}\{2\}/;
let calls = 0;
for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith('.js') && x !== 'i18nEn.js' && x !== 'i18n.js')) {
  const src = fs.readFileSync(path.join(EXT, f), 'utf8');
  const re = /(?<![\w.$])tr\(\s*'((?:[^'\\\n]|\\.)*)'/g;
  let m;
  while ((m = re.exec(src))) {
    const key = m[1];
    const holes = [...key.matchAll(/\{(\d+)\}/g)].map((x) => +x[1]);
    // the arguments after the literal: top-level commas up to the closing parenthesis
    let i = re.lastIndex, depth = 0, str = null, count = 0, seen = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
      if (c === "'" || c === '"' || c === '`') { str = c; seen = true; continue; }
      if ('([{'.includes(c)) { depth++; seen = true; continue; }
      if (')]}'.includes(c)) { if (depth === 0) break; depth--; continue; }
      if (c === ',' && depth === 0) { count++; seen = false; continue; }
      if (!/\s/.test(c)) seen = true;
    }
    const nargs = count === 0 ? 0 : (seen ? count : count - 1);
    const need = holes.length ? Math.max(...holes) + 1 : 0;
    calls++;
    const line = src.slice(0, m.index).split('\n').length;
    if (holes.length && nargs < need && !LITERAL_BRACES.test(key)) bad.push(f + ':' + line + ' needs ' + need + ' arguments, has ' + nargs + ': ' + key.slice(0, 60));
    // a literal key without placeholders and with arguments would drop the arguments silently
    if (!holes.length && nargs > 0) bad.push(f + ':' + line + ' has ' + nargs + ' arguments but no placeholder: ' + key.slice(0, 60));
  }
}
assert.deepStrictEqual(bad, [], bad.join('\n'));
assert.ok(calls > 800, 'the scan found ' + calls + ' tr() calls');
console.log('trArgs: ' + calls + ' tr() calls, the arguments match the placeholders');
