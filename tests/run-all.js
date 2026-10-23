'use strict';
// node tests/run-all.js [path/to/extension] [LaTeX-VSCode-setup.md]
// Runs every *.test.js of this folder; prints a one-line summary and exits with 1 on a failure.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const here = __dirname;
const ext = path.resolve(process.argv[2] || require('./_ext'));
const docName = 'LaTeX-VSCode-setup.md';
const docCandidates = [process.argv[3], path.join(here, docName), path.join(here, '..', docName)].filter(Boolean).map((p) => path.resolve(p));
const doc = docCandidates.find((p) => fs.existsSync(p)) || null;
const files = fs.readdirSync(here).filter((f) => /\.test\.js$/.test(f)).sort();
// every test gets the extension folder and, when it is found, the reference (only docs.test.js reads it)
const jobs = files.map((f) => ({ name: f, args: [path.join(here, f), ext].concat(doc ? [doc] : []) }));
// the reference is checked against package.json and the files by docs.test.js (the old check-docs.js is not needed; docs.test.js says itself when the reference is not found)
if (!doc) console.log('SKIP  docs.test.js                   (довідку ' + docName + ' не знайдено: передай шлях третім аргументом)');
// the files run in parallel (TSS_JOBS=1: one by one, as before); the report keeps the alphabetical order
const width = Math.max(1, Number(process.env.TSS_JOBS) || Math.min(8, require('os').cpus().length));
function runJob(j) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, j.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ status: 1, out: out + String(e) }));
    child.on('close', (status) => resolve({ status, out }));
  });
}
(async () => {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; results[i] = await runJob(jobs[i]); } };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
  let failed = 0;
  jobs.forEach((j, i) => {
    const { status, out } = results[i];
    const last = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    if (status === 0) console.log('PASS  ' + j.name.padEnd(34) + last);
    else { failed++; console.log('FAIL  ' + j.name + '\n' + out.split('\n').map((l) => '      ' + l).join('\n')); }
  });
  console.log(failed ? '\n' + failed + ' of ' + jobs.length + ' failed' : '\nall ' + jobs.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
