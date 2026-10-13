'use strict';
/* derivationPure.js: a derivation (align, gather, aligned inside equation) row by row, with what changed between neighbouring
 * rows coloured (no vscode dependency).
 *   splitRows(body)            rows of a body: cut by \\ outside of braces and environments; \label, \nonumber, \notag, \tag removed
 *   markPair(cur, prev, color) TeX of the row `cur` where the parts that are not in `prev` are coloured (\color{..}..\color{currentcolor})
 *   stepsFor(name, body, opts) null (fewer than 2 rows) | { full, plain, steps }: `full` all rows, each coloured against the row above,
 *                              `plain` the same without colour, `steps[k-1]` the rows 1..k, the row k coloured against the row k-1 and
 *                              what the row k-1 loses against the row k coloured in the second colour
 * The comparison works on atoms, not on characters: a symbol, a number, a command with its arguments, a { } group, \left..\right,
 * an environment, a nucleus with its scripts. Every atom is a whole piece of TeX, so a coloured piece is always valid TeX; when the
 * neighbours have the same shape (both groups, both \frac, both x^{..}) the comparison goes inside, so only the changed part is
 * coloured. The colour is a declaration (\color{c} .. \color{currentcolor}): the spacing of operators stays as it was. */

const COLOR_NEW = '#e8590c';
const COLOR_OLD = '#c2255c';
const MAX_ROWS = 60; // more rows than that are not compared
const MAX_STEPS = 24; // more rows than that get no step-by-step variants (their number grows with the square)
const MAX_PRODUCT = 60000; // atoms of the row times atoms of the neighbour: a longer pair is not compared

// commands that take arguments: the number of the arguments (single token or { } group each)
const ARITY = {
  frac: 2, dfrac: 2, tfrac: 2, cfrac: 2, binom: 2, dbinom: 2, tbinom: 2, stackrel: 2, overset: 2, underset: 2, textcolor: 2, colorbox: 2,
  sqrt: 1, vec: 1, hat: 1, bar: 1, dot: 1, ddot: 1, tilde: 1, widehat: 1, widetilde: 1, overline: 1, underline: 1, overrightarrow: 1, overleftarrow: 1,
  mathbf: 1, mathrm: 1, mathit: 1, mathcal: 1, mathbb: 1, mathsf: 1, mathtt: 1, mathfrak: 1, mathscr: 1, boldsymbol: 1, bm: 1, symbf: 1, symbfit: 1,
  text: 1, textrm: 1, textbf: 1, textit: 1, mbox: 1, operatorname: 1, mathop: 1, mathbin: 1, mathrel: 1, mathord: 1, mathopen: 1, mathclose: 1, mathpunct: 1,
  cancel: 1, boxed: 1, overbrace: 1, underbrace: 1, xrightarrow: 1, xleftarrow: 1, ce: 1, pu: 1, color: 1, phantom: 1, hphantom: 1, vphantom: 1,
  big: 1, Big: 1, bigg: 1, Bigg: 1, bigl: 1, bigr: 1, Bigl: 1, Bigr: 1, biggl: 1, biggr: 1, Biggl: 1, Biggr: 1, bigm: 1, Bigm: 1, biggm: 1, Biggm: 1
};
const OPT_ARG = new Set(['sqrt', 'xrightarrow', 'xleftarrow']);

/* ------------------------------ tokens ------------------------------ */
function tokenize(s) {
  const T = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') {
      const m = /^\\([A-Za-z@]+|[^A-Za-z@\s]|)/.exec(s.slice(i, i + 80));
      const v = m ? m[0] : '\\';
      if (v === '\\') { i++; continue; }
      T.push({ v, s: i, e: i + v.length, cs: /^\\[A-Za-z@]/.test(v) });
      i += v.length;
      continue;
    }
    T.push({ v: c, s: i, e: i + 1, cs: false });
    i++;
  }
  return T;
}

/* ------------------------------ atoms ------------------------------ */
function parse(src) {
  const T = tokenize(src);
  const st = { T, i: 0, src };
  const atoms = parseAtoms(st, null);
  return { atoms, T, src };
}

const isDigit = (t) => !!t && /^[0-9]$/.test(t.v);
const adjacent = (T, i) => i > 0 && i < T.length && T[i - 1].e === T[i].s;

function mk(st, k, si, props) {
  const T = st.T;
  const ei = st.i;
  const a = Object.assign({ k, si, ei, s: T[si].s, e: T[ei - 1].e }, props);
  a.key = T.slice(si, ei).map((t) => t.v).join(' ');
  return a;
}

function parseAtoms(st, stop) {
  const out = [];
  while (st.i < st.T.length) {
    const t = st.T[st.i];
    if (stop === 'brace' && t.v === '}') break;
    if (stop === 'right' && t.v === '\\right') break;
    out.push(parseScripts(st, false));
  }
  return out;
}

function parseScripts(st, unit) {
  const T = st.T;
  const si = st.i;
  const base = parseBase(st, unit);
  const scripts = [];
  while (st.i < T.length && (T[st.i].v === '^' || T[st.i].v === '_' || T[st.i].v === "'")) {
    const op = T[st.i].v;
    st.i++;
    if (op === "'") { scripts.push({ op, arg: null }); continue; }
    if (st.i >= T.length || T[st.i].v === '}' || T[st.i].v === '\\right') { scripts.push({ op, arg: null }); break; }
    scripts.push({ op, arg: parseUnit(st) });
  }
  if (!scripts.length) return base;
  return mk(st, 'scr', si, { base, scripts });
}

// one unit: a { } group, a command (with its arguments) or one character
function parseUnit(st) {
  const t = st.T[st.i];
  if (t.v === '{' || t.cs) return parseBase(st, true);
  const si = st.i;
  st.i++;
  return mk(st, 'leaf', si, {});
}

function parseBase(st, unit) {
  const T = st.T;
  const si = st.i;
  const t = T[st.i];
  if (t.v === '{') {
    st.i++;
    const kids = parseAtoms(st, 'brace');
    if (st.i < T.length && T[st.i].v === '}') st.i++;
    return mk(st, 'group', si, { kids });
  }
  if (t.v === '\\left') {
    st.i++;
    const open = st.i < T.length ? T[st.i].v : '';
    if (st.i < T.length) st.i++;
    const kids = parseAtoms(st, 'right');
    let close = null;
    if (st.i < T.length && T[st.i].v === '\\right') {
      st.i++;
      close = st.i < T.length ? T[st.i].v : '';
      if (st.i < T.length) st.i++;
    }
    return mk(st, 'lr', si, { open, close, kids });
  }
  if (t.v === '\\begin') {
    let depth = 0;
    let j = st.i;
    for (; j < T.length; j++) {
      if (T[j].v === '\\begin') depth++;
      else if (T[j].v === '\\end') { depth--; if (depth === 0) break; }
    }
    if (j >= T.length) { st.i++; return mk(st, 'leaf', si, {}); } // no \end: the command alone
    st.i = j + 1;
    if (T[st.i] && T[st.i].v === '{') { while (st.i < T.length && T[st.i].v !== '}') st.i++; if (st.i < T.length) st.i++; }
    return mk(st, 'env', si, {});
  }
  if (t.cs) {
    st.i++;
    const name = t.v.slice(1);
    const known = Object.prototype.hasOwnProperty.call(ARITY, name);
    let opt = null;
    const args = [];
    if ((known ? OPT_ARG.has(name) : true) && st.i < T.length && T[st.i].v === '[' && (known || adjacent(T, st.i))) {
      // [..] up to the matching ]: for a command of the project (\E[B]) too; only when the ] is found before the end of the group
      let depth = 0;
      let j = st.i;
      for (; j < T.length; j++) {
        if (T[j].v === '{') depth++;
        else if (T[j].v === '}') { depth--; if (depth < 0) { j = T.length; break; } } else if (T[j].v === ']' && depth === 0) break;
      }
      if (j < T.length) { opt = st.src.slice(T[st.i].e, T[j].s); st.i = j + 1; }
    }
    if (known) {
      for (let n = ARITY[name]; n > 0 && st.i < T.length; n--) {
        if (T[st.i].v === '}' || T[st.i].v === '\\right') break;
        args.push(parseUnit(st));
      }
    } else {
      while (st.i < T.length && T[st.i].v === '{' && adjacent(T, st.i)) args.push(parseBase(st, true));
    }
    return mk(st, 'cmd', si, { name, opt, args });
  }
  // digits: a number is one atom (outside of the argument of a script, where TeX takes one digit)
  if (isDigit(t) && !unit) {
    st.i++;
    while (st.i < T.length && (isDigit(T[st.i]) || ((T[st.i].v === '.' || T[st.i].v === ',') && isDigit(T[st.i + 1]) && adjacent(T, st.i) && adjacent(T, st.i + 1)))) st.i++;
    return mk(st, 'num', si, {});
  }
  st.i++;
  return mk(st, 'leaf', si, {});
}

/* ------------------------------ comparison ------------------------------ */
function lcsMatch(B, A) {
  const n = B.length;
  const m = A.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i * w + j] = B[i].key === A[j].key ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const match = new Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (B[i].key === A[j].key) { match[i] = j; i++; j++; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return match;
}

const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

function colorOf(c, raw, braced) {
  return braced ? '{\\color{' + c + '}' + raw + '}' : '\\color{' + c + '}' + raw + '\\color{currentcolor}';
}

// the atom with a colour (an atom of a row that has no counterpart)
function mark(ctx, a, braced) {
  const raw = ctx.src.slice(a.s, a.e);
  if (a.k === 'leaf' && (a.key === '&' || a.key === '~')) return raw;
  return colorOf(ctx.color, raw, braced);
}

// the atoms of B written out; what is not in A is coloured. gap: the text between two atoms is kept (it is blank)
function emitList(ctx, B, A) {
  if (!B.length) return '';
  const join = (parts) => parts.map((p, i) => (i ? ctx.src.slice(B[i - 1].e, B[i].s) : '') + p).join('');
  if (!A || B.length * Math.max(1, A.length) > MAX_PRODUCT) return join(B.map((b) => ctx.src.slice(b.s, b.e)));
  const match = lcsMatch(B, A);
  const parts = new Array(B.length);
  let prevA = -1;
  let j = 0;
  while (j < B.length) {
    if (match[j] >= 0) { parts[j] = ctx.src.slice(B[j].s, B[j].e); prevA = match[j]; j++; continue; }
    let j1 = j;
    while (j1 < B.length && match[j1] < 0) j1++;
    const nextA = j1 < B.length ? match[j1] : A.length;
    const bRun = B.slice(j, j1);
    const aRun = A.slice(prevA + 1, nextA);
    for (let k = 0; k < bRun.length; k++) {
      const b = bRun[k];
      parts[j + k] = bRun.length === aRun.length && sameShape(b, aRun[k]) ? emitInside(ctx, b, aRun[k]) : mark(ctx, b, false);
    }
    j = j1;
  }
  return join(parts);
}

const sameShape = (b, a) => {
  if (b.k !== a.k) return false;
  if (b.k === 'group') return true;
  if (b.k === 'lr') return b.open === a.open && b.close === a.close;
  if (b.k === 'cmd') return b.name === a.name && b.args.length === a.args.length && b.opt === a.opt && b.args.length > 0;
  if (b.k === 'scr') return (b.base.key === a.base.key || sameShape(b.base, a.base)) && same(b.scripts.map((x) => x.op), a.scripts.map((x) => x.op)) && b.scripts.every((x) => x.arg);
  return false;
};

// an argument of a command or of a script: a group is compared inside, a single token is coloured in braces
function emitArg(ctx, b, a) {
  if (b.key === a.key) return ctx.src.slice(b.s, b.e);
  if (b.k === 'group' && a.k === 'group') return emitInside(ctx, b, a);
  if (sameShape(b, a)) return emitInside(ctx, b, a);
  return mark(ctx, b, true);
}

function emitInside(ctx, b, a) {
  const src = ctx.src;
  const gap = (x) => (x.s > 0 && /\s/.test(src[x.s - 1]) ? ' ' : '');
  if (b.k === 'group') return '{' + emitList(ctx, b.kids, a.kids) + '}';
  if (b.k === 'lr') return '\\left' + b.open + emitList(ctx, b.kids, a.kids) + (b.close === null ? '' : '\\right' + b.close);
  if (b.k === 'cmd') return '\\' + b.name + (b.opt === null ? '' : '[' + b.opt + ']') + b.args.map((x, i) => gap(x) + emitArg(ctx, x, a.args[i])).join('');
  // scr: the base as it is, the arguments of the scripts inside
  return (b.base.key === a.base.key ? src.slice(b.base.s, b.base.e) : emitInside(ctx, b.base, a.base)) + b.scripts.map((x, i) => x.op + emitArg(ctx, x.arg, a.scripts[i].arg)).join('');
}

// the row `cur` as TeX; what has no counterpart in `prev` is coloured
function markPair(cur, prev, color) {
  const B = parse(cur);
  if (prev === null || prev === undefined) return String(cur);
  const A = parse(prev);
  const ctx = { src: B.src, color: color || COLOR_NEW };
  // a row that goes on from the left side (&= ...) against a row with the left side: only what stands after & is compared,
  // the left side is not "lost" or "new" there
  const bi = B.atoms.findIndex((x) => x.key === '&');
  const ai = A.atoms.findIndex((x) => x.key === '&');
  if (bi >= 0 && ai >= 0 && bi !== ai && (bi === 0 || ai === 0)) {
    const head = B.src.slice(B.atoms[0].s, B.atoms[bi].e);
    const rest = B.atoms.slice(bi + 1);
    if (!rest.length) return head;
    return head + B.src.slice(B.atoms[bi].e, rest[0].s) + emitList(ctx, rest, A.atoms.slice(ai + 1));
  }
  return emitList(ctx, B.atoms, A.atoms);
}

/* ------------------------------ rows ------------------------------ */
const CLEAN_RE = /\\(?:label|tag\*?)\s*\{[^{}]*\}|\\(?:nonumber|notag)\b/g;

function stripComment(line) {
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '\\') { k++; continue; }
    if (line[k] === '%') return line.slice(0, k);
  }
  return line;
}

function splitRows(body) {
  const text = String(body).split(/\r?\n/).map(stripComment).join('\n');
  const rows = [];
  let depth = 0;
  let env = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\\') {
        if (depth === 0 && env === 0) {
          rows.push(text.slice(from, i));
          let j = i + 2;
          if (text[j] === '*') j++;
          const m = /^\s*\[[^\]\n]*\]/.exec(text.slice(j));
          if (m) j += m[0].length;
          from = j;
          i = j - 1;
        } else i++;
        continue;
      }
      const m = /^\\(begin|end)\s*\{/.exec(text.slice(i, i + 12));
      if (m) env += m[1] === 'begin' ? 1 : -1;
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  rows.push(text.slice(from));
  return rows.map((r) => r.replace(CLEAN_RE, '').replace(/\s+/g, ' ').trim()).filter((r) => r !== '');
}

const WRAP = { align: 'aligned', flalign: 'aligned', alignat: 'aligned', split: 'aligned', eqnarray: 'aligned', gather: 'gathered', aligned: 'aligned', gathered: 'gathered' };
const wrap = (kind, rows) => '\\begin{' + kind + '}' + rows.join(' \\\\ ') + '\\end{' + kind + '}';

// the rows of an environment that is a derivation: [kind, rows] or null
function rowsOf(name, body) {
  const base = String(name).replace(/\*$/, '');
  let b = String(body);
  let kind = WRAP[base];
  if (base === 'equation' || base === 'displaymath' || base === '') {
    const m = /^\s*\\begin\{(aligned|split|gathered|align|gather)\*?\}([\s\S]*)\\end\{\1\*?\}\s*$/.exec(b);
    if (!m) return null;
    kind = WRAP[m[1]];
    b = m[2];
    if (/\\begin\{(?:aligned|split|gathered|align|gather)\*?\}/.test(b)) return null; // a second block inside: not a plain derivation
  } else if (!kind) return null;
  if (base === 'alignat') b = b.replace(/^\s*\{[^}]*\}/, '');
  if (/^\s*\{[^}]*\}/.test(b) && /^(?:aligned|gathered)$/.test(kind) && /^\s*\{[lcr]+\}/.test(b)) b = b.replace(/^\s*\{[lcr]+\}/, '');
  const rows = splitRows(b);
  return rows.length >= 2 ? { kind, rows } : null;
}

function stepsFor(name, body, opts) {
  const o = opts || {};
  const r = rowsOf(name, body);
  if (!r || r.rows.length > MAX_ROWS) return null;
  const cNew = o.colorNew || COLOR_NEW;
  const cOld = o.colorOld || COLOR_OLD;
  const rows = r.rows;
  const full = rows.map((row, i) => (i ? markPair(row, rows[i - 1], cNew) : row));
  const out = { full: wrap(r.kind, full), plain: wrap(r.kind, rows), steps: [], count: rows.length };
  if (rows.length <= MAX_STEPS) {
    for (let k = 1; k <= rows.length; k++) {
      const part = rows.slice(0, k).map((row, i) => {
        if (i === k - 1 && i > 0) return markPair(row, rows[i - 1], cNew);
        if (i === k - 2 && k >= 2) return markPair(row, rows[i + 1], cOld);
        return row;
      });
      out.steps.push(wrap(r.kind, part));
    }
  }
  return out;
}

module.exports = { splitRows, markPair, stepsFor, rowsOf, parse, tokenize, COLOR_NEW, COLOR_OLD, MAX_ROWS, MAX_STEPS };
