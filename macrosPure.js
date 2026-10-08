'use strict';
/* Parser of user macros defined in a class / package / preamble (no vscode dependency).
 * scanMacros(text) -> [{ kind: 'cmd'|'env', name, op, nargs, optDefault, spec, tokens,
 *                        body, line, endLine, src, doc, alias }]
 * Understands \newcommand & co, xparse (\NewDocumentCommand ...), \DeclareMathOperator,
 * \newenvironment & co, \newtheorem, tcolorbox boxes, \def/\gdef/\edef/\xdef, \let, \newif. */

const CMD_KINDS = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand']);
const XP_CMD_KINDS = new Set(['NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand',
  'DeclareDocumentCommand', 'NewExpandableDocumentCommand', 'RenewExpandableDocumentCommand',
  'ProvideExpandableDocumentCommand', 'DeclareExpandableDocumentCommand']);
const ENV_KINDS = new Set(['newenvironment', 'renewenvironment']);
const XP_ENV_KINDS = new Set(['NewDocumentEnvironment', 'RenewDocumentEnvironment',
  'ProvideDocumentEnvironment', 'DeclareDocumentEnvironment']);
const TCB_KINDS = new Set(['newtcolorbox', 'renewtcolorbox', 'DeclareTColorBox', 'NewTColorBox', 'RenewTColorBox',
  'ProvideTColorBox']);
const DEF_KINDS = new Set(['def', 'gdef', 'edef', 'xdef']);
const KINDS = [...CMD_KINDS, ...XP_CMD_KINDS, ...ENV_KINDS, ...XP_ENV_KINDS, ...TCB_KINDS, ...DEF_KINDS,
  'DeclareMathOperator', 'newtheorem', 'let', 'newif', 'NewCommandCopy', 'RenewCommandCopy', 'DeclareCommandCopy'];
const DEF_RE = new RegExp('\\\\(' + KINDS.join('|') + ')(?![A-Za-z@])', 'g');

function stripComments(text) {
  return text.split('\n').map((l) => {
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '\\') { i++; continue; }
      if (l[i] === '%') return l.slice(0, i) + ' '.repeat(l.length - i);
    }
    return l;
  }).join('\n');
}

// s[i] === open: returns { text, end } (end = index after the closing char), or null
function readGroup(s, i, open, close) {
  if (s[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (open === '{' && depth === 0) return { text: s.slice(i + 1, j), end: j + 1 }; }
    else if (open === '[' && c === ']' && depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
    if (depth < 0) return null;
  }
  return null;
}

const skipWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

// \name or {\name}; returns { name, end } with the backslash removed
function readCsName(s, i) {
  i = skipWs(s, i);
  let braced = false;
  if (s[i] === '{') { braced = true; i = skipWs(s, i + 1); }
  const m = /^\\([A-Za-z@]+|[^A-Za-z@\s])/.exec(s.slice(i, i + 64));
  if (!m) return null;
  let end = i + m[0].length;
  if (braced) {
    end = skipWs(s, end);
    if (s[end] !== '}') return null;
    end++;
  }
  return { name: m[1], end };
}

function readName(s, i) { // {envname}
  i = skipWs(s, i);
  const g = readGroup(s, i, '{', '}');
  if (!g) return null;
  return { name: g.text.trim(), end: g.end };
}

// xparse argument specification -> tokens
function parseXparseSpec(spec) {
  const out = [];
  let i = 0;
  while (i < spec.length) {
    const c = spec[i];
    if (/\s/.test(c) || c === '+' || c === '!') { i++; continue; }
    if (c === '>') { i++; const g = readGroup(spec, i, '{', '}'); i = g ? g.end : i + 1; continue; }
    i++;
    const group = () => { i = skipWs(spec, i); const g = readGroup(spec, i, '{', '}'); if (g) { i = g.end; return g.text; } return null; };
    if (c === 'm') out.push({ t: 'm', open: '{', close: '}', optional: false });
    else if (c === 'v') out.push({ t: 'v', open: '|', close: '|', optional: false });
    else if (c === 'o') out.push({ t: 'o', open: '[', close: ']', optional: true });
    else if (c === 'O') out.push({ t: 'O', open: '[', close: ']', optional: true, def: group() });
    else if (c === 's') out.push({ t: 's', open: '*', close: '', optional: true });
    else if (c === 't') { const tk = spec[i++] || ''; out.push({ t: 't', open: tk, close: '', optional: true }); }
    else if (c === 'g') out.push({ t: 'g', open: '{', close: '}', optional: true });
    else if (c === 'G') out.push({ t: 'G', open: '{', close: '}', optional: true, def: group() });
    else if (c === 'd' || c === 'D' || c === 'r' || c === 'R') {
      let o; let cl;
      if (spec[i] === '<') { const e = spec.indexOf('>', i); o = spec.slice(i + 1, e < 0 ? i + 1 : e); cl = ''; i = e < 0 ? i + 1 : e + 1; }
      else { o = spec[i] || ''; cl = spec[i + 1] || ''; i += 2; }
      const tok = { t: c, open: o, close: cl, optional: c === 'd' || c === 'D' };
      if (c === 'D' || c === 'R') tok.def = group();
      out.push(tok);
    } else if (c === 'e' || c === 'E') {
      const g = group();
      const tok = { t: c, open: g || '^_', close: '', optional: true };
      if (c === 'E') tok.def = group();
      out.push(tok);
    } else out.push({ t: c, open: '{', close: '}', optional: false });
  }
  return out;
}

// the tokens of a classic \newcommand[n][default]
function classicTokens(nargs, optDefault) {
  const out = [];
  for (let k = 1; k <= nargs; k++) {
    if (k === 1 && optDefault !== null) out.push({ t: 'O', open: '[', close: ']', optional: true, def: optDefault });
    else out.push({ t: 'm', open: '{', close: '}', optional: false });
  }
  return out;
}

function lineStarts(text) {
  const a = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') a.push(i + 1);
  return a;
}
function lineOf(starts, off) {
  let lo = 0; let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo;
}

const RULE_LINE = /^[\s%\-=*#_~+.]{5,}$/;
const undecorate = (t) => t.replace(/^[-=*#_~]{3,}\s*/, '').replace(/\s*[-=*#_~]{3,}$/, '').trim();
function commentAbove(lines, line) {
  const out = [];
  for (let k = line - 1; k >= 0; k--) {
    const t = lines[k];
    if (!/^\s*%/.test(t)) break;
    if (RULE_LINE.test(t)) { if (out.length) break; continue; }
    out.unshift(undecorate(t.replace(/^\s*%+\s?/, '').replace(/\s+$/, '')));
    if (out.length >= 12) break;
  }
  return out.filter(Boolean).join('\n').trim();
}
function trailingComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '%') return undecorate(line.slice(i).replace(/^%+\s?/, '').trim());
  }
  return '';
}

function scanMacros(text) {
  text = String(text).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const s = stripComments(text);
  const starts = lineStarts(s);
  const out = [];
  let skipUntil = 0;
  DEF_RE.lastIndex = 0;
  let m;
  while ((m = DEF_RE.exec(s))) {
    if (m.index < skipUntil) continue;
    const kind = m[1];
    let i = m.index + m[0].length;
    let star = false;
    if (s[i] === '*') { star = true; i++; }
    const entry = { kind: 'cmd', name: '', op: false, nargs: 0, optDefault: null, spec: null, tokens: [], body: '', alias: null };
    let end = null;

    if (CMD_KINDS.has(kind) || XP_CMD_KINDS.has(kind) || kind === 'NewCommandCopy' || kind === 'RenewCommandCopy' || kind === 'DeclareCommandCopy') {
      const nm = readCsName(s, i);
      if (!nm) continue;
      entry.name = nm.name;
      let j = nm.end;
      if (CMD_KINDS.has(kind)) {
        j = skipWs(s, j);
        let nargs = 0; let def = null;
        let g = readGroup(s, j, '[', ']');
        if (g && /^\s*\d\s*$/.test(g.text)) { nargs = parseInt(g.text, 10); j = skipWs(s, g.end); g = readGroup(s, j, '[', ']'); if (g) { def = g.text; j = skipWs(s, g.end); } }
        else if (g) continue;
        const body = readGroup(s, j, '{', '}');
        if (!body) continue;
        entry.nargs = nargs; entry.optDefault = def; entry.body = body.text.trim();
        entry.tokens = classicTokens(nargs, def);
        end = body.end;
      } else if (XP_CMD_KINDS.has(kind)) {
        j = skipWs(s, j);
        const sp = readGroup(s, j, '{', '}');
        if (!sp) continue;
        const body = readGroup(s, skipWs(s, sp.end), '{', '}');
        if (!body) continue;
        entry.spec = sp.text.trim(); entry.tokens = parseXparseSpec(sp.text); entry.nargs = entry.tokens.length;
        entry.body = body.text.trim();
        end = body.end;
      } else {
        const tgt = readCsName(s, nm.end);
        if (!tgt) continue;
        entry.alias = tgt.name; entry.body = '\\' + tgt.name; end = tgt.end;
      }
    } else if (kind === 'DeclareMathOperator') {
      const nm = readCsName(s, i);
      if (!nm) continue;
      const body = readGroup(s, skipWs(s, nm.end), '{', '}');
      if (!body) continue;
      entry.name = nm.name; entry.op = true; entry.starred = star; entry.body = body.text.trim();
      end = body.end;
    } else if (DEF_KINDS.has(kind)) {
      const nm = readCsName(s, i);
      if (!nm) continue;
      let j = nm.end; let n = 0;
      const params = [];
      while (j < s.length && s[j] !== '{' && s[j] !== '\n' || (s[j] === '\n' && /^\s*[#{]/.test(s.slice(j, j + 8)))) {
        if (s[j] === '#' && /\d/.test(s[j + 1] || '')) { n++; params.push('#' + s[j + 1]); j += 2; continue; }
        j++;
      }
      const body = readGroup(s, skipWs(s, j), '{', '}');
      if (!body) continue;
      entry.name = nm.name; entry.nargs = n; entry.tokens = classicTokens(n, null); entry.body = body.text.trim();
      end = body.end;
    } else if (kind === 'let') {
      const nm = readCsName(s, i);
      if (!nm) continue;
      let j = skipWs(s, nm.end);
      if (s[j] === '=') j++;
      const tgt = readCsName(s, j);
      if (!tgt) continue;
      entry.name = nm.name; entry.alias = tgt.name; entry.body = '\\' + tgt.name; end = tgt.end;
    } else if (kind === 'newif') {
      const nm = readCsName(s, i);
      if (!nm || !/^if./.test(nm.name)) continue;
      const base = nm.name.slice(2);
      end = nm.end;
      const line0 = lineOf(starts, m.index);
      for (const n2 of [nm.name, base + 'true', base + 'false']) {
        out.push(Object.assign({}, entry, { name: n2, body: '', newif: true, line: line0, endLine: line0, src: lines[line0].trim(), doc: '' }));
      }
      skipUntil = end;
      continue;
    } else if (kind === 'newtheorem') {
      const nm = readName(s, i);
      if (!nm) continue;
      let j = skipWs(s, nm.end);
      let title = '';
      const g1 = readGroup(s, j, '[', ']');
      if (g1) j = skipWs(s, g1.end);
      const g2 = readGroup(s, j, '{', '}');
      if (g2) { title = g2.text.trim(); j = g2.end; }
      const g3 = readGroup(s, skipWs(s, j), '[', ']');
      if (g3) j = g3.end;
      entry.kind = 'env'; entry.name = nm.name; entry.body = title ? 'theorem: ' + title : 'theorem'; entry.theorem = true;
      end = j;
    } else if (TCB_KINDS.has(kind)) {
      let j = skipWs(s, i);
      const init = readGroup(s, j, '[', ']');
      if (init) j = skipWs(s, init.end);
      const nm = readName(s, j);
      if (!nm) continue;
      j = skipWs(s, nm.end);
      entry.kind = 'env'; entry.name = nm.name;
      if (kind === 'NewTColorBox' || kind === 'RenewTColorBox' || kind === 'ProvideTColorBox' || kind === 'DeclareTColorBox') {
        const sp = readGroup(s, j, '{', '}');
        if (!sp) continue;
        entry.spec = sp.text.trim(); entry.tokens = parseXparseSpec(sp.text); entry.nargs = entry.tokens.length;
        const opts = readGroup(s, skipWs(s, sp.end), '{', '}');
        end = opts ? opts.end : sp.end;
        entry.body = opts ? opts.text.trim() : '';
      } else {
        let nargs = 0; let def = null;
        let g = readGroup(s, j, '[', ']');
        if (g && /^\s*\d\s*$/.test(g.text)) { nargs = parseInt(g.text, 10); j = skipWs(s, g.end); g = readGroup(s, j, '[', ']'); if (g) { def = g.text; j = skipWs(s, g.end); } }
        const opts = readGroup(s, j, '{', '}');
        end = opts ? opts.end : j;
        entry.nargs = nargs; entry.optDefault = def; entry.tokens = classicTokens(nargs, def); entry.body = opts ? opts.text.trim() : '';
      }
    } else if (ENV_KINDS.has(kind) || XP_ENV_KINDS.has(kind)) {
      const nm = readName(s, i);
      if (!nm) continue;
      let j = skipWs(s, nm.end);
      entry.kind = 'env'; entry.name = nm.name;
      if (ENV_KINDS.has(kind)) {
        let nargs = 0; let def = null;
        let g = readGroup(s, j, '[', ']');
        if (g && /^\s*\d\s*$/.test(g.text)) { nargs = parseInt(g.text, 10); j = skipWs(s, g.end); g = readGroup(s, j, '[', ']'); if (g) { def = g.text; j = skipWs(s, g.end); } }
        entry.nargs = nargs; entry.optDefault = def; entry.tokens = classicTokens(nargs, def);
      } else {
        const sp = readGroup(s, j, '{', '}');
        if (!sp) continue;
        entry.spec = sp.text.trim(); entry.tokens = parseXparseSpec(sp.text); entry.nargs = entry.tokens.length;
        j = skipWs(s, sp.end);
      }
      const b1 = readGroup(s, j, '{', '}');
      if (!b1) continue;
      const b2 = readGroup(s, skipWs(s, b1.end), '{', '}');
      entry.body = b1.text.trim();
      end = b2 ? b2.end : b1.end;
    }
    if (end === null || !entry.name) continue;
    skipUntil = end;
    if (entry.name.includes('@')) continue; // internal macros of the class
    const line0 = lineOf(starts, m.index);
    const line1 = lineOf(starts, Math.max(m.index, end - 1));
    entry.line = line0; entry.endLine = line1;
    entry.src = lines.slice(line0, Math.min(line1 + 1, line0 + 14)).join('\n').replace(/\s+$/, '');
    if (line1 - line0 + 1 > 14) entry.src += '\n…';
    entry.doc = commentAbove(lines, line0) || trailingComment(lines[line1] || '');
    out.push(entry);
  }
  // \let\a\b: take the argument signature from \b when it is known
  const by = new Map(out.filter((e) => e.kind === 'cmd').map((e) => [e.name, e]));
  for (const e of out) {
    if (e.alias && by.has(e.alias)) {
      const t = by.get(e.alias);
      e.nargs = t.nargs; e.optDefault = t.optDefault; e.spec = t.spec; e.tokens = t.tokens;
    }
  }
  return out;
}

/* ---------------------------- signatures ---------------------------- */
// { label, params: [[start, end], ...] } where params follow e.tokens (null for non-parameters)
function signatureParts(e) {
  let label = e.kind === 'env' ? e.name : '\\' + e.name;
  if (e.op) return { label: label + (e.starred ? '[*]' : ''), params: [] };
  const params = [];
  e.tokens.forEach((t, idx) => {
    const n = idx + 1;
    let piece;
    if (t.t === 's') piece = '*';
    else if (t.t === 't') piece = t.open;
    else if (t.t === 'e' || t.t === 'E') piece = t.open + '\u2026';
    else if (t.t === 'v') piece = '|#' + n + '|';
    else piece = (t.open || '') + '#' + n + (t.def !== undefined && t.def !== null && t.def !== '' ? '=' + t.def : '') + (t.close || '');
    params.push([label.length, label.length + piece.length]);
    label += piece;
  });
  return { label, params };
}
const signature = (e) => signatureParts(e).label;

// positional tokens that must be filled in when a command is inserted
function mandatoryTokens(e) {
  return e.tokens.map((t, i) => ({ t, i })).filter((x) => !x.t.optional && x.t.t !== 'v');
}

/* ------------------------- reading a call site ---------------------- */
// reads the arguments written after \name at `from` according to the tokens
function readCall(text, from, tokens) {
  let j = from;
  const args = [];
  let star = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 's') { if (text[j] === '*') { star = true; j++; } args.push(null); continue; }
    if (t.t === 't') { if (text[j] === t.open) j++; args.push(null); continue; }
    if (t.t === 'e' || t.t === 'E' || t.t === 'v') { args.push(null); continue; }
    const k0 = t.optional ? j : skipWs(text, j);
    const jj = t.optional ? skipWs(text, j) : k0;
    let g = null;
    if (t.open === '{') g = readGroup(text, jj, '{', '}');
    else if (t.open === '[') g = readGroup(text, jj, '[', ']');
    else if (t.open && t.close) {
      if (text.slice(jj, jj + t.open.length) === t.open) {
        const e = text.indexOf(t.close, jj + t.open.length);
        if (e >= 0) g = { text: text.slice(jj + t.open.length, e), end: e + t.close.length };
      }
    }
    if (g) { args.push(g.text); j = g.end; }
    else if (t.optional) args.push(t.def === undefined ? null : t.def);
    else return { args, end: j, complete: false, star };
  }
  return { args, end: j, complete: true, star };
}

// one-level expansion of the macro body with the given arguments
function expand(e, args) {
  if (!e.body) return '';
  return e.body.replace(/##|#([1-9])/g, (all, d) => {
    if (all === '##') return '#';
    const v = args[parseInt(d, 10) - 1];
    return v === null || v === undefined ? all : v;
  });
}

// innermost command whose argument is being typed at the end of `text`
function callContext(text) {
  const s = stripComments(text);
  const stack = [];
  const closed = new Map(); // end index -> { open index, type }
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{' || c === '[') stack.push({ i, c });
    else if (c === '}' || c === ']') {
      const want = c === '}' ? '{' : '[';
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].c === want) { closed.set(i + 1, { open: stack[k].i, type: want }); stack.length = k; break; }
      }
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const g = stack[k];
    // go backwards over the preceding argument groups to the command name
    let p = g.i; let count = 0;
    const types = [];
    for (;;) {
      let q = p;
      while (q > 0 && /\s/.test(s[q - 1])) q--;
      const cl = closed.get(q);
      if (cl) { p = cl.open; count++; types.unshift(cl.type); continue; }
      const m = /\\([A-Za-z@]+)(\*?)$/.exec(s.slice(Math.max(0, q - 64), q));
      if (m) return { name: m[1], start: q - m[0].length, nameEnd: q, groups: count, types, type: g.c, open: g.i };
      break;
    }
  }
  return null;
}


/* ------------------- export for the LaTeX Workshop math preview ------------------- */
// unicode-math / LaTeX font commands -> what MathJax knows
const MJ_FONT = {
  symbf: 'mathbf', symbfup: 'mathbf', mathbfup: 'mathbf', symup: 'mathrm', symrm: 'mathrm', symit: 'mathit',
  symbfit: 'boldsymbol', mathbfit: 'boldsymbol', symsf: 'mathsf', symtt: 'mathtt', symcal: 'mathcal',
  symscr: 'mathscr', symbb: 'mathbb', symfrak: 'mathfrak', symbffrak: 'mathfrak'
};
const MJ_BAD = /\\(?:par|section|subsection|subsubsection|chapter|vspace|hspace|label|ref|eqref|autoref|cref|cite|item|includegraphics|setlength|newcommand|renewcommand|providecommand|def|gdef|edef|xdef|let|AtBeginDocument|AtEndDocument|ifdefined|ifx|csname|expandafter|directlua|ExplSyntaxOn|NewDocumentCommand|tcolorbox|hypersetup|includepdf|input|include|usepackage|footnote|caption|centering|noindent|newpage|clearpage|marginpar)(?![A-Za-z])/;

// \vect{ARG} where \vect is just \symbf{#1}: use the font command directly, so that
// the choice between \mathbf and \boldsymbol (Greek, \nabla) can look at ARG
function inlineWrappers(body, wrappers) {
  if (!wrappers.size) return body;
  let out = ''; let i = 0;
  const re = /\\([A-Za-z]+)/g;
  while (i < body.length) {
    re.lastIndex = i;
    const m = re.exec(body);
    if (!m) { out += body.slice(i); break; }
    out += body.slice(i, m.index);
    const font = wrappers.get(m[1]);
    const g = font ? readGroup(body, skipWs(body, m.index + m[0].length), '{', '}') : null;
    if (g) { out += '\\' + font + '{' + inlineWrappers(g.text, wrappers) + '}'; i = g.end; } else { out += m[0]; i = m.index + m[0].length; }
  }
  return out;
}

function toMathJaxBody(body) {
  let out = '';
  let i = 0;
  const re = /\\([A-Za-z]+)/g;
  re.lastIndex = 0;
  while (i < body.length) {
    re.lastIndex = i;
    const m = re.exec(body);
    if (!m) { out += body.slice(i); break; }
    out += body.slice(i, m.index);
    const target = MJ_FONT[m[1]];
    if (!target) { out += m[0]; i = m.index + m[0].length; continue; }
    const j = skipWs(body, m.index + m[0].length);
    const g = readGroup(body, j, '{', '}');
    let name = target;
    if (g && m[1] === 'symbf' && /\\[A-Za-z]/.test(g.text.replace(/\\(?:mathrm|mathit|text)\b/g, ''))) name = 'boldsymbol';
    out += '\\' + name;
    i = m.index + m[0].length;
  }
  return out.replace(/\s*\n\s*/g, ' ').trim();
}

// entries (from scanMacros, in order) -> { text, skipped: [names], count }
function toMathJaxMacros(entries, headerNote) {
  const byName = new Map();
  for (const e of entries) if (e.kind === 'cmd' && !e.newif) { byName.delete(e.name); byName.set(e.name, e); }
  const lines = [];
  const skipped = [];
  const wrappers = new Map();
  for (const e of byName.values()) {
    const w = e.kind === 'cmd' && !e.op && !e.alias && e.nargs === 1 && e.optDefault === null && e.spec === null
      ? /^\\(sym[a-z]+|mathbf[a-z]*)\{#1\}$/.exec(e.body) : null;
    if (w && MJ_FONT[w[1]]) wrappers.set(e.name, w[1]);
  }
  for (const e of byName.values()) {
    if (/[^A-Za-z]/.test(e.name)) { skipped.push(e.name); continue; }
    if (e.op) { lines.push('\\DeclareMathOperator' + (e.starred ? '*' : '') + '{\\' + e.name + '}{' + toMathJaxBody(e.body) + '}'); continue; }
    let toks = e.tokens;
    if (e.spec !== null) {
      if (toks.some((t) => t.t === 'o' || !'mO'.includes(t.t))) { skipped.push(e.name); continue; }
      if (toks.some((t, k) => t.t === 'O' && k !== 0)) { skipped.push(e.name); continue; }
    }
    const n = toks.length;
    let def = '';
    if (n && toks[0].t === 'O') def = '[' + (toks[0].def || '') + ']';
    let body;
    if (e.alias) {
      body = '\\' + e.alias + (toks.length ? toks.map((t, k) => (k === 0 && t.t === 'O' ? '' : '{#' + (k + 1) + '}')).join('') : '');
      if (toks.some((t) => t.t === 'O')) { skipped.push(e.name); continue; }
    } else {
      if (MJ_BAD.test(e.body)) { skipped.push(e.name); continue; }
      body = toMathJaxBody(inlineWrappers(e.body, wrappers));
    }
    lines.push('\\newcommand{\\' + e.name + '}' + (n ? '[' + n + ']' : '') + def + '{' + body + '}');
  }
  const head = ['% ' + (headerNote || 'Generated by TSS Workflow'), '% Do not edit by hand: regenerate with the command Generate MathJax macros file.'];
  if (skipped.length) head.push('% Skipped (not expressible in MathJax): ' + skipped.join(', '));
  return { text: head.join('\n') + '\n' + lines.join('\n') + '\n', skipped, count: lines.length };
}

// the same macros as a KaTeX `macros` object: { '\\name': 'body with #1' } (used by the table editor)
function toKatexMacros(entries) {
  const out = {};
  for (const line of toMathJaxMacros(entries).text.split('\n')) {
    let m = /^\\newcommand\{\\([A-Za-z]+)\}(?:\[\d+\])?(\[[^\]]*\])?\{(.*)\}$/.exec(line);
    if (m) { if (!m[2]) out['\\' + m[1]] = m[3]; continue; } // a default for the first argument is not expressible in KaTeX
    m = /^\\DeclareMathOperator(\*?)\{\\([A-Za-z]+)\}\{(.*)\}$/.exec(line);
    if (m) out['\\' + m[2]] = '\\operatorname' + m[1] + '{' + m[3] + '}';
  }
  return out;
}

module.exports = { toKatexMacros, toMathJaxMacros, toMathJaxBody, scanMacros, signature, signatureParts, mandatoryTokens, readCall, expand, callContext, parseXparseSpec, stripComments, readGroup };
