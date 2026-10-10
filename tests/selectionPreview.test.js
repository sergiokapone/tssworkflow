'use strict';
/* Tests of selectionPreviewPure.render (the LaTeX fragment as safe HTML). Run: node tests/selectionPreview.test.js [extension] */
const assert = require('assert');
const path = require('path');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const P = require(path.join(EXT, 'selectionPreviewPure.js'));

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const R = (s, o) => P.render(s, o);
const html = (s, o) => R(s, o).html;
const COLORS = require(path.join(EXT, 'tableEditorPure.js')).colorDefs(['\\definecolor{brand}{RGB}{1,2,3}']);
const has = (s, frag, m, o) => ok(html(s, o).includes(frag), (m || s) + ' -> ' + html(s, o));

// text commands
has('\\textbf{a} \\emph{b} \\textit{c} \\underline{d} \\texttt{e}', '<b>a</b> <em>b</em> <i>c</i> <u>d</u> <code>e</code>');
has('\\textbf{a \\emph{b} c}', '<b>a <em>b</em> c</b>', 'nested');
has('{\\bfseries x} y', '<b>x</b> y', 'a declaration lasts to the end of its group');
has('a~b -- c --- d', 'a&nbsp;b – c — d');
has('``q\'\' \\% \\& \\_ \\# \\$', '“q” % &amp; _ # $');
has('\\ldots{} \\LaTeX{}', '… LaTeX');
has('\\ldots \\LaTeX', '…LaTeX', 'a space after a control word is not printed, as in TeX');
has('x\\\\y', 'x<br>y');
has('a\n\nb', '<p>a</p><p>b</p>', 'paragraphs');
has('a\nb', '<p>a b</p>', 'a line break is a space');
has('\\enquote{x}', '«x»');
has('\\textcolor{red}{x}', '<span style="color:red">x</span>');
has('\\textcolor{brand}{x}', '<span style="color:rgb(1,2,3)">x</span>', 'project colour', { colors: COLORS });
has('\\textcolor{brand}{x}', '<p>x</p>', 'unknown colour: plain text');

// comments
eq(P.stripComments('a % c\n   b'), 'a b\n', 'the comment swallows the line break and the indentation of the next line');
eq(P.stripComments('a\n  b'), 'a\n  b\n', 'lines without comments stay');
has('abc % hidden\n\ndef', '<p>abc</p><p>def</p>', 'a blank line after a comment still ends the paragraph');
has('100\\% sure', '100% sure', '\\% is not a comment');
ok(!html('x % \\textbf{no}').includes('<b>'), 'a comment is dropped');
has('a%\n   b', '<p>ab</p>', 'a comment joins the lines');

// formulas
has('so $E = mc^2$ here', '<span class="m" data-d="0" data-tex="E = mc^2"></span>');
has('so \\(a+b\\) here', 'data-tex="a+b"');
has('\\[ x^2 \\]', '<div class="dm"><span class="m" data-d="1" data-tex="x^2"></span></div>');
has('$$y$$', '<div class="dm"><span class="m" data-d="1" data-tex="y"></span></div>');
has('\\begin{equation}\\label{e:1} a=b \\end{equation}', 'data-tex="a=b"', '\\label removed');
has('\\begin{align} a&=b \\\\ c&=d \\end{align}', 'data-tex="\\begin{aligned} a&amp;=b \\\\ c&amp;=d \\end{aligned}"');
has('\\begin{equation*} \\vect{F} \\end{equation*}', 'data-tex="\\vect{F}"', 'project macros are left for KaTeX');
has('$\\begin{pmatrix}1&2\\end{pmatrix}$ ok', 'data-tex="\\begin{pmatrix}1&amp;2\\end{pmatrix}"', 'an environment inside $...$ is part of the formula');
ok(html('\\begin{equation}x\\end{equation}').split('class="m"').length === 2, 'one formula');

// structure
has('\\section{A}', '<h2 class="sec">A</h2>');
has('\\subsection*{B}', '<h3 class="sec">B</h3>');
has('\\begin{itemize}\\item a \\item b\\end{itemize}', '<ul><li>a</li><li>b</li></ul>');
has('\\begin{enumerate}[label=\\arabic*)]\\item a\\end{enumerate}', '<ol><li>a</li></ol>', 'options are not interpreted');
has('\\begin{description}\\item[T] text\\end{description}', '<dl><dt>T</dt><dd>text</dd></dl>');
has('\\begin{itemize}\\item A\\begin{enumerate}\\item x\\item y\\end{enumerate}\\item B\\end{itemize}', '<ul><li><p>A</p><ol><li>x</li><li>y</li></ol></li><li>B</li></ul>', 'nested lists');
has('\\begin{itemize}\\item \\textbf{a \\item}\\end{itemize}'.replace('\\item}', '}'), '<li><b>a </b></li>');
has('\\begin{center}x\\end{center}', 'text-align:center');
has('\\begin{quote}q\\end{quote}', '<blockquote><p>q</p></blockquote>');
has('\\begin{theorem}[Гаусса] t\\end{theorem}', '<b>Теорема (Гаусса).</b>');
has('\\begin{proof}p\\end{proof}', '<b>Доведення.</b>');
has('\\begin{problem}p\\end{problem}', '<b>Задача.</b>');
has('\\begin{figure}[h!]\\includegraphics[width=3cm]{fig/a.png}\\caption{Рис}\\end{figure}', '<div class="img">🖼 a.png</div><div class="cap">Рис</div>');
has('\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}', 'tikzpicture: рисунок буде лише в PDF');
has('\\begin{verbatim}\n% not a comment <b>\n\\end{verbatim}', '<pre class="raw">% not a comment &lt;b&gt;\n</pre>');
has('t\\footnote{note}.', '<sup class="fn" title="note">1</sup>');
ok(/<div class="fns"><div><sup>1<\/sup> note<\/div><\/div>/.test(html('t\\footnote{note}.')), 'the footnote text is listed');
has('\\cite{a,b} \\ref{x} \\eqref{y}', '<span class="ref">[a,b]</span> <span class="ref">x</span> <span class="ref">(y)</span>');
has('\\label{x}text', '<p>text</p>');
has('\\hspace{1cm}a\\vspace{2pt}b', '<p>ab</p>');

// tables (the model of the table editor)
const tbl = '\\begin{tblr}{colspec={Q[l]Q[r]}, hlines}\n a & $x^2$ \\\\\n b & c \\\\\n\\end{tblr}';
has(tbl, '<table class="tb"><tr><td class="al-l">a</td><td class="al-r"><span class="m" data-d="0" data-tex="x^2"></span></td></tr>');
has('\\begin{tabular}{|l|c|}\\hline a & b \\\\ \\hline \\end{tabular}', '<table class="tb">');
has('\\begin{tblr}%\n  {\n    colspec = {ll},\n  }\n a & b \\\\\n\\end{tblr}', '<td class="al-l">a</td><td class="al-l">b</td>', 'the table with options after a comment (the bug of 0.14.0)');
has('\\begin{tabular}{ll}\\multicolumn{2}{c}{M} \\\\ a & b \\\\\\end{tabular}', 'colspan="2"');
has('\\begin{tblr}{colspec={ll}, cell{1}{1}={bg=brand}}\n a & b \\\\\n\\end{tblr}', 'style="background:rgb(1,2,3);', 'cell colour from the project', { colors: COLORS });
ok(R('\\begin{tblr}{colspec={ll}\n a \\end{tblr}').notes.some((x) => /таблиця/.test(x)), 'a broken table is reported and shown raw');

// what is not understood is reported, its arguments are shown
let r = R('see \\vect{j} and \\Foo');
ok(r.html.includes('<span class="unk" title="\\vect">j</span>') && r.html.includes('<code class="unk">\\Foo</code>'), r.html);
eq(r.notes, ['\\vect', '\\Foo']);
r = R('\\begin{myenv}{T} text\\end{myenv}');
ok(r.html.includes('<span class="tag">myenv</span>') && r.notes.includes('myenv'), r.html);

// safety: only tags and attributes of the converter can be in the result, no matter what the source holds
const TAGS = new Set(['a', 'p', 'b', 'i', 'em', 'u', 's', 'code', 'span', 'div', 'sup', 'sub', 'pre', 'table', 'tr', 'td', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'img', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br']);
const ATTRS = new Set(['class', 'style', 'title', 'data-d', 'data-tex', 'data-l', 'colspan', 'rowspan', 'src', 'alt', 'href', 'data-open', 'data-via']);
function assertSafe(h, what) {
  const text = h.replace(/<[^>]*>/g, '');
  assert.ok(!/[<>]/.test(text), 'a raw < or > in text: ' + what + ' -> ' + h);
  for (const tag of h.match(/<[^>]*>/g) || []) {
    const m = /^<\/?([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*\/?>$/.exec(tag);
    assert.ok(m && TAGS.has(m[1]), 'a tag outside the list: ' + tag + ' for ' + what);
    for (const a of m[2].match(/[a-z-]+(?==")/g) || []) assert.ok(ATTRS.has(a), 'an attribute outside the list: ' + a + ' for ' + what);
    const hr = /\shref="([^"]*)"/.exec(tag);
    if (hr) assert.strictEqual(hr[1], '#', 'the only link is the empty anchor of a tikz frame: ' + tag);
    const st = /\sstyle="([^"]*)"/.exec(tag);
    if (st) assert.ok(/^[a-z0-9:;#%.,() -]*$/i.test(st[1]), 'style: ' + st[1]);
  }
  n++;
}
for (const evil of ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '\\href{javascript:alert(1)}{<b>x</b>}', '$"><img src=x onerror=y>$', '\\textcolor{red"onload="x}{y}', '\\textcolor{red;background:url(x)}{y}', '\\begin{a"b}x\\end{a"b}', '\\unknown{<i>}', '\\footnote{"><svg onload=1>}', '\\begin{tblr}{colspec={l}}<u>x</u>\\\\\\end{tblr}', '\\begin{tblr}{colspec={l}, cell{1}{1}={bg=red"onclick="x}}\n a \\\\\n\\end{tblr}', '\\begin{verbatim}<script>\\end{verbatim}', '\\section{<b>}', '\\item[<b>] x', '\\begin{description}\\item[<img onerror=x>] y\\end{description}', '\\begin{theorem}[<i>]x\\end{theorem}']) {
  const h = html(evil);
  assertSafe(h, evil);
}
ok(!/href=/.test(html('\\href{javascript:alert(1)}{x}')), 'no links are made');

// pictures: with a resolver \includegraphics is the picture, without one a frame with the name (as before)
const IMG = (full) => { const name = full.split('/').pop(); return (name === 'a.png' ? { src: 'https://w.test/a.png?t=1' } : name === 'v.pdf' ? { skip: 'pdf' } : { skip: 'missing' }); };
r = R('\\includegraphics[width=0.5\\linewidth]{fig/a.png}', { image: IMG });
eq(r.html, '<div class="pic"><img src="https://w.test/a.png?t=1" alt="a.png" title="a.png" style="width:50%"></div>', 'block picture');
r = R('текст \\includegraphics[width=3cm]{a.png} далі', { image: IMG });
ok(r.html.includes('<img src="https://w.test/a.png?t=1" alt="a.png" title="a.png" style="width:3cm">'), r.html);
eq(R('\\includegraphics{a.png}', { image: IMG }).html.includes('style='), false, 'no width: no style');
eq(R('\\includegraphics[width=\\textwidth]{a.png}', { image: IMG }).html.includes('style="width:100%"'), true, 'width=\\textwidth');
eq(R('\\includegraphics[width=2\\linewidth]{a.png}', { image: IMG }).html.includes('style="width:100%"'), true, 'wider than the line: the line');
eq(R('\\includegraphics[height=2cm]{a.png}', { image: IMG }).html.includes('style='), false, 'height is ignored');
eq(R('\\includegraphics[width=1e9cm]{a.png}', { image: IMG }).html.includes('style='), false, 'a strange width is ignored');
eq(R('\\includegraphics{v.pdf}', { image: IMG }).html, '<div class="img">🖼 v.pdf (PDF і EPS у перегляді не показуються)</div>');
eq(R('\\includegraphics{x.png}', { image: IMG }).html, '<div class="img">🖼 x.png (файл не знайдено)</div>');
eq(R('\\includegraphics{x.png}').html, '<div class="img">🖼 x.png</div>', 'no resolver: the frame as before');
eq(R('\\includegraphics{a.png}', { image: () => { throw new Error('boom'); } }).html, '<div class="img">🖼 a.png</div>', 'a failing resolver is a frame');
ok(!R('\\includegraphics{a.png}', { image: () => ({ src: 'javascript:alert(1)' }) }).html.includes('<img'), 'javascript: is never a source');
ok(!R('\\includegraphics{a.png}', { image: () => ({ src: 'data:text/html,<b>' }) }).html.includes('<img'), 'only data:image');
for (const evil of ['\\includegraphics{a"onerror="x.png}', '\\includegraphics[width=1cm"onload="x]{a.png}', '\\includegraphics{<img src=x onerror=y>}']) {
  const h = R(evil, { image: (nm) => ({ src: 'https://w.test/' + nm }) }).html;
  assertSafe(h, evil);
}

// robustness: broken input never throws or hangs
const t0 = Date.now();
const broken = ['\\textbf{', '}}}{{{', '$', '$$', '\\[', '\\(', '\\begin{itemize}', '\\begin{', '\\end{x}', '\\', '\\\\\\', '\\item', '\\begin{tblr}', '{'.repeat(500) + 'x' + '}'.repeat(500), '\\textbf{'.repeat(100) + 'x' + '}'.repeat(100), '\\begin{a}'.repeat(60) + '\\end{a}'.repeat(60), '\\section{', '\\footnote{\\footnote{x}}', '%', '\\begin{verbatim}'];
for (const b of broken) { const x = R(b); ok(typeof x.html === 'string', 'broken: ' + b.slice(0, 20)); }
let seed = 12345;
const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
const toks = ['\\', '{', '}', '$', '$$', '\\[', '\\]', '\\(', '\\)', '\\begin{itemize}', '\\end{itemize}', '\\begin{equation}', '\\end{equation}', '\\item ', '\\textbf', '\\emph{', '&', '\\\\', '%', '\n', '\n\n', ' ', 'a', 'x', '[', ']', '\\section{', '\\footnote{', '\\begin{tblr}{colspec={ll}}', '\\end{tblr}', '\\verb|', '~', '--', '`', "'", '<b>', '"'];
for (let k = 0; k < 400; k++) {
  let s = '';
  for (let j = rnd(40); j >= 0; j--) s += toks[rnd(toks.length)];
  const x = R(s);
  if (typeof x.html !== 'string') assert.fail('fuzz: ' + JSON.stringify(s));
  assertSafe(x.html, 'fuzz ' + JSON.stringify(s));
  n++;
}
ok(Date.now() - t0 < 5000, 'robustness runs fast: ' + (Date.now() - t0) + ' ms');
// a long text is cut
r = R('x'.repeat(300000), { limit: 1000 });
ok(r.html.length < 2000 && r.notes.some((x) => /обрізано/.test(x)), 'limit');

// 0.15.3: the code of tikz is not drawn; SCfigure has the caption beside the picture; \localinput of tikz is a frame with the name
r = R('\\begin{SCfigure}[][h!]\n\\centering\n\\includegraphics[height=3cm]{x.png}\n\\caption{Демонстрація.\\label{pic:a}}\n\\end{SCfigure}', { image: IMG });
ok(!r.html.includes('[h!]') && !r.html.includes('[]') && !r.html.includes('class="tag"'), 'SCfigure: no options, no tag of an unknown environment: ' + r.html);
ok(/^<figure class="fl sc"><div class="sc-pic">.*<\/div><div class="cap sc-cap">Демонстрація\.<\/div><\/figure>$/.test(r.html), 'SCfigure: the picture and the caption side by side: ' + r.html);
ok(!r.html.includes('<p></p>'), 'no empty paragraph from \\centering');
ok(!r.notes.includes('SCfigure'), 'SCfigure is understood: ' + r.notes);
for (const [src, name, via] of [
  ['\\begin{figure}[h!]\\centering\n\\localinput{triboseries.tikz}\n\\caption{Ряд}\n\\end{figure}', 'triboseries.tikz', 'localinput'],
  ['\\begin{wrapfigure}{r}{0.4\\linewidth}\\input{tikz/a.tikz}\\caption{c}\\end{wrapfigure}', 'tikz/a.tikz', 'input'],
  ['\\begin{wrapstuff}[r,width=5cm]\\localinput{b}\\caption{c}\\end{wrapstuff}', 'b', 'localinput'],
  ['\\begin{SCfigure}[][h!]\\localinput{s.tikz}\\caption{c}\\end{SCfigure}', 's.tikz', 'localinput']
]) {
  const h = html(src);
  ok(h.includes('<a class="tikzf" href="#" data-open="' + name + '" data-via="' + via + '"'), src + ' -> ' + h);
  ok(h.includes('>' + name.split('/').pop() + '</a>'), 'the name of the file is in the frame: ' + h);
  assertSafe(h, src);
}
ok(!html('\\begin{figure}\\localinput{x.tikz}\\end{figure}').includes('[h!]'), 'no options');
eq(html('\\input{chap.tex}'), '', '\\input of a .tex stays silent as before');
ok(html('\\localinput{b}').includes('class="unk"') && !html('\\localinput{b}').includes('tikzf'), '\\localinput without .tikz outside a figure: as before');
ok(html('\\input{a/b.tikz}').includes('data-open="a/b.tikz"'), 'a .tikz file outside a figure is a frame too');
ok(!html('\\localinput{a"onclick="x.tikz}').includes('onclick="x'), 'the name is escaped');
// code of a picture without \begin: one frame for all the paragraphs of code
r = R('\\draw[->] (0,0) -- (1,1);\n\\node at (0,0) {$x$};\n\n\\fill (1,1) circle (1pt);\n\\pgfmathsetmacro{\\angle}{atan(3/2)}\n\nЗвичайний текст.');
eq(r.html, '<div class="ph">tikz: код рисунка, рисунок буде лише в PDF</div><p>Звичайний текст.</p>', 'the code of tikz is a frame: ' + r.html);
ok(!r.html.includes('\\draw') && !r.html.includes('data-tex'), 'nothing of the code is shown');
eq(html('\\end{tikzpicture}'), '<div class="ph">tikz: код рисунка, рисунок буде лише в PDF</div>', 'the end of a picture alone');
ok(html('Текст \\draw тут').includes('<p>'), 'a command in the middle of a text is not code');
assertSafe(html('\\draw (0,0) -- (1,1);'), 'tikz frame');

// 0.15.4: \ce and \pu (mhchem) in a text are small formulas, KaTeX draws them
r = R('Вода \\ce{H2O} і \\pu{5 mol/L}, реакція \\ce{2H2 + O2 -> 2H2O}.');
ok(r.html.includes('data-tex="\\ce{H2O}"') && r.html.includes('data-tex="\\pu{5 mol/L}"') && r.html.includes('data-tex="\\ce{2H2 + O2 -&gt; 2H2O}"'), r.html);
eq(r.notes, [], '\\ce is understood, not reported');
assertSafe(r.html, 'ce');
ok(html('$\\ce{SO4^2-}$').includes('data-tex="\\ce{SO4^2-}"'), 'a \\ce inside a formula stays in it');
// the page really draws them: katex.min.js of the extension with mhchem.min.js (a version of KaTeX that does not take mhchem fails here)
{
  const Module = require('module');
  const katex = require(path.join(EXT, 'media', 'katex', 'katex.min.js'));
  const orig = Module._load;
  Module._load = function (rq, ...a) { return rq === 'katex' ? katex : orig.call(this, rq, ...a); };
  try { require(path.join(EXT, 'media', 'katex', 'mhchem.min.js')); } finally { Module._load = orig; }
  for (const t of ['\\ce{H2O}', '\\ce{SO4^2-}', '\\ce{2H2 + O2 -> 2H2O}', '\\ce{CO2 <=> H2CO3}', '\\pu{1.5 mol//L}']) {
    const h = katex.renderToString(t, { throwOnError: true, strict: 'ignore', output: 'html' });
    ok(h.includes('katex') && !h.includes('katex-error'), 'KaTeX with mhchem draws ' + t);
  }
}

console.log('selectionPreview: ' + n + ' checks passed');
