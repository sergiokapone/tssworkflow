'use strict';
// node tests/tableMerge.test.js [path/to/extension]  - tableEditorPure.js: merged cells written in the body (\SetCell) and in the
// options (cell{i}{j} = {r=,c=}{…}): reading both, merging / unmerging, moving between the two places, conflicts, the guards
const path = require('path'), assert = require('assert');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const X = require(path.join(ext, 'tableEditorPure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const parse = (src) => { const env = X.locateTables(src)[0]; const r = X.parseTable(src, env); assert.ok(r.model, r.skip); return { env, model: r.model }; };
const view = (src) => X.toView(parse(src).model, new Map());
// the text of the table after one operation (the whole environment)
const run = (src, op) => { const { model } = parse(src); const r = X.applyOp(model, op); if (r.error || r.confirm) return r; return { text: X.serialize(r.model) }; };
const out = (src, op) => { const r = run(src, op); assert.ok(r.text !== undefined, JSON.stringify(r)); return r.text; };
const grid = (src) => view(src).rows.map((r) => r.cells.map((c) => [c.span, c.rowspan, c.hidden ? 'h' : '.']));
const spansOf = (src) => { const { env } = parse(src); return X.spanMap(src, env).spans.map((s) => [s.src, s.r, s.c, s.rs, s.cs].join(':')); };

const PLAIN = String.raw`\begin{tblr}{colspec={ccc}, hlines}
a & b & c \\
d & e & f \\
g & h & i \\
\end{tblr}`;

const USER = String.raw`\begin{tblr}{
	colspec={X[c,m]X[c,m]X[c,m]X[c,m]X[c,m]},
	row{odd} = {gray!10},
	row{1} = {c, m, fg=white, bg=themecolorlight, font=\bfseries},
	hlines,
	vlines
}
	\SetCell[c=2]{c} Заголовок 1 & & \SetCell[c=3]{c} Заголовок 2 & & \\
	A & B & C & D & E \\
	\SetCell[r=2]{c} Об'єднано & 1 & 2 & 3 & 4 \\
	 & 5 & 6 & 7 & 8 \\
	\SetCell[c=5]{c} Один рядок на всю ширину & & & & \\
	9 & 10 & 11 & 12 & 13 \\
\end{tblr}`;

const OPTS = String.raw`\begin{tblr}{
  colspec={ccc},
  cell{1}{1} = {c=2}{c, bg=red},
  cell{2}{3} = {r=2},
}
a & & c \\
d & e & f \\
g & h & \\
\end{tblr}`;

/* ------------------------------- reading both places ------------------------------- */
t('cell{i}{j} = {c=2}{…} in the options is read as a merged cell and drawn on its cell', () => {
  assert.deepStrictEqual(grid(OPTS), [[[2, 1, '.'], [1, 1, 'h'], [1, 1, '.']], [[1, 1, '.'], [1, 1, '.'], [1, 2, '.']], [[1, 1, '.'], [1, 1, '.'], [1, 1, 'h']]]);
  const v = view(OPTS);
  assert.ok(v.merged && v.canMerge && v.optSpans === 2);
  assert.ok(v.rows[0].cells[0].fromOpts && v.rows[1].cells[2].fromOpts && !v.rows[0].cells[2].fromOpts);
});
t('the style of cell{1}{1} = {c=2}{c, bg=red} comes from the second group', () => {
  const c = view(OPTS).rows[0].cells[0];
  assert.strictEqual(c.style.bg, 'rgb(255,0,0)');
  assert.strictEqual(c.style.align, 'c');
});
t('the user\'s table (all \\SetCell) is drawn as before: three merges, no warnings', () => {
  const v = view(USER);
  assert.deepStrictEqual(v.rows[0].cells.map((c) => [c.span, c.hidden]), [[2, false], [1, true], [3, false], [1, true], [1, true]]);
  assert.strictEqual(v.rows[2].cells[0].rowspan, 2);
  assert.deepStrictEqual(v.conflicts, []);
  assert.strictEqual(v.optSpans, 0);
});
t('selectors that are not plain numbers are not followed: a note, and no merge is drawn', () => {
  const src = String.raw`\begin{tblr}{colspec={ccc}, cell{1-2}{1} = {r=2}}
a & b & c \\
d & e & f \\
\end{tblr}`;
  assert.strictEqual(view(src).optSpans, 0);
  assert.ok(view(src).conflicts.some((m) => /складним селектором/.test(m)));
});
t('a table where only the options differ is read the same way: spanMap gives the spans and where they stand in the text', () => {
  const { env } = parse(USER);
  const map = X.spanMap(USER, env);
  assert.deepStrictEqual(map.spans.map((s) => USER.slice(...s.range)), ['\\SetCell[c=2]{c} Заголовок 1', '\\SetCell[c=3]{c} Заголовок 2', "\\SetCell[r=2]{c} Об'єднано", '\\SetCell[c=5]{c} Один рядок на всю ширину']);
  const o = parse(OPTS);
  assert.deepStrictEqual(X.spanMap(OPTS, o.env).spans.map((s) => OPTS.slice(...s.range)), ['cell{1}{1} = {c=2}{c, bg=red}', 'cell{2}{3} = {r=2}']);
});

/* ------------------------------------- merging ------------------------------------- */
t('merge: the first cell gets \\SetCell[r=,c=]{}, the others become empty', () => {
  const src = String.raw`\begin{tblr}{colspec={ccc}}
a & & \\
& & \\
\end{tblr}`;
  const o = out(src, { type: 'merge', r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.ok(/\\SetCell\[r=2,c=2\]\{\} a & &/.test(o), o);
  assert.deepStrictEqual(grid(o)[0].slice(0, 2), [[2, 2, '.'], [1, 1, 'h']]);
});
t('merge over text asks first; the answer yes (confirmed) keeps only the first cell', () => {
  const r = run(PLAIN, { type: 'merge', r1: 0, c1: 0, r2: 0, c2: 2 });
  assert.ok(/У 2 клітинках/.test(r.confirm), JSON.stringify(r));
  const o = out(PLAIN, { type: 'merge', r1: 0, c1: 0, r2: 0, c2: 2, confirmed: true });
  assert.ok(/\\SetCell\[c=3\]\{\} a & & \\\\/.test(o), o);
  assert.ok(!/ b /.test(o.split('\n')[1]) && !/ c /.test(o.split('\n')[1]));
  assert.ok(/^d & e & f/m.test(o), 'the other rows are not touched');
});
t('merge keeps what \\SetCell already says (other keys), and only changes the spans', () => {
  const src = String.raw`\begin{tblr}{colspec={ccc}}
\SetCell{bg=red} a & & \\
\end{tblr}`;
  assert.ok(/\\SetCell\[c=2\]\{bg=red\} a/.test(out(src, { type: 'merge', r1: 0, c1: 0, r2: 0, c2: 1 })));
});
t('merge: a selection that only touches a merged cell takes it whole', () => {
  const src = String.raw`\begin{tblr}{colspec={ccc}}
\SetCell[c=2]{c} a & & c \\
d & e & f \\
\end{tblr}`;
  const o = out(src, { type: 'merge', r1: 0, c1: 1, r2: 0, c2: 2, confirmed: true });
  assert.ok(/\\SetCell\[c=3\]\{c\} a/.test(o), o);
  assert.strictEqual(run(src, { type: 'merge', r1: 0, c1: 0, r2: 0, c2: 1 }).error, 'Ці клітинки вже об\'єднані.');
});
t('merge: a merge from the options inside the new one loses its span keys (the other keys of the item stay)', () => {
  const src = String.raw`\begin{tblr}{
  colspec={ccc},
  cell{1}{1} = {c=2}{bg=red},
}
a & & \\
d & e & f \\
\end{tblr}`;
  const o = out(src, { type: 'merge', r1: 0, c1: 0, r2: 1, c2: 1, confirmed: true });
  assert.ok(/cell\{1\}\{1\} = \{bg=red\},/.test(o) && /\\SetCell\[r=2,c=2\]\{\} a/.test(o), o);
  assert.deepStrictEqual(parse(o.replace(/^/, '')).model.optSpans, []);
});
t('merge is refused for tabular, for \\multicolumn in the selection, for one cell', () => {
  assert.ok(/tblr/.test(run('\\begin{tabular}{cc}\na & b \\\\\n\\end{tabular}', { type: 'merge', r1: 0, c1: 0, r2: 0, c2: 1 }).error));
  assert.ok(/multicolumn/.test(run('\\begin{tblr}{colspec={ccc}}\n\\multicolumn{2}{c}{a} & c \\\\\nd & e & f \\\\\n\\end{tblr}', { type: 'merge', r1: 0, c1: 0, r2: 1, c2: 1, confirmed: true }).error));
  assert.ok(/кілька клітинок/.test(run(PLAIN, { type: 'merge', r1: 1, c1: 1, r2: 1, c2: 1 }).error));
});
t('a bare column specification {ccc} merges too', () => {
  const o = out('\\begin{tblr}{ccc}\na & & \\\\\n\\end{tblr}', { type: 'merge', r1: 0, c1: 0, r2: 0, c2: 1 });
  assert.ok(o.startsWith('\\begin{tblr}{ccc}') && /\\SetCell\[c=2\]\{\} a/.test(o));
});

/* ------------------------------------ unmerging ------------------------------------ */
t('unmerge: the span keys go from \\SetCell, the alignment stays; an empty command goes entirely', () => {
  const o = out(USER, { type: 'unmerge', r: 0, c: 1 });
  assert.ok(/\\SetCell\{c\} Заголовок 1 & & \\SetCell\[c=3\]\{c\} Заголовок 2/.test(o), o);
  const e = out(String.raw`\begin{tblr}{colspec={ccc}}
\SetCell[c=2]{} a & & c \\
\end{tblr}`, { type: 'unmerge', r: 0, c: 0 });
  assert.ok(/\na & & c \\\\/.test(e), e);
});
t('unmerge a merge from the options: only its r= / c= go, a lone item goes entirely', () => {
  const o = out(OPTS, { type: 'unmerge', r: 0, c: 1 });
  assert.ok(/cell\{1\}\{1\} = \{c, bg=red\},/.test(o) && /cell\{2\}\{3\} = \{r=2\}/.test(o), o);
  const o2 = out(OPTS, { type: 'unmerge', list: [{ r: 1, c: 2 }, { r: 2, c: 2 }] });
  assert.ok(!/cell\{2\}\{3\}/.test(o2), o2);
  assert.ok(/немає/i.test(run(PLAIN, { type: 'unmerge', r: 0, c: 0 }).error));
});

/* --------------------------- moving between the two places --------------------------- */
t('\\SetCell -> options: the keys move too, the body is clean, the options get one item per merge', () => {
  const o = out(USER, { type: 'spansToOptions' });
  assert.ok(/\tvlines,\n\tcell\{1\}\{1\} = \{c=2\}\{c\},\n\tcell\{1\}\{3\} = \{c=3\}\{c\},\n\tcell\{3\}\{1\} = \{r=2\}\{c\},\n\tcell\{5\}\{1\} = \{c=5\}\{c\}\n\}/.test(o), o);
  assert.ok(!/SetCell/.test(o));
  assert.deepStrictEqual(spansOf(o), ['opts:0:0:1:2', 'opts:0:2:1:3', 'opts:2:0:2:1', 'opts:4:0:1:5']);
});
t('options -> \\SetCell, and back, gives the text we started with', () => {
  const to = out(USER, { type: 'spansToOptions' });
  assert.strictEqual(out(to, { type: 'spansToCells' }), USER);
});
t('one merge only (by the cell it covers); the rest stay where they are', () => {
  const o = out(USER, { type: 'spansToOptions', r: 3, c: 0 });
  assert.ok(/cell\{3\}\{1\} = \{r=2\}\{c\}/.test(o) && /\\SetCell\[c=2\]\{c\} Заголовок 1/.test(o) && !/\\SetCell\[r=2\]/.test(o), o);
  const b = out(OPTS, { type: 'spansToCells', r: 0, c: 0 });
  assert.ok(/\\SetCell\[c=2\]\{c, bg=red\} a/.test(b) && /cell\{2\}\{3\} = \{r=2\}/.test(b) && !/cell\{1\}\{1\}/.test(b), b);
});
t('the options written on one line, the options of a bare {ccc}, a trailing comma, a comment at the end', () => {
  const one = out(String.raw`\begin{tblr}{colspec={ccc}, hlines}
\SetCell[c=2]{c} a & & c \\
\end{tblr}`, { type: 'spansToOptions' });
  assert.ok(one.startsWith('\\begin{tblr}{colspec={ccc}, hlines, cell{1}{1} = {c=2}{c}}'), one);
  const bare = out('\\begin{tblr}{ccc}\n\\SetCell[c=2]{} a & & c \\\\\n\\end{tblr}', { type: 'spansToOptions' });
  assert.ok(bare.startsWith('\\begin{tblr}{colspec={ccc}, cell{1}{1} = {c=2}}'), bare);
  const comma = out('\\begin{tblr}{\n  colspec={ccc},\n  hlines,\n}\n\\SetCell[c=2]{} a & & c \\\\\n\\end{tblr}', { type: 'spansToOptions' });
  assert.ok(/hlines,\n  cell\{1\}\{1\} = \{c=2\},\n\}/.test(comma), comma);
  const com = run('\\begin{tblr}{\n  colspec={ccc}, % three\n}\n\\SetCell[c=2]{} a & & c \\\\\n\\end{tblr}', { type: 'spansToOptions' });
  assert.ok(/коментарем/.test(com.error), JSON.stringify(com));
});
t('a cell that already has \\SetCell takes only the span from the options; its other keys stay in the options', () => {
  const src = String.raw`\begin{tblr}{
  colspec={ccc},
  cell{1}{1} = {c=2}{bg=red},
}
\SetCell{c} a & & c \\
\end{tblr}`;
  const o = out(src, { type: 'spansToCells' });
  assert.ok(/cell\{1\}\{1\} = \{bg=red\},/.test(o) && /\\SetCell\[c=2\]\{c\} a/.test(o), o);
});

/* --------------------------------------- conflicts --------------------------------------- */
const DUP = String.raw`\begin{tblr}{
  colspec={ccc},
  cell{1}{1} = {c=2},
}
\SetCell[c=2]{c} a & & c \\
d & e & f \\
\end{tblr}`;
t('the same cell merged in \\SetCell and in the options is reported, and the move refuses it', () => {
  const v = view(DUP);
  assert.strictEqual(v.conflicts.length, 1);
  assert.ok(/і в \\SetCell, і в параметрах/.test(v.conflicts[0]));
  assert.ok(v.rows[0].cells[0].conflict);
  assert.ok(/спершу розв/.test(run(DUP, { type: 'spansToOptions' }).error));
});
t('conflict fixes: keep \\SetCell (the item loses its span) or keep the options (\\SetCell loses its keys)', () => {
  const a = out(DUP, { type: 'spanKeep', r: 0, c: 0, keep: 'cell' });
  assert.ok(!/cell\{1\}\{1\}/.test(a) && /\\SetCell\[c=2\]\{c\} a/.test(a), a);
  assert.deepStrictEqual(view(a).conflicts, []);
  const b = out(DUP, { type: 'spanKeep', r: 0, c: 0, keep: 'opts' });
  assert.ok(/cell\{1\}\{1\} = \{c=2\}/.test(b) && /\\SetCell\{c\} a/.test(b), b);
  assert.deepStrictEqual(view(b).conflicts, []);
});
t('overlap, a merge that leaves the table, text under a merge, two items for one cell', () => {
  const kinds = (src) => X.spanMap(src, X.locateTables(src)[0]).conflicts.map((c) => c.kind);
  assert.deepStrictEqual(kinds(String.raw`\begin{tblr}{colspec={ccc}}
\SetCell[c=2]{c} a & & c \\
d & \SetCell[r=2]{c} e & f \\
g & & i \\
\end{tblr}`), []);
  assert.deepStrictEqual(kinds(String.raw`\begin{tblr}{colspec={ccc}}
\SetCell[c=2,r=2]{c} a & & c \\
 & \SetCell[c=2]{c} & \\
\end{tblr}`), ['overlap']);
  assert.deepStrictEqual(kinds(String.raw`\begin{tblr}{colspec={ccc}}
\SetCell[r=3]{c} a & b & c \\
d & e & f \\
\end{tblr}`), ['bounds']);
  assert.deepStrictEqual(kinds(String.raw`\begin{tblr}{colspec={ccc}}
\SetCell[c=2]{c} a & text & c \\
\end{tblr}`), ['hidden']);
  assert.deepStrictEqual(kinds(String.raw`\begin{tblr}{colspec={ccc}, cell{1}{1}={c=2}, cell{1}{1}={c=3}}
a & & \\
\end{tblr}`), ['dup-same']);
});

/* --------------------------------- structure and guards --------------------------------- */
t('rows and columns: lines before a merge from the options shift its selector, lines after leave it', () => {
  assert.ok(/cell\{2\}\{1\} = \{c=2\}\{c, bg=red\}/.test(out(OPTS, { type: 'addRow', at: 0 })));
  assert.ok(/cell\{1\}\{2\} = \{c=2\}/.test(out(OPTS, { type: 'addCol', at: 0 })));
  assert.ok(/cell\{1\}\{1\} = \{c=2\}\{c, bg=red\}/.test(out(OPTS, { type: 'addRow', at: 3 })));
});
t('a line inside a merge from the options, and moving or copying it, is refused with the way out (the lightbulb)', () => {
  for (const op of [{ type: 'addRow', at: 2 }, { type: 'delRow', r: 1 }, { type: 'delRow', r: 2 }, { type: 'addCol', at: 1 }, { type: 'delCol', c: 1 }, { type: 'moveRow', r: 1, dir: 1 }, { type: 'dupRows', r1: 1, r2: 1 }, { type: 'moveCol', c: 0, dir: 1 }]) {
    const r = run(OPTS, op);
    assert.ok(r.error, JSON.stringify(op) + ' should be refused');
  }
  assert.ok(/лампочка/.test(run(OPTS, { type: 'addRow', at: 2 }).error));
});
t('deleting the row of a merge from the options takes the whole item with it, the second group too', () => {
  const o = out(String.raw`\begin{tblr}{
  colspec={ccc},
  cell{1}{1} = {c=2}{c, bg=red},
  cell{2}{1} = {c=2}{c},
}
a & & c \\
d & & f \\
\end{tblr}`, { type: 'delRow', r: 1 });
  assert.ok(/cell\{1\}\{1\} = \{c=2\}\{c, bg=red\},\n\}/.test(o) && !/\{c\}\s*,?\s*\{c\}/.test(o) && !/cell\{2\}/.test(o), o);
});
t('\\SetCell merges still grow and shrink with the lines (as before)', () => {
  const o = out(USER, { type: 'addCol', at: 1 });
  assert.ok(/\\SetCell\[c=3\]\{c\} Заголовок 1/.test(o), o);
  const d = out(USER, { type: 'delRow', r: 3 });
  assert.ok(/\\SetCell\[r=1\]\{c\} Об'єднано/.test(d), d);
});

console.log('\n' + n + ' tests passed');
