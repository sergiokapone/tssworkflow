'use strict';
// node tests/lint.test.js [path/to/extension]  - ESLint over the extension: undefined names, unused variables, unreachable code (skipped without eslint)
const path = require('path'), assert = require('assert'), { spawnSync } = require('child_process');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
let bin;
try { bin = path.join(path.dirname(require.resolve('eslint/package.json', { paths: [process.cwd(), __dirname, path.join(__dirname, '..')] })), 'bin', 'eslint.js'); }
catch (e) { console.log('skip: eslint is not installed (npm i -D eslint)'); process.exit(0); }
const r = spawnSync(process.execPath, [bin, '-c', path.join(__dirname, 'eslint.config.js'), '--no-warn-ignored', '--format', 'json', '.'], { cwd: ext, encoding: 'utf8', maxBuffer: 1 << 26 });
let res;
try { res = JSON.parse(r.stdout); } catch (e) { assert.fail('eslint failed to run:\n' + r.stderr + r.stdout.slice(0, 500)); }
assert.ok(res.length > 20, 'eslint looked at only ' + res.length + ' files');
const found = [];
for (const f of res) for (const m of f.messages) found.push(path.relative(ext, f.filePath) + ':' + m.line + '  ' + m.ruleId + '  ' + m.message);
assert.deepStrictEqual(found, [], 'eslint findings');
console.log('ok  eslint: ' + res.length + ' files, no findings');
console.log('\n1 tests passed');
