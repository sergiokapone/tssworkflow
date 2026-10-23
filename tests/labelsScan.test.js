'use strict';
// node tests/labelsScan.test.js [path/to/extension]
// 0.22.0: scanLabelsAndRefs ignores labels and references in listings (verbatim, lstlisting, minted, comment) and in \iffalse ... \fi
// (the \else branch is live); a duplicate label points to its other definitions (relatedInformation of the diagnostic).
const assert = require('assert'), path = require('path'), Module = require('module');
const EXT = path.resolve(process.argv[2] || require('./_ext'));
const P = require(path.join(EXT, 'corePure'));
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } };
const names = (text) => P.scanLabelsAndRefs(text, 'f').labels.map((l) => l.name);
const refs = (text) => P.scanLabelsAndRefs(text, 'f').refs.map((r) => r.name);

t('verbatim, lstlisting, minted and comment: a label there is text', () => {
  for (const env of ['verbatim', 'Verbatim*', 'lstlisting', 'minted', 'comment', 'tcblisting']) {
    const tx = '\\label{a}\n\\begin{' + env + '}\n\\label{in}\nsee \\ref{inref}\n\\end{' + env + '}\n\\label{b}\n\\ref{outref}';
    assert.deepStrictEqual(names(tx), ['a', 'b'], env);
    assert.deepStrictEqual(refs(tx), ['outref'], env);
  }
  // the usual environments are not affected
  assert.deepStrictEqual(names('\\begin{figure}\n\\label{pic:x}\n\\end{figure}'), ['pic:x']);
});

t('\\iffalse ... \\fi: skipped; \\else branch live; nested conditions; the text after \\fi is live', () => {
  assert.deepStrictEqual(names('\\iffalse\n\\label{a}\n\\fi\n\\label{b}'), ['b']);
  assert.deepStrictEqual(names('\\iffalse\n\\label{a}\n\\else\n\\label{c}\n\\fi\n\\label{d}'), ['c', 'd']);
  assert.deepStrictEqual(names('\\iffalse\n\\ifx a b\n\\label{x}\n\\fi\n\\label{a}\n\\fi\n\\label{b}'), ['b']);
  // an \else of a nested condition does not end the \iffalse
  assert.deepStrictEqual(names('\\iffalse\n\\ifx a b\n\\else\n\\label{x}\n\\fi\n\\label{y}\n\\fi\n\\label{z}'), ['z']);
  // \iftrue and other conditions are not skipped
  assert.deepStrictEqual(names('\\iftrue\n\\label{a}\n\\fi\n\\ifdraft\n\\label{b}\n\\fi'), ['a', 'b']);
  // a commented \iffalse does nothing
  assert.deepStrictEqual(names('% \\iffalse\n\\label{a}'), ['a']);
  assert.deepStrictEqual(refs('\\iffalse\n\\ref{no}\n\\fi\n\\ref{yes}'), ['yes']);
});

t('a duplicate label: the diagnostic lists the other definitions, and a change of them is a change of the entry', () => {
  const orig = Module._load;
  class Range { constructor(a, b, c, d) { this.s = [a, b]; this.e = [c, d]; } }
  class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
  const stub = { Diagnostic, Range, Uri: { file: (f) => ({ fsPath: f }) }, Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    DiagnosticRelatedInformation: class { constructor(location, message) { this.location = location; this.message = message; } } };
  Module._load = function (req, ...r) { return req === 'vscode' ? stub : orig.call(this, req, ...r); };
  try {
    const PI = require(path.join(EXT, 'projectIndex'));
    const sets = [];
    const coll = { set: (u, d) => sets.push([u.fsPath, d]), delete() {}, clear() {} };
    const S = PI.diagSetter(coll);
    const entry = (rel) => ({ line: 1, col: 9, len: 1, message: 'dup', severity: 0, code: 'label-duplicate', related: rel, relKey: rel.map((r) => r.file + ':' + r.line + ':' + r.col).join('|') });
    const a = [{ file: '/p/B.tex', line: 4, col: 7, len: 1, message: 'other' }];
    S.set(new Map([['/p/A.tex', [entry(a)]]]));
    assert.strictEqual(sets.length, 1);
    const d = sets[0][1][0];
    assert.strictEqual(d.relatedInformation.length, 1);
    assert.strictEqual(d.relatedInformation[0].location.uri.fsPath, '/p/B.tex');
    assert.deepStrictEqual(d.relatedInformation[0].location.range.s, [4, 7]);
    S.set(new Map([['/p/A.tex', [entry(a.slice())]]]));
    assert.strictEqual(sets.length, 1, 'the same entries: nothing is rewritten');
    S.set(new Map([['/p/A.tex', [entry([{ file: '/p/C.tex', line: 4, col: 7, len: 1, message: 'other' }])]]]));
    assert.strictEqual(sets.length, 2, 'the other definition moved to another file: the entry is rewritten');
  } finally { Module._load = orig; }
});

console.log('labelsScan: ' + n + ' checks passed');
