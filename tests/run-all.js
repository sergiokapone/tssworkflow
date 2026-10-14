'use strict';
// node tests/run-all.js [path/to/extension] [LaTeX-VSCode-setup.md]
// Runs every *.test.js of this folder; prints a one-line summary and exits with 1 on a failure.
const { spawnSync } = require('child_process');
const path = require('path'), fs = require('fs');
const here = __dirname;
const ext = path.resolve(process.argv[2] || path.join(here, '..', 'vsix', 'extension'));
const docName = 'LaTeX-VSCode-setup.md';
const docCandidates = [process.argv[3], path.join(here, docName), path.join(here, '..', docName)].filter(Boolean).map((p) => path.resolve(p));
const doc = docCandidates.find((p) => fs.existsSync(p)) || null;
const files = fs.readdirSync(here).filter((f) => /\.test\.js$/.test(f)).sort();
// every test gets the extension folder and, when it is found, the reference (only docs.test.js reads it)
const jobs = files.map((f) => ({ name: f, args: [path.join(here, f), ext].concat(doc ? [doc] : []) }));
// the reference is checked against package.json and the files by docs.test.js (the old check-docs.js is not needed; docs.test.js says itself when the reference is not found)
if (!doc) console.log('SKIP  docs.test.js                   (довідку ' + docName + ' не знайдено: передай шлях третім аргументом)');
let failed = 0;
for (const j of jobs) {
  const r = spawnSync(process.execPath, j.args, { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const last = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  if (r.status === 0) console.log('PASS  ' + j.name.padEnd(34) + last);
  else { failed++; console.log('FAIL  ' + j.name + '\n' + out.split('\n').map((l) => '      ' + l).join('\n')); }
}
console.log(failed ? '\n' + failed + ' of ' + jobs.length + ' failed' : '\nall ' + jobs.length + ' passed');
process.exit(failed ? 1 : 0);
