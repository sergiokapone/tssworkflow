'use strict';
// node tests/typecheck.test.js [path/to/extension]  - tsc -p . over the modules of the extension (tsconfig.json: checkJs, no emit);
// skipped when typescript is not installed (npm i), so that the tests run without the dev dependencies too
const path = require('path'), fs = require('fs'), assert = require('assert');
const { spawnSync } = require('child_process');
const ext = path.resolve(process.argv[2] || require('./_ext'));
let tsc;
try { tsc = require.resolve('typescript/bin/tsc', { paths: [ext, process.cwd(), __dirname, path.join(__dirname, '..')] }); }
catch (e) { require('./_skip')('typescript is not installed (npm ci)'); }
if (!fs.existsSync(path.join(ext, 'tsconfig.json'))) { console.log('skip: no tsconfig.json in ' + ext); process.exit(0); }
const r = spawnSync(process.execPath, [tsc, '-p', ext], { encoding: 'utf8', cwd: ext });
const out = ((r.stdout || '') + (r.stderr || '')).trim();
assert.strictEqual(r.status, 0, 'tsc found type errors:\n' + out);
console.log('ok  tsc -p . : no type errors in ' + fs.readdirSync(ext).filter((f) => f.endsWith('.js')).length + ' modules');
console.log('\n1 tests passed');
