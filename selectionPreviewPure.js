'use strict';
/* selectionPreviewPure.js: a LaTeX fragment as HTML for the panel "Preview selection" (no vscode dependency).
 *   render(src, opts) -> { html, notes }
 *     html   safe HTML: all text is escaped, formulas are empty <span class="m" data-tex=".." data-d="0|1"> that the page
 *            draws with KaTeX (with the macros of the project), tables come from the model of the table editor
 *     notes  what is not drawn: commands and environments that were not understood (shown under the preview)
 *   opts: { colors: Map of project colours (tableEditorPure.colorDefs), limit: characters, default 200000,
 *           image: (name) => { src } | { skip: 'pdf' | 'missing' } finds the file of \includegraphics (without it: a frame with the name) }
 * This is not LaTeX: it understands the common text commands, lists, theorem-like blocks, formulas and tables; the PDF is
 * the only exact rendering. */

const X = require('./tableEditorPure');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MATH_ENVS = new Set(['equation', 'equation*', 'displaymath', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'eqnarray', 'eqnarray*', 'split']);
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description', 'compactitem', 'compactenum']);
const TABLE_ENVS = new Set(['tblr', 'longtblr', 'talltblr', 'tabular', 'tabularx', 'tabular*', 'longtable', 'array']);
const VERB_ENVS = ['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'alltt'];
const PICTURE_ENVS = new Set(['tikzpicture', 'circuitikz', 'axis', 'pgfpicture', 'picture', 'forest']);
const BLOCK_STYLE = { center: 'text-align:center', flushleft: 'text-align:left', flushright: 'text-align:right', centering: 'text-align:center' };
const THEOREMS = { theorem: 'Теорема', lemma: 'Лема', proposition: 'Твердження', corollary: 'Наслідок', definition: 'Означення', example: 'Приклад', remark: 'Зауваження', proof: 'Доведення', problem: 'Задача', solution: 'Розв’язання', exercise: 'Вправа', claim: 'Твердження', note: 'Примітка' };
const SECTIONS = { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const SYMBOLS = { ldots: '…', dots: '…', textellipsis: '…', LaTeX: 'LaTeX', TeX: 'TeX', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textbullet: '•', textendash: '–', textemdash: '—', textdegree: '°', S: '§', P: '¶', copyright: '©', pounds: '£', euro: '€', textregistered: '®', texttrademark: '™', ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', dag: '†', ddag: '‡', textquoteleft: '‘', textquoteright: '’', guillemotleft: '«', guillemotright: '»', nbsp: '\u00a0', quad: '\u2003', qquad: '\u2003\u2003', enspace: '\u2002' };
const STYLE_CMDS = { textbf: ['<b>', '</b>'], textit: ['<i>', '</i>'], emph: ['<em>', '</em>'], textsl: ['<i>', '</i>'], underline: ['<u>', '</u>'], uline: ['<u>', '</u>'], texttt: ['<code>', '</code>'], textsc: ['<span class="sc">', '</span>'], textrm: ['', ''], textsf: ['<span class="sf">', '</span>'], textmd: ['', ''], textup: ['', ''], textnormal: ['', ''], text: ['', ''], mbox: ['', ''], hbox: ['', ''], textsuperscript: ['<sup>', '</sup>'], textsubscript: ['<sub>', '</sub>'], sout: ['<s>', '</s>'], st: ['<s>', '</s>'], mathrm: ['', ''] };
const DECLS = { bfseries: ['<b>', '</b>'], bf: ['<b>', '</b>'], itshape: ['<i>', '</i>'], it: ['<i>', '</i>'], em: ['<em>', '</em>'], slshape: ['<i>', '</i>'], ttfamily: ['<code>', '</code>'], tt: ['<code>', '</code>'], scshape: ['<span class="sc">', '</span>'], sffamily: ['<span class="sf">', '</span>'], tiny: ['<span class="s0">', '</span>'], scriptsize: ['<span class="s1">', '</span>'], footnotesize: ['<span class="s2">', '</span>'], small: ['<span class="s3">', '</span>'], large: ['<span class="s5">', '</span>'], Large: ['<span class="s6">', '</span>'], LARGE: ['<span class="s7">', '</span>'], huge: ['<span class="s8">', '</span>'], Huge: ['<span class="s9">', '</span>'] };
// commands that print nothing; their arguments (one { } group each, `n`) are skipped
const SKIP_CMDS = { label: 1, index: 1, vspace: 1, hspace: 1, vskip: 0, hskip: 0, noindent: 0, indent: 0, centering: 0, raggedright: 0, raggedleft: 0, newpage: 0, clearpage: 0, pagebreak: 0, linebreak: 0, nolinebreak: 0, nopagebreak: 0, medskip: 0, bigskip: 0, smallskip: 0, maketitle: 0, tableofcontents: 0, normalsize: 0, protect: 0, relax: 0, phantom: 1, hphantom: 1, vphantom: 1, thispagestyle: 1, pagestyle: 1, setlength: 2, setcounter: 2, addtocounter: 2, stepcounter: 1, bibliographystyle: 1, bibliography: 1, nocite: 1, ignorespaces: 0, null: 0, strut: 0, allowbreak: 0, leavevmode: 0, hfill: 0, hfil: 0, vfill: 0, marginpar: 1, tikzset: 1, graphicspath: 1, input: 1, include: 1, usepackage: 1 };
const CSS_COLORS = new Set(['red', 'green', 'blue', 'black', 'white', 'cyan', 'magenta', 'yellow', 'gray', 'grey', 'orange', 'purple', 'brown', 'pink', 'violet', 'olive', 'teal', 'lime', 'darkgray', 'lightgray']);

/* ------------------------------ scanning helpers ------------------------------ */
// index after the group that opens at text[i] ('{' or '['), or -1
function groupEnd(text, i) {
  const open = text[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') { k++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return k + 1; }
  }
  return -1;
}

// removes % comments (a comment also swallows the line break and the indentation of the next line, as in TeX)
function stripComments(text) {
  const out = [];
  let join = false;
  for (const line of String(text).split(/\r?\n/)) {
    let cut = -1;
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '\\') { k++; continue; }
      if (line[k] === '%') { cut = k; break; }
    }
    const piece = join ? line.replace(/^[ \t]+/, '') : line;
    if (cut >= 0) { out.push(join ? line.slice(0, cut).replace(/^[ \t]+/, '') : line.slice(0, cut)); out.push(null); join = true; } else {
      // the comment before swallowed only its own line break: an empty line after it still ends the paragraph
      if (join && piece.trim() === '') out.push('\n');
      out.push(piece);
      out.push('\n');
      join = false;
    }
  }
  // null marks "no line break here"
  let s = '';
  for (const part of out) if (part !== null) s += part;
  return s;
}

// where \end{name} that closes the \begin{name} whose body starts at `from` stands: { bodyEnd, after } (nested same names counted)
function matchEnd(text, from, name) {
  const re = new RegExp('\\\\(begin|end)\\s*\\{' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}', 'g');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(text))) {
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth === 0) return { bodyEnd: m.index, after: m.index + m[0].length };
  }
  return null;
}

const math = (tex, display) => '<span class="m" data-d="' + (display ? 1 : 0) + '" data-tex="' + esc(cleanMath(tex)) + '"></span>';
function cleanMath(tex) {
  return String(tex).replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(?:nonumber|notag)\b/g, '\\notag ').trim();
}
const mathEnv = (name, body) => {
  const n = name.replace(/\*$/, '');
  let b = body.replace(/^\s*\{[^}]*\}/, (m) => (n === 'alignat' ? '' : m)); // alignat{n}: the number of columns is not needed
  if (n === 'multline') return '\\begin{gathered}' + b + '\\end{gathered}';
  if (n === 'eqnarray') return '\\begin{aligned}' + b + '\\end{aligned}';
  if (n === 'align' || n === 'flalign' || n === 'alignat' || n === 'split') return '\\begin{aligned}' + b + '\\end{aligned}';
  if (n === 'gather') return '\\begin{gathered}' + b + '\\end{gathered}';
  return b;
};

/* --------------------------------- the converter --------------------------------- */
function makeCtx(opts) {
  return { notes: new Set(), footnotes: [], verb: [], colors: (opts && opts.colors) || new Map(), image: opts && typeof opts.image === 'function' ? opts.image : null, depth: 0 };
}

// \includegraphics[opt]{name}: the picture itself when the panel found the file (opts.image(name) -> { src } or
// { skip: 'pdf' | 'missing' }), else a frame with the file name. width= of the options is kept (a share of the line or an
// absolute length), the rest of the options is ignored.
function imgWidth(opt) {
  const m = /(?:^|,)\s*width\s*=\s*(-?[0-9]*\.?[0-9]+)?\s*(\\(?:line|text|column)width|cm|mm|in|pt|bp)?\s*(?:,|$)/.exec(String(opt || ''));
  if (!m || !m[2]) return '';
  const v = m[1] === undefined ? 1 : parseFloat(m[1]);
  if (!(v > 0) || v > 1000) return '';
  return m[2][0] === '\\' ? 'width:' + Math.round(Math.min(v, 1) * 1000) / 10 + '%' : 'width:' + v + (m[2] === 'bp' ? 'pt' : m[2]);
}
function graphic(opt, name, ctx, block) {
  const file = String(name || '').trim();
  const base = file.split('/').pop();
  const tag = block ? 'div' : 'span';
  let r = null;
  if (ctx.image && file) { try { r = ctx.image(file); } catch (e) { r = null; } }
  if (r && typeof r.src === 'string' && r.src && !/^\s*(?:javascript|vbscript|data:(?!image\/))/i.test(r.src)) {
    const w = imgWidth(opt);
    return '<' + tag + ' class="pic"><img src="' + esc(r.src) + '" alt="' + esc(base) + '" title="' + esc(base) + '"' + (w ? ' style="' + w + '"' : '') + '></' + tag + '>';
  }
  const why = r && r.skip === 'pdf' ? ' (PDF і EPS у перегляді не показуються)' : r && r.skip === 'missing' ? ' (файл не знайдено)' : '';
  return '<' + tag + ' class="img">🖼 ' + esc(base) + why + '</' + tag + '>';
}
const note = (ctx, s) => ctx.notes.add(s);

// readers of command arguments: { text, end } or null
function readGroup(text, i) {
  let k = i;
  while (k < text.length && /[ \t]/.test(text[k])) k++;
  if (/^[ \t]*\n[ \t]*\n/.test(text.slice(k, k + 200))) return null; // a blank line: the argument is not coming
  while (k < text.length && /\s/.test(text[k])) k++;
  if (text[k] !== '{') return null;
  const e = groupEnd(text, k);
  if (e < 0) return null;
  return { text: text.slice(k + 1, e - 1), end: e };
}
function readOpt(text, i) {
  let k = i;
  while (k < text.length && /[ \t]/.test(text[k])) k++;
  if (text[k] !== '[') return null;
  const e = groupEnd(text, k);
  if (e < 0) return null;
  return { text: text.slice(k + 1, e - 1), end: e };
}

/* inline content: text, formulas, commands. Returns HTML. */
function inline(text, ctx) {
  if (ctx.depth > 40) return esc(text);
  ctx.depth++;
  try {
    let out = '';
    const closers = []; // declarations (\bfseries ...) stay open until the end of this group
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '$') {
        const dbl = text[i + 1] === '$';
        const start = i + (dbl ? 2 : 1);
        let k = start;
        while (k < n && !(text[k] === '$' && text[k - 1] !== '\\')) k++;
        if (k >= n) { out += esc(text.slice(i)); i = n; break; }
        out += math(text.slice(start, k), dbl);
        i = k + (dbl ? 2 : 1);
        continue;
      }
      if (c === '{') {
        const e = groupEnd(text, i);
        if (e < 0) { out += esc(text.slice(i + 1)); i = n; break; }
        out += inline(text.slice(i + 1, e - 1), ctx);
        i = e;
        continue;
      }
      if (c === '~') { out += '&nbsp;'; i++; continue; }
      if (c === '-' && text.startsWith('---', i)) { out += '—'; i += 3; continue; }
      if (c === '-' && text.startsWith('--', i)) { out += '–'; i += 2; continue; }
      if (c === '`' && text[i + 1] === '`') { out += '“'; i += 2; continue; }
      if (c === '\'' && text[i + 1] === '\'') { out += '”'; i += 2; continue; }
      if (c !== '\\') {
        let k = i + 1;
        while (k < n && !'$\\{~-`\''.includes(text[k])) k++;
        out += esc(text.slice(i, k));
        i = k;
        continue;
      }
      // a backslash
      const nx = text[i + 1];
      if (nx === undefined) { i++; continue; }
      if (nx === '(') {
        const e = text.indexOf('\\)', i + 2);
        if (e < 0) { out += esc(text.slice(i)); i = n; break; }
        out += math(text.slice(i + 2, e), false);
        i = e + 2;
        continue;
      }
      if (nx === '[') {
        const e = text.indexOf('\\]', i + 2);
        if (e < 0) { out += esc(text.slice(i)); i = n; break; }
        out += math(text.slice(i + 2, e), true);
        i = e + 2;
        continue;
      }
      if (nx === '\\') {
        let k = i + 2;
        if (text[k] === '*') k++;
        const o = readOpt(text, k);
        if (o && /^\s*-?[0-9.]+\s*[a-z]{2}\s*$/.test(o.text)) k = o.end;
        out += '<br>';
        i = k;
        continue;
      }
      if (!/[A-Za-z@]/.test(nx)) {
        const ch = nx;
        if ('%&_#${}'.includes(ch)) out += esc(ch);
        else if (' ,;:!>/@'.includes(ch)) out += ch === ' ' ? ' ' : '\u2009';
        else if (ch === '-') out += '';
        else out += esc(ch);
        i += 2;
        continue;
      }
      let k = i + 1;
      while (k < n && /[A-Za-z@]/.test(text[k])) k++;
      let name = text.slice(i + 1, k);
      if (text[k] === '*') k++;
      i = k;
      if (SYMBOLS[name] !== undefined) { out += esc(SYMBOLS[name]); if (text[i] === ' ' ) i++; continue; }
      if (STYLE_CMDS[name]) {
        const g = readGroup(text, i);
        if (g) { out += STYLE_CMDS[name][0] + inline(g.text, ctx) + STYLE_CMDS[name][1]; i = g.end; continue; }
        continue;
      }
      if (DECLS[name]) { out += DECLS[name][0]; closers.push(DECLS[name][1]); if (text[i] === ' ') i++; continue; }
      if (name === 'par') { out += '<br><br>'; continue; }
      if (name === 'newline') { out += '<br>'; continue; }
      if (name === 'item') { out += '<br>• '; continue; }
      if (name === 'footnote' || name === 'footnotetext') {
        const o = readOpt(text, i); if (o) i = o.end;
        const g = readGroup(text, i);
        if (g) {
          i = g.end;
          const html = inline(g.text, ctx);
          ctx.footnotes.push(html);
          out += '<sup class="fn" title="' + esc(g.text.replace(/\s+/g, ' ').slice(0, 300)) + '">' + ctx.footnotes.length + '</sup>';
        }
        continue;
      }
      if (/^(?:cite[a-z]*|nocite|parencite|textcite|footcite)$/i.test(name)) {
        const o1 = readOpt(text, i); if (o1) i = o1.end;
        const o2 = readOpt(text, i); if (o2) i = o2.end;
        const g = readGroup(text, i);
        if (g) { i = g.end; out += '<span class="ref">[' + esc(g.text.replace(/\s+/g, ' ')) + ']</span>'; }
        continue;
      }
      if (name === 'eqref') { const g = readGroup(text, i); if (g) { i = g.end; out += '<span class="ref">(' + esc(g.text) + ')</span>'; } continue; }
      if (/^(?:[a-z]*ref|autoref|cref|Cref|pageref|nameref|vref|labelcref)$/i.test(name)) {
        const g = readGroup(text, i);
        if (g) { i = g.end; out += '<span class="ref">' + esc(g.text) + '</span>'; }
        continue;
      }
      if (name === 'href') {
        const u = readGroup(text, i);
        if (u) { const t = readGroup(text, u.end); i = t ? t.end : u.end; out += '<span class="a" title="' + esc(u.text) + '">' + (t ? inline(t.text, ctx) : esc(u.text)) + '</span>'; }
        continue;
      }
      if (name === 'url') { const g = readGroup(text, i); if (g) { i = g.end; out += '<span class="a">' + esc(g.text) + '</span>'; } continue; }
      if (name === 'textcolor' || name === 'colorbox') {
        const o = readOpt(text, i); if (o) i = o.end;
        const c = readGroup(text, i);
        const t = c && readGroup(text, c.end);
        if (c && t) {
          i = t.end;
          const key = c.text.trim();
          const def = ctx.colors.get && ctx.colors.get(key);
          const css = CSS_COLORS.has(key) ? key : (def && def.rgb && def.rgb.length === 3 ? 'rgb(' + def.rgb.map((v) => Math.round(Number(v) || 0)).join(',') + ')' : '');
          const prop = name === 'colorbox' ? 'background' : 'color';
          out += css ? '<span style="' + prop + ':' + esc(css) + '">' + inline(t.text, ctx) + '</span>' : inline(t.text, ctx);
        }
        continue;
      }
      if (name === 'enquote') { const g = readGroup(text, i); if (g) { i = g.end; out += '«' + inline(g.text, ctx) + '»'; } continue; }
      if (name === 'foreignlanguage' || name === 'selectlanguage') { const l = readGroup(text, i); if (l) i = l.end; if (name === 'foreignlanguage') { const t = readGroup(text, i); if (t) { i = t.end; out += inline(t.text, ctx); } } continue; }
      if (name === 'includegraphics') {
        const o = readOpt(text, i); if (o) i = o.end;
        const g = readGroup(text, i);
        if (g) i = g.end;
        out += graphic(o ? o.text : '', g ? g.text : '', ctx, false);
        continue;
      }
      if (name === 'caption' || name === 'subcaption') {
        const o = readOpt(text, i); if (o) i = o.end;
        const g = readGroup(text, i);
        if (g) { i = g.end; out += '<span class="cap">' + inline(g.text, ctx) + '</span>'; }
        continue;
      }
      if (name === 'begin' || name === 'end') {
        const g = readGroup(text, i);
        if (g) i = g.end;
        note(ctx, name === 'begin' ? '\\begin{' + (g ? g.text : '') + '}' : '');
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SKIP_CMDS, name)) {
        let skip = SKIP_CMDS[name];
        while (skip-- > 0) { const o = readOpt(text, i); if (o) i = o.end; const g = readGroup(text, i); if (g) i = g.end; }
        continue;
      }
      // unknown: a command of the project or of a package; its arguments are shown, the name is reported
      note(ctx, '\\' + name);
      const parts = [];
      for (;;) {
        const o = readOpt(text, i);
        if (o) { i = o.end; continue; }
        const g = readGroup(text, i);
        if (!g) break;
        parts.push(inline(g.text, ctx));
        i = g.end;
        if (parts.length >= 4) break;
      }
      out += parts.length ? '<span class="unk" title="\\' + esc(name) + '">' + parts.join(' ') + '</span>' : '<code class="unk">\\' + esc(name) + '</code>';
    }
    while (closers.length) out += closers.pop();
    return out;
  } finally { ctx.depth--; }
}

const paragraphs = (text, ctx) => text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean).map((p) => '<p>' + inline(p.replace(/\s*\n\s*/g, ' '), ctx) + '</p>').join('');

// the items of a list body: [{ label, body }]; \item inside nested environments and groups does not split
function splitItems(body) {
  const items = [];
  const re = /\\begin\s*\{[^}]*\}|\\end\s*\{[^}]*\}|\\item(?![A-Za-z@])|\\[{}]|\{|\}/g;
  let depth = 0;
  let cur = null;
  let last = 0;
  let m;
  const close = (end) => { if (cur) { cur.body = body.slice(cur.from, end); items.push(cur); } };
  while ((m = re.exec(body))) {
    const t = m[0];
    if (t === '\\{' || t === '\\}') continue; // an escaped brace is a character
    if (t === '{' || t.startsWith('\\begin')) depth++;
    else if (t === '}' || t.startsWith('\\end')) depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      close(m.index);
      let from = m.index + t.length;
      let label = null;
      const o = readOpt(body, from);
      if (o) { label = o.text; from = o.end; }
      cur = { label, from };
      last = from;
    }
  }
  close(body.length);
  void last;
  return items;
}

function listHtml(name, body, ctx) {
  // options of the list: [label=...] (enumitem) are not interpreted
  const opt = readOpt(body, 0);
  if (opt) body = body.slice(opt.end);
  const items = splitItems(body);
  const inner = (b) => { const h = blocks(b, ctx); const m = /^<p>([\s\S]*)<\/p>$/.exec(h); return m && !m[1].includes('<p>') ? m[1] : h; };
  if (name === 'description') return '<dl>' + items.map((it) => '<dt>' + (it.label !== null ? inline(it.label, ctx) : '') + '</dt><dd>' + inner(it.body) + '</dd>').join('') + '</dl>';
  const tag = name.includes('enum') ? 'ol' : 'ul';
  return '<' + tag + '>' + items.map((it) => '<li' + (it.label !== null ? ' data-l="' + esc(it.label) + '"' : '') + '>' + inner(it.body) + '</li>').join('') + '</' + tag + '>';
}

function tableHtml(src, ctx) {
  let env;
  let res;
  try {
    env = X.locateTables(src)[0];
    res = env && env.start === 0 ? X.parseTable(src, env) : null;
  } catch (e) { res = null; }
  if (!res || res.skip) { note(ctx, 'таблиця (не розібрано' + (res && res.skip ? ': ' + res.skip : '') + ')'); return '<pre class="raw">' + esc(src) + '</pre>'; }
  const view = X.toView(res.model, ctx.colors);
  let h = '<table class="tb">';
  view.rows.forEach((row, r) => {
    const cls = (row.rule ? 'rule' : '') + (r === view.rows.length - 1 && view.tailRule ? ' tail' : '');
    h += '<tr' + (cls.trim() ? ' class="' + cls.trim() + '"' : '') + '>';
    let logical = 0;
    row.cells.forEach((cell) => {
      const lg = logical;
      logical += cell.kind === 'mc' ? cell.span : 1;
      if (cell.hidden) return;
      const st = cell.style || {};
      const al = st.align || (view.align && view.align[lg]) || 'l';
      const css = (st.bg ? 'background:' + st.bg + ';' : '') + (st.fg ? 'color:' + st.fg + ';' : '') + (st.bold ? 'font-weight:700;' : '');
      let content;
      if (cell.formula) content = '<code>' + esc(cell.t) + '</code>';
      else if ((st.mode === 'math' || st.mode === 'dmath') && cell.t.trim() && !/\$|\\\(|\\\[/.test(cell.t)) content = math((st.mode === 'dmath' ? '\\displaystyle ' : '') + cell.t, false);
      else content = inline(cell.t, ctx);
      h += '<td class="al-' + (['l', 'c', 'r'].includes(al) ? al : 'l') + '"' + (cell.span > 1 ? ' colspan="' + cell.span + '"' : '') + (cell.rowspan > 1 ? ' rowspan="' + cell.rowspan + '"' : '') + (css ? ' style="' + esc(css) + '"' : '') + '>' + content + '</td>';
    });
    h += '</tr>';
  });
  return h + '</table>';
}

/* blocks: environments, display formulas, sections, paragraphs */
function blocks(text, ctx) {
  if (ctx.depth > 40) return '<p>' + esc(text) + '</p>';
  ctx.depth++;
  try {
    const out = [];
    let buf = '';
    const flush = () => { if (buf.trim()) out.push(paragraphs(buf, ctx)); buf = ''; };
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === '$') {
        if (text[i + 1] === '$') {
          const e = text.indexOf('$$', i + 2);
          if (e >= 0) { flush(); out.push('<div class="dm">' + math(text.slice(i + 2, e), true) + '</div>'); i = e + 2; continue; }
        }
        // an inline formula goes to the paragraph as it is (it may contain \begin ... \end)
        let k = i + 1;
        while (k < n && !(text[k] === '$' && text[k - 1] !== '\\')) k++;
        const e = k < n ? k + 1 : n;
        buf += text.slice(i, e);
        i = e;
        continue;
      }
      if (c !== '\\') {
        let k = i + 1;
        while (k < n && text[k] !== '\\' && text[k] !== '$') k++;
        buf += text.slice(i, k);
        i = k;
        continue;
      }
      const rest = text.slice(i, i + 80);
      let m;
      if (rest.startsWith('\\[')) {
        const e = text.indexOf('\\]', i + 2);
        if (e >= 0) { flush(); out.push('<div class="dm">' + math(text.slice(i + 2, e), true) + '</div>'); i = e + 2; continue; }
      }
      if (rest.startsWith('\\(')) {
        const e = text.indexOf('\\)', i + 2);
        const stop = e >= 0 ? e + 2 : n;
        buf += text.slice(i, stop);
        i = stop;
        continue;
      }
      if ((m = /^\\begin\s*\{([^}]*)\}/.exec(rest))) {
        const name = m[1];
        const bodyStart = i + m[0].length;
        const end = matchEnd(text, bodyStart, name);
        const body = text.slice(bodyStart, end ? end.bodyEnd : n);
        const after = end ? end.after : n;
        flush();
        out.push(envHtml(name, body, text.slice(i, after), ctx));
        i = after;
        continue;
      }
      if ((m = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*/.exec(rest))) {
        let k = i + m[0].length;
        const o = readOpt(text, k); if (o) k = o.end;
        const g = readGroup(text, k);
        if (g) {
          flush();
          const level = SECTIONS[m[1]];
          out.push('<h' + Math.min(6, level) + ' class="sec">' + inline(g.text, ctx) + '</h' + Math.min(6, level) + '>');
          i = g.end;
          continue;
        }
      }
      if ((m = /^\\TSSVERB(\d+)\b/.exec(rest))) { flush(); out.push('<pre class="raw">' + esc(ctx.verb[+m[1]] || '') + '</pre>'); i += m[0].length; continue; }
      if ((m = /^\\(caption|subcaption)\*?\s*/.exec(rest))) {
        let k = i + m[0].length;
        const o = readOpt(text, k); if (o) k = o.end;
        const g = readGroup(text, k);
        if (g) { flush(); out.push('<div class="cap">' + inline(g.text, ctx) + '</div>'); i = g.end; continue; }
      }
      if ((m = /^\\includegraphics\b/.exec(rest))) {
        let k = i + m[0].length;
        const o = readOpt(text, k); if (o) k = o.end;
        const g = readGroup(text, k);
        if (g) { flush(); out.push(graphic(o ? o.text : '', g.text, ctx, true)); i = g.end; continue; }
      }
      if (/^\\par(?![A-Za-z@])/.test(rest)) { flush(); i += 4; continue; }
      // any other command belongs to the paragraph: copy its name (the arguments are copied with the following text)
      let k = i + 1;
      if (k < n && /[A-Za-z@]/.test(text[k])) { while (k < n && /[A-Za-z@]/.test(text[k])) k++; } else k = Math.min(n, k + 1);
      buf += text.slice(i, k);
      i = k;
    }
    flush();
    return out.join('');
  } finally { ctx.depth--; }
}

function envHtml(name, body, whole, ctx) {
  const base = name.replace(/\*$/, '');
  if (MATH_ENVS.has(name) || MATH_ENVS.has(base)) return '<div class="dm">' + math(mathEnv(name, body), true) + '</div>';
  if (name === 'document' || name === 'subequations') return blocks(body, ctx);
  if (LIST_ENVS.has(name)) return listHtml(name, body, ctx);
  if (TABLE_ENVS.has(name)) return tableHtml(whole, ctx);
  if (PICTURE_ENVS.has(name)) { note(ctx, name); return '<div class="ph">' + esc(name) + ': рисунок буде лише в PDF</div>'; }
  if (name === 'figure' || name === 'figure*' || name === 'table' || name === 'table*' || name === 'wrapfigure' || name === 'subfigure') return '<figure class="fl">' + blocks(body.replace(/^\s*(?:\[[^\]]*\]|\{[^}]*\})+/, ''), ctx) + '</figure>';
  if (BLOCK_STYLE[name]) return '<div style="' + BLOCK_STYLE[name] + '">' + blocks(body, ctx) + '</div>';
  if (name === 'quote' || name === 'quotation') return '<blockquote>' + blocks(body, ctx) + '</blockquote>';
  if (name === 'abstract') return '<div class="th"><b>Анотація.</b> ' + blocks(body, ctx) + '</div>';
  if (name === 'minipage') return '<div class="mp">' + blocks(body.replace(/^\s*(?:\[[^\]]*\])*\s*\{[^}]*\}/, ''), ctx) + '</div>';
  if (name === 'frame') return '<div class="th"><b>Слайд.</b> ' + blocks(body.replace(/^\s*\{[^}]*\}/, ''), ctx) + '</div>';
  if (Object.prototype.hasOwnProperty.call(THEOREMS, base)) {
    const o = readOpt(body, 0);
    const rest = o ? body.slice(o.end) : body;
    return '<div class="th th-' + esc(base) + '"><b>' + THEOREMS[base] + (o ? ' (' + inline(o.text, ctx) + ')' : '') + '.</b> ' + blocks(rest, ctx) + '</div>';
  }
  // an environment of the project or of a package: its content, with its name
  note(ctx, name);
  return '<div class="env"><span class="tag">' + esc(name) + '</span>' + blocks(body, ctx) + '</div>';
}

function render(src, opts) {
  const o = opts || {};
  const ctx = makeCtx(o);
  let text = String(src || '');
  const limit = o.limit || 200000;
  if (text.length > limit) { text = text.slice(0, limit); note(ctx, 'текст обрізано до ' + limit + ' символів'); }
  // verbatim blocks first: their % is not a comment
  text = text.replace(new RegExp('\\\\begin\\{(' + VERB_ENVS.map((v) => v.replace('*', '\\*')).join('|') + ')\\}(?:\\[[^\\]]*\\])?(?:\\{[^}]*\\})?([\\s\\S]*?)\\\\end\\{\\1\\}', 'g'), (m, name, body) => { ctx.verb.push(body.replace(/^\n/, '')); return '\n\n\\TSSVERB' + (ctx.verb.length - 1) + '\n\n'; });
  text = stripComments(text);
  let html = blocks(text, ctx);
  if (ctx.footnotes.length) html += '<div class="fns">' + ctx.footnotes.map((f, k) => '<div><sup>' + (k + 1) + '</sup> ' + f + '</div>').join('') + '</div>';
  return { html, notes: [...ctx.notes].filter(Boolean) };
}

module.exports = { render, esc, stripComments, splitItems, groupEnd, matchEnd };
