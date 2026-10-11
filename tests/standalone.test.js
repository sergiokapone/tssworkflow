'use strict';
/* Tests of the build plan of a document on its own (workspacePure.standalonePlan) and of the \documentclass check that
 * decides when the button is shown. Run from the repository root: node tests/standalone.test.js [extension] */
const assert = require('assert');
const path = require('path');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const W = require(path.join(EXT, 'workspacePure.js'));

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const sep = path.sep;
const p = (...a) => a.join(sep);

// in the folder of the file (default): the file is given by its name, the job is named after it
let r = W.standalonePlan(p('', 'proj', 'Optics', 'lab.tex'), p('', 'proj'), {});
eq(r.cwd, p('', 'proj', 'Optics'));
eq(r.job, 'lab');
eq(r.args, ['-g', '-lualatex', '-interaction=nonstopmode', '-synctex=1', '-file-line-error', '-shell-escape', 'lab.tex']);

// in the workspace folder: the relative path is given, the output goes to the folder of the workspace
r = W.standalonePlan(p('', 'proj', 'Optics', 'lab.tex'), p('', 'proj'), { workDir: 'workspace' });
eq(r.cwd, p('', 'proj'));
eq(r.args[r.args.length - 1], p('Optics', 'lab.tex'));
eq(r.job, 'lab');

// a file outside any workspace folder is built in its own folder even with workDir = workspace
r = W.standalonePlan(p('', 'tmp', 'x.tex'), null, { workDir: 'workspace' });
eq(r.cwd, p('', 'tmp'));
eq(r.args[r.args.length - 1], 'x.tex');

// engines, force rebuild, names with spaces and dots
eq(W.standalonePlan(p('', 'a', 'b.tex'), null, { engine: 'pdflatex' }).args[1], '-pdf');
eq(W.standalonePlan(p('', 'a', 'b.tex'), null, { engine: 'xelatex' }).args[1], '-xelatex');
eq(W.standalonePlan(p('', 'a', 'b.tex'), null, { engine: 'nonsense' }).args[1], '-lualatex');
eq(W.standalonePlan(p('', 'a', 'b.tex'), null, { force: false }).args[0], '-lualatex');
r = W.standalonePlan(p('', 'a', 'my doc.v2.tex'), null, {});
eq(r.job, 'my doc.v2');
eq(r.args[r.args.length - 1], 'my doc.v2.tex');

// the button: only a document with its own preamble
eq(W.hasDocumentClass('\\documentclass{article}\n\\begin{document}\\end{document}'), true);
eq(W.hasDocumentClass('\\documentclass[a4paper]{book}'), true);
eq(W.hasDocumentClass('\\section{A}\ntext'), false);
eq(W.hasDocumentClass('% \\documentclass{article}\n\\section{A}'), false, 'a comment');
eq(W.hasDocumentClass('\\begin{verbatim}\n\\documentclass{x}\n\\end{verbatim}'), false, 'verbatim');
eq(W.isPackageFile('Book.cls'), true);
eq(W.isPackageFile('lab.tex'), false);

// 0.16.0: the number of LaTeX runs (compilePasses.*), plain runs and the steps of a build
eq([W.resolvePasses('main', {}), W.resolvePasses('separate', {}), W.resolvePasses('chapter', {})], [4, 2, 1], 'the defaults: 4 / 2 / 1');
eq([W.resolvePasses('main', { explicit: 6 }), W.resolvePasses('separate', { explicit: 1 }), W.resolvePasses('chapter', { explicit: 3 })], [6, 1, 3], 'set by the user');
eq([W.resolvePasses('main', { explicit: 0 }), W.resolvePasses('chapter', { explicit: 0 })], [0, 0], '0: latexmk decides');
eq([W.resolvePasses('main', { explicit: 99 }), W.resolvePasses('main', { explicit: -4 }), W.resolvePasses('main', { explicit: 'x' })], [9, 0, 0], 'out of range or not a number is brought into 0..9');
eq(W.resolvePasses('chapter', { singlePass: false, passes: 3 }), 3, 'the old singlePass = false, passes = 3 still works for a chapter');
eq(W.resolvePasses('chapter', { singlePass: false, passes: 0 }), 1, 'the old passes = 0 is the default now');
eq(W.resolvePasses('chapter', { singlePass: true, passes: 5 }), 1, 'singlePass = true: one run');
eq(W.resolvePasses('chapter', { explicit: 2, singlePass: false, passes: 5 }), 2, 'the new key wins');
eq(W.resolvePasses('main', { singlePass: false, passes: 5 }), 4, 'the old keys do not touch the main file');
eq(W.plainFromLatexmk(['-g', '-lualatex', '-interaction=nonstopmode', 'a.tex']), { exe: 'lualatex', args: ['-interaction=nonstopmode', 'a.tex'] }, 'latexmk -> lualatex');
eq(W.plainFromLatexmk(['-pdf', 'a.tex']), { exe: 'pdflatex', args: ['a.tex'] }, 'the engine flag gives the program');
eq(W.plainFromLatexmk(['-xelatex', 'a.tex']).exe, 'xelatex');
eq(W.plainFromLatexmk(['a.tex'], 'lualatex5').exe, 'lualatex5', 'no flag: the given program');
const lt = W.buildSteps({ exe: 'lualatex', args: ['a.tex'], n: 4, tools: true, job: 'a' });
eq(lt.map((x) => x.exe + (x.tex ? '*' : '')), ['lualatex*', 'biber', 'bibtex', 'lualatex*', 'lualatex*', 'lualatex*'], 'four runs and the tools after the first');
eq(W.buildSteps({ exe: 'l', args: [], n: 3, tools: false }).length, 3, 'a chapter: only runs');
eq(W.buildSteps({ exe: 'l', args: [], n: 1, tools: true, job: 'a' }).length, 1, 'one run: no tools');
eq(W.buildSteps({ exe: 'l', args: [], n: 99, tools: false }).length, 9, 'at most 9');
eq(W.buildSteps({ exe: 'l', args: ['x'], n: 2, tools: true, job: 'a', biber: '/x/biber', bibtex: 'bib' }).map((x) => x.exe), ['l', '/x/biber', 'bib', 'l'], 'the programs of the tools');
{
  const files = {};
  const io = { exists: (f) => f in files, read: (f) => files[f] };
  const [, biber, bibtex] = lt;
  eq([W.stepApplies(biber, io), W.stepApplies(bibtex, io)], [false, false], 'no .bcf, no .aux: no tools');
  files['a.bcf'] = 'x';
  eq([W.stepApplies(biber, io), W.stepApplies(bibtex, io)], [true, false], '.bcf: biber, not bibtex');
  delete files['a.bcf']; files['a.aux'] = '\\relax\n\\bibdata{lit}\n';
  eq([W.stepApplies(biber, io), W.stepApplies(bibtex, io)], [false, true], 'the .aux has \\bibdata: bibtex');
  files['a.aux'] = '\\relax\n';
  eq(W.stepApplies(bibtex, io), false, 'an .aux without \\bibdata');
  eq(W.stepApplies(lt[0], io), true, 'a run of the engine has no condition');
}

console.log('standalone: ' + n + ' checks passed');
