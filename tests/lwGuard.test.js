'use strict';
// node tests/lwGuard.test.js [path/to/extension]
// lwGuardPure.js: the list of processes (ps, PowerShell) and the match of a running TeX build with the job that is about to start.
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || require('./_ext'));
const G = require(path.join(ext, 'lwGuardPure.js'));
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const LINUX = { cwd: '/home/u/book', folder: '/home/u/book', job: 'main', scope: 'job', platform: 'linux' };
// what the default recipe of LaTeX Workshop starts: the absolute path of the root file, without the extension
const LW_LINUX = '/usr/bin/perl /usr/bin/latexmk -synctex=1 -interaction=nonstopmode -file-line-error -lualatex -outdir=/home/u/book "/home/u/book/main"';

t('ps output: pid and the whole command line; empty and broken lines are skipped', () => {
  const r = G.parsePs('  101 /usr/bin/perl /usr/bin/latexmk -g "/home/u/book/main"\n\n   7 sh\nnot a line\n 42   lualatex   main.tex  \n');
  assert.deepStrictEqual(r.map((x) => x.pid), [101, 7, 42]);
  assert.strictEqual(r[2].args, 'lualatex   main.tex');
  assert.deepStrictEqual(G.parsePs(''), []);
  assert.deepStrictEqual(G.parsePs(null), []);
});

t('PowerShell JSON: nothing, one object, an array, a null command line, garbage', () => {
  assert.deepStrictEqual(G.parseCim(''), []);
  assert.deepStrictEqual(G.parseCim('  \n'), []);
  assert.strictEqual(G.parseCim('Get-CimInstance : access denied'), null, 'unreadable output is "unknown", not "nothing runs"');
  const one = G.parseCim(JSON.stringify({ ProcessId: 5, Name: 'latexmk.exe', CommandLine: 'latexmk.exe x' }));
  assert.deepStrictEqual(one, [{ pid: 5, args: 'latexmk.exe x', name: 'latexmk.exe' }]);
  const many = G.parseCim(JSON.stringify([{ ProcessId: 1, Name: 'a', CommandLine: null }, { ProcessId: 2, Name: 'b', CommandLine: 'b c' }]));
  assert.deepStrictEqual(many.map((x) => [x.pid, x.args]), [[1, ''], [2, 'b c']]);
});

t('programOf: path and extension are dropped; perl / sh / env wrappers are looked through; quoted program with spaces', () => {
  assert.strictEqual(G.programOf('/usr/bin/perl /usr/bin/latexmk -g main.tex'), 'latexmk');
  assert.strictEqual(G.programOf('perl -w /usr/bin/latexmk main.tex'), 'latexmk');
  assert.strictEqual(G.programOf('env FOO=1 pdflatex main.tex'), 'pdflatex');
  assert.strictEqual(G.programOf('"C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe" -g "C:\\p\\main"'), 'latexmk');
  assert.strictEqual(G.programOf('C:\\texlive\\2025\\bin\\windows\\lualatex.EXE main.tex'), 'lualatex');
  assert.strictEqual(G.programOf('/usr/bin/code /home/u/book/main.tex'), 'code');
  assert.strictEqual(G.programOf(''), '');
});

t('LaTeX Workshop builds the same job: found, with the pid', () => {
  const procs = G.parsePs(' 101 ' + LW_LINUX + '\n 102 lualatex -interaction=nonstopmode main.tex\n');
  const f = G.findBusy(procs, LINUX);
  assert.deepStrictEqual(f.map((x) => [x.pid, x.program]), [[101, 'latexmk']], 'the engine child has a relative name and is not needed: its parent lives as long as the build');
});

t('another job, another folder, a name that only starts like the job: not found', () => {
  const procs = G.parsePs(' 1 ' + LW_LINUX + '\n');
  assert.deepStrictEqual(G.findBusy(procs, Object.assign({}, LINUX, { job: 'alone' })), [], 'LaTeX Workshop builds main, we build alone: other .aux / .pdf');
  assert.deepStrictEqual(G.findBusy(procs, Object.assign({}, LINUX, { job: 'mai' })), [], 'main is not mai');
  assert.deepStrictEqual(G.findBusy(G.parsePs(' 1 latexmk -pdf "/home/u/book/main2"\n'), LINUX), [], 'main2 is not main');
  assert.deepStrictEqual(G.findBusy(procs, Object.assign({}, LINUX, { cwd: '/home/u/other', folder: '/home/u/other' })), [], 'another project');
  assert.deepStrictEqual(G.findBusy(G.parsePs(' 1 latexmk -pdf "/home/u/book-old/main"\n'), LINUX), [], 'book-old is not book');
});

t('the extension of the root file after the path does not matter: main.tex, main.pdf, a quote, the end of the line', () => {
  for (const tail of ['/home/u/book/main.tex', '"/home/u/book/main.tex"', '"/home/u/book/main"', '/home/u/book/main', "'/home/u/book/main'"]) {
    const procs = G.parsePs(' 9 latexmk -lualatex ' + tail + '\n');
    assert.strictEqual(G.findBusy(procs, LINUX).length, 1, tail);
  }
});

t('scope "project": a build of any file under the folder counts; scope "job" does not', () => {
  const procs = G.parsePs(' 3 latexmk -pdf "/home/u/book/Ch1/Ch1"\n');
  assert.strictEqual(G.findBusy(procs, LINUX).length, 0);
  assert.strictEqual(G.findBusy(procs, Object.assign({}, LINUX, { scope: 'project' })).length, 1);
  assert.strictEqual(G.findBusy(G.parsePs(' 3 latexmk -pdf "/home/u/book-old/x"\n'), Object.assign({}, LINUX, { scope: 'project' })).length, 0);
});

t('a separate file in a subfolder: its own job and folder', () => {
  const want = { cwd: '/home/u/book/Note', folder: '/home/u/book', job: 'note', scope: 'job', platform: 'linux' };
  assert.strictEqual(G.findBusy(G.parsePs(' 4 pdflatex -synctex=1 "/home/u/book/Note/note"\n'), want).length, 1);
  assert.strictEqual(G.findBusy(G.parsePs(' 4 ' + LW_LINUX + '\n'), want).length, 0, 'main of the project does not block the note');
});

t('programs that are not TeX builds are ignored, even with the path in the command line (editor, grep); a shell that runs latexmk is a build', () => {
  const procs = G.parsePs(' 1 code /home/u/book/main.tex\n 2 vim /home/u/book/main\n 3 grep /home/u/book/main\n');
  assert.deepStrictEqual(G.findBusy(procs, LINUX), []);
  const wrapped = G.findBusy(G.parsePs(' 4 /bin/bash -c latexmk "/home/u/book/main"\n'), LINUX);
  assert.deepStrictEqual(wrapped.map((x) => [x.pid, x.program]), [[4, 'latexmk']], 'sh -c latexmk ... is the build behind a wrapper');
  assert.deepStrictEqual(G.findBusy(G.parsePs(' 5 /bin/bash -c "vim /home/u/book/main"\n'), LINUX), [], 'a shell around an editor is not');
});

t('our own process id is never a match', () => {
  const procs = G.parsePs(' 555 latexmk -pdf "/home/u/book/main"\n');
  assert.strictEqual(G.findBusy(procs, Object.assign({}, LINUX, { selfPids: [555] })).length, 0);
  assert.strictEqual(G.findBusy(procs, Object.assign({}, LINUX, { selfPids: [1] })).length, 1);
});

t('Linux paths are case-sensitive, Windows and macOS are not', () => {
  const procs = G.parsePs(' 1 latexmk -pdf "/Home/U/Book/Main"\n');
  assert.strictEqual(G.findBusy(procs, LINUX).length, 0, 'linux: another path');
  assert.strictEqual(G.findBusy(procs, Object.assign({}, LINUX, { platform: 'darwin' })).length, 1);
  assert.strictEqual(G.findBusy(procs, Object.assign({}, LINUX, { platform: 'win32' })).length, 1);
});

t('Windows: backslashes, a drive letter, spaces in the path, a quoted program; a null command line is skipped', () => {
  const json = JSON.stringify([
    { ProcessId: 7, Name: 'latexmk.exe', CommandLine: '"C:\\texlive\\2025\\bin\\windows\\latexmk.exe" -synctex=1 -lualatex -outdir="C:\\Users\\Me\\My Book" "C:\\Users\\Me\\My Book\\main"' },
    { ProcessId: 8, Name: 'luahbtex.exe', CommandLine: null },
    { ProcessId: 9, Name: 'texlab.exe', CommandLine: 'texlab.exe C:\\Users\\Me\\My Book\\main' }
  ]);
  const want = { cwd: 'C:\\Users\\Me\\My Book', folder: 'C:\\Users\\Me\\My Book', job: 'main', scope: 'job', platform: 'win32' };
  const f = G.findBusy(G.parseCim(json), want);
  assert.deepStrictEqual(f.map((x) => [x.pid, x.program]), [[7, 'latexmk']]);
  assert.strictEqual(G.findBusy(G.parseCim(json), Object.assign({}, want, { cwd: 'c:/users/me/my book', folder: 'c:/users/me/my book' })).length, 1, 'slashes and case');
});

t('a job or a folder with regexp characters does not break the match', () => {
  const want = { cwd: '/home/u/a+b (1)', folder: '/home/u/a+b (1)', job: 'ma.in[1]', scope: 'job', platform: 'linux' };
  assert.strictEqual(G.findBusy(G.parsePs(' 1 latexmk "/home/u/a+b (1)/ma.in[1]"\n'), want).length, 1);
  assert.strictEqual(G.findBusy(G.parsePs(' 1 latexmk "/home/u/a+b (1)/maXin[1]"\n'), want).length, 0);
});

t('empty folder or job: nothing is matched (a command line that cannot be attributed never blocks)', () => {
  const procs = G.parsePs(' 1 latexmk "/home/u/book/main"\n');
  assert.deepStrictEqual(G.findBusy(procs, { cwd: '', folder: '', job: 'main', scope: 'job', platform: 'linux' }), []);
  assert.deepStrictEqual(G.findBusy(procs, { cwd: '/home/u/book', folder: '/home/u/book', job: '', scope: 'job', platform: 'linux' }), []);
  assert.deepStrictEqual(G.findBusy(null, LINUX), []);
});

t('describe: one process with its pid, several with their number', () => {
  assert.strictEqual(G.describe([{ pid: 7, program: 'latexmk' }], 'main'), 'зараз збирає «main» (latexmk, PID 7)');
  assert.strictEqual(G.describe([{ pid: 7, program: 'latexmk' }, { pid: 8, program: 'biber' }], 'main'), 'зараз збирає «main» (latexmk, biber, процесів: 2)');
});

t('listCommand: ps on Linux and macOS, PowerShell without a single double quote on Windows', () => {
  assert.deepStrictEqual(G.listCommand('linux').args, ['-eo', 'pid=,command=']);
  assert.deepStrictEqual(G.listCommand('darwin').args, ['-axo', 'pid=,command=']);
  const w = G.listCommand('win32');
  assert.strictEqual(w.cmd, 'powershell.exe');
  const script = w.args[w.args.length - 1];
  assert.ok(!script.includes('"'), 'nothing to escape on the way through the command line');
  assert.ok(/Get-CimInstance Win32_Process/.test(script) && /ConvertTo-Json/.test(script));
  assert.ok(w.args.includes('-NoProfile') && w.args.includes('-NonInteractive'));
  assert.strictEqual(w.parse, G.parseCim);
  assert.strictEqual(G.listCommand('linux').parse, G.parsePs);
});

for (const [name, fn] of tests) { fn(); n++; console.log('ok  ' + name); }
console.log('\n' + n + ' tests passed');
