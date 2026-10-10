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

console.log('standalone: ' + n + ' checks passed');
