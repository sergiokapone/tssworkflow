'use strict';
/* Pure helpers of TSS Workflow 0.3.9 (no VS Code API): figure snippets, new chapter, \iffalse toggle,
 * Unicode -> LaTeX, BibTeX from DOI, latexdiff header, pgf layer fix, stale references. */

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------ templates ------------------------------ */
// ${name} placeholders; unknown ones stay as they are
function fillTemplate(lines, vars) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  return text.replace(/\$\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

/* ------------------------------ figures -------------------------------- */
const DEFAULT_FIGURE_TEMPLATE = [
  '\\begin{figure}[h!]\\centering',
  '\t\\includegraphics[width=${width}]{${name}}',
  '\t\\caption{${caption}\\label{${label}}}',
  '\\end{figure}'
];

// label made from a file name: only letters, digits, - and _
function stemLabel(stem) {
  return String(stem).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'figure';
}

// is `line` inside \begin{figure} ... \end{figure} (also SCfigure, wrapfigure)?
function insideFigure(lines, line) {
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const t = lines[i].replace(/(?<!\\)%.*$/, '');
    const beg = /\\begin\{(?:SC|wrap)?figure\*?\}/.test(t);
    const end = /\\end\{(?:SC|wrap)?figure\*?\}/.test(t);
    if (beg && !end) return true;
    if (end && !beg) return false;
  }
  return false;
}

// a free file name `base` + ext in the list of existing names (lower case compare, like Windows)
function uniqueStem(existing, base, ext) {
  const have = new Set(existing.map((x) => x.toLowerCase()));
  let n = base;
  let i = 1;
  while (have.has((n + ext).toLowerCase())) { i++; n = base + '-' + i; }
  return n;
}

function pasteName(d) {
  const p = (x) => String(x).padStart(2, '0');
  return 'paste-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* ----------------------------- new chapter ----------------------------- */
const DEFAULT_CHAPTER_TEMPLATE = [
  '% !TeX program = lualatex',
  '% !TeX encoding = utf8',
  '% !TeX spellcheck = uk_UA',
  '% !TeX root = ${root}',
  '',
  '%=========================================================',
  '\\chapter{${title}}\\label{\\currfilebase}\\hypertarget{\\currfilebase}{}',
  '\\graphicspath{{\\currfilebase/Pictures}}',
  '%=========================================================',
  ''
];

// inserts `\macro{name}` after the last (not commented) include line; ok = false when there is none
function addIncludeLine(mainText, macro, name) {
  const eol = mainText.includes('\r\n') ? '\r\n' : '\n';
  const lines = mainText.split(/\r?\n/);
  const re = new RegExp('^(\\s*)' + escapeRe(macro) + '\\s*\\{([^}]*)\\}');
  let last = -1;
  let indent = '';
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim() === name) return { ok: true, already: true, text: mainText, line: i };
    last = i;
    indent = m[1];
  }
  if (last < 0) return { ok: false, text: mainText, line: -1 };
  lines.splice(last + 1, 0, indent + macro + '{' + name + '}');
  return { ok: true, already: false, text: lines.join(eol), line: last + 1 };
}

/* ------------------------------ \iffalse -------------------------------- */
const IF_OPEN = '\\iffalse % TSS';
const IF_CLOSE = '\\fi % TSS';
const OPEN_RE = /^\s*\\iffalse\s*%\s*TSS\b/;
const CLOSE_RE = /^\s*\\fi\s*%\s*TSS\b/;
// \if... macros that are commands with arguments, not TeX conditionals (they have no \fi)
const NOT_COND = new Set([
  'iff', 'ifthenelse', 'ifstrequal', 'ifdef', 'ifundef', 'ifbool', 'ifnumcomp', 'ifnumequal', 'ifnumgreater', 'ifnumless',
  'ifdimcomp', 'ifdimequal', 'ifdimgreater', 'ifdimless', 'ifdefstring', 'ifdefempty', 'ifdefvoid', 'ifdefequal',
  'ifdefmacro', 'ifdefprefix', 'ifdefparam', 'iflanguage', 'ifstrempty', 'ifblank', 'ifnumodd', 'ifboolexpr', 'ifcsdef',
  'ifcsundef', 'ifcsstring', 'ifcsempty', 'ifcsmacro', 'iftoggle', 'ifinlist', 'ifinstring', 'ifpatchable', 'ifcurrentfield',
  'ifentrytype', 'iffieldundef', 'iffieldundef', 'iffieldequalstr', 'ifnameundef', 'ifsvg', 'ifthenelsex'
]);

// number of \if... minus number of \fi in the lines (0 = balanced); comments are ignored
function ifBalance(lines) {
  let n = 0;
  for (const l of lines) {
    const code = l.replace(/(?<!\\)%.*$/, '');
    for (const m of code.matchAll(/\\(if[A-Za-z@]*|fi)(?![A-Za-z@])/g)) {
      if (m[1] === 'fi') n--;
      else if (!NOT_COND.has(m[1])) n++;
    }
  }
  return n;
}

// lines s..e (0-based): unwrap our own \iffalse around them, or say how to wrap them
function toggleIffalse(lines, s, e) {
  let o = -1;
  for (let i = s; i >= 0; i--) {
    if (CLOSE_RE.test(lines[i]) && i !== s) break;
    if (OPEN_RE.test(lines[i])) { o = i; break; }
  }
  if (o >= 0) {
    for (let i = Math.max(e, o + 1); i < lines.length; i++) {
      if (OPEN_RE.test(lines[i]) && i !== o) break;
      if (CLOSE_RE.test(lines[i])) return { kind: 'unwrap', open: o, close: i };
    }
  }
  const indent = /^\s*/.exec(lines[s] || '')[0];
  return { kind: 'wrap', indent, balance: ifBalance(lines.slice(s, e + 1)) };
}

/* ---------------------------- Unicode -> LaTeX --------------------------- */
const UMAP = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\varepsilon', 'ϵ': '\\epsilon', 'ζ': '\\zeta',
  'η': '\\eta', 'θ': '\\theta', 'ϑ': '\\vartheta', 'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu', 'µ': '\\mu',
  'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho', 'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon',
  'φ': '\\varphi', 'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  'ℏ': '\\hbar', 'ℓ': '\\ell', '∂': '\\partial', '∇': '\\nabla', '∞': '\\infty',
  '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint', '∑': '\\sum', '∏': '\\prod',
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '∙': '\\cdot', '∘': '\\circ', '∗': '\\ast',
  '≈': '\\approx', '≠': '\\neq', '≡': '\\equiv', '≤': '\\leq', '≥': '\\geq', '≪': '\\ll', '≫': '\\gg', '∝': '\\propto',
  '∼': '\\sim', '≃': '\\simeq', '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
  '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap',
  '∀': '\\forall', '∃': '\\exists', '∅': '\\varnothing', '⊥': '\\perp', '∥': '\\parallel', '∠': '\\angle',
  '°': '^\\circ', '′': "'", '″': "''", '−': '-', '⋯': '\\cdots', '⊗': '\\otimes', '⊕': '\\oplus', '†': '\\dagger',
  '⟨': '\\langle', '⟩': '\\rangle', '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor',
  '∴': '\\therefore', '∵': '\\because', 'ℝ': '\\mathbb{R}', 'ℂ': '\\mathbb{C}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}'
};
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', 'ⁿ': 'n', 'ⁱ': 'i' };
const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', 'ₙ': 'n', 'ᵢ': 'i' };
// --- chemistry: Unicode formulas (H₂O, SO₄²⁻, Fe³⁺) -> \ce{...} (mhchem) ---
const CHEM_EL = 'He|Li|Be|Ne|Na|Mg|Al|Si|Cl|Ar|Ca|Sc|Ti|Cr|Mn|Fe|Co|Ni|Cu|Zn|Ga|Ge|As|Se|Br|Kr|Rb|Sr|Zr|Nb|Mo|Tc|Ru|Rh|Pd|Ag|Cd|In|Sn|Sb|Te|Xe|Cs|Ba|La|Ce|Pr|Nd|Pm|Sm|Eu|Gd|Tb|Dy|Ho|Er|Tm|Yb|Lu|Hf|Ta|Re|Os|Ir|Pt|Au|Hg|Tl|Pb|Bi|Po|At|Rn|Fr|Ra|Ac|Th|Pa|Np|Pu|Am|Cm|H|B|C|N|O|F|P|S|K|V|Y|I|W|U';
const CHEM_RE = new RegExp('(\\d*(?:(?:' + CHEM_EL + ')[₀-₉]*|[()][₀-₉]*)+)((?:[⁰¹²³⁴⁵⁶⁷⁸⁹]*[⁺⁻])?)', 'y');
const CHEM_ELEMS = new RegExp('(?:' + CHEM_EL + ')', 'g');
// a lone element with a subscript counts as chemistry only for common molecules (O₂, N₂, H₂ ...), so that V₀ or C₁ stay variables
const CHEM_LONE = new Set(['H', 'N', 'O', 'F', 'Cl', 'Br', 'I', 'P', 'S']);
const LETTER = /[A-Za-z\u0400-\u04FF\u0370-\u03FF0-9]/;

function chemToCe(body, charge) {
  let out = body.replace(/[₀-₉]/g, (c) => SUB[c]);
  if (charge) {
    const digits = charge.replace(/[⁺⁻]/g, '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUP[c]);
    const sign = charge.includes('⁺') ? '+' : '-';
    out += (digits ? '^' + digits : '') + sign;
  }
  return '\\ce{' + out + '}';
}

// tries to read a chemical formula at text[i]; returns { s, len } or null
function matchChem(text, i, to, math) {
  if (i > 0 && LETTER.test(text[i - 1])) return null;
  CHEM_RE.lastIndex = i;
  const m = CHEM_RE.exec(text);
  if (!m || i + m[0].length > to) return null;
  const body = m[1];
  const charge = m[2];
  if (!charge && !/[₀-₉]/.test(body)) return null;
  const after = text[i + m[0].length];
  if (after !== undefined && LETTER.test(after)) return null;
  if ((body.match(/\(/g) || []).length !== (body.match(/\)/g) || []).length) return null;
  if (!/[A-Za-z(]/.test(body)) return null;
  const els = body.match(CHEM_ELEMS) || [];
  if (els.length === 1 && !charge && (math || !CHEM_LONE.has(els[0]))) return null;
  return { s: chemToCe(body, charge), len: m[0].length };
}

const MATH_SPAN = /\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\begin\{((?:equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math)\*?)\}[\s\S]*?\\end\{\1\}/g;

function mathSpans(text) {
  const out = [];
  MATH_SPAN.lastIndex = 0;
  let m;
  while ((m = MATH_SPAN.exec(text)) !== null) {
    if (!m[0].length) { MATH_SPAN.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// converts Unicode math characters in text[from, to) to LaTeX; `text` is the whole document, so that it is known
// whether a character is already inside math. Outside math the commands get their own $...$
function unicodeToLatex(text, from, to) {
  const spans = mathSpans(text);
  const inMath = (i) => spans.some(([a, b]) => i > a && i < b);
  const segs = []; // { sym: bool, math: bool, s }
  let count = 0;
  let chemCount = 0;
  let i = from;
  let plain = '';
  const flush = () => { if (plain) { segs.push({ sym: false, s: plain }); plain = ''; } };
  while (i < to) {
    const ch = text[i];
    const chem = matchChem(text, i, to, inMath(i));
    if (chem) {
      flush();
      segs.push({ sym: false, chem: true, s: chem.s });
      count++;
      chemCount++;
      i += chem.len;
      continue;
    }
    if (SUP[ch] !== undefined || SUB[ch] !== undefined) {
      const table = SUP[ch] !== undefined ? SUP : SUB;
      let run = '';
      const start = i;
      while (i < to && table[text[i]] !== undefined) { run += table[text[i]]; i++; }
      flush();
      segs.push({ sym: true, math: inMath(start), s: (table === SUP ? '^' : '_') + (run.length === 1 ? run : '{' + run + '}') });
      count++;
      continue;
    }
    if (UMAP[ch] !== undefined) {
      flush();
      segs.push({ sym: true, math: inMath(i), s: UMAP[ch] });
      count++;
      i++;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  let out = '';
  for (let k = 0; k < segs.length; k++) {
    const g = segs[k];
    if (!g.sym) { out += g.s; continue; }
    if (g.math) {
      out += g.s;
      const next = segs[k + 1];
      const nextCh = next ? (next.sym ? '' : next.s[0]) : text[to] || '';
      if (/[A-Za-z]$/.test(g.s) && /[A-Za-z]/.test(nextCh || '')) out += ' ';
      continue;
    }
    // outside math: neighbouring symbols share one $...$
    let body = g.s;
    while (segs[k + 1] && segs[k + 1].sym && !segs[k + 1].math) {
      const prev = body;
      k++;
      body += (/[A-Za-z]$/.test(prev) && /^[A-Za-z]/.test(segs[k].s) ? ' ' : '') + segs[k].s;
    }
    out += '$' + body + '$';
  }
  return { text: out, count, chem: chemCount };
}

/* ------------------------------ BibTeX / DOI ----------------------------- */
function normalizeDoi(s) {
  const m = /10\.\d{4,9}\/[^\s"<>]+/.exec(String(s));
  return m ? m[0].replace(/[.,;)\]]+$/, '') : null;
}

// splits the body of a BibTeX entry at the commas that are outside braces and quotes
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { cur += c + (body[i + 1] || ''); i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '"' && depth === 0) quote = !quote;
    if (c === ',' && depth === 0 && !quote) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// crossref returns an entry on one line: one field per line
function formatBibtex(raw) {
  const t = String(raw).trim();
  const m = /^@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*)\}\s*$/.exec(t);
  if (!m) return t + '\n';
  const fields = splitTopLevel(m[3]).map((x) => x.trim()).filter(Boolean);
  return '@' + m[1] + '{' + m[2] + ',\n' + fields.map((f) => '  ' + f).join(',\n') + '\n}\n';
}

function bibKeys(bibText) {
  return [...String(bibText).matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((x) => x[1]);
}

function bibKeyOf(entry) {
  const m = /^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(entry);
  return m ? m[1] : null;
}

function uniqueKey(key, existing) {
  const have = new Set(existing);
  if (!have.has(key)) return key;
  for (const c of 'abcdefghijklmnopqrstuvwxyz') if (!have.has(key + c)) return key + c;
  return key + '-2';
}

function setBibKey(entry, newKey) {
  return entry.replace(/^(\s*@\w+\s*\{\s*)([^,\s]+)/, (m, a) => a + newKey);
}

/* -------------------------------- latexdiff ------------------------------ */
// definitions for latexdiff output of a file without a preamble (a chapter); \sout only if ulem is loaded
function latexdiffHeader(name, rev, root) {
  return [
    '% !TeX root = ' + root,
    '% Тимчасовий файл: зміни ' + name + ' відносно ' + rev + ' (latexdiff, TSS Workflow). Папку можна видалити.',
    '\\providecommand{\\DIFadd}[1]{\\textcolor{blue}{\\underline{#1}}}',
    '\\ifdefined\\sout\\providecommand{\\DIFdel}[1]{\\textcolor{red}{\\sout{#1}}}\\else\\providecommand{\\DIFdel}[1]{\\textcolor{red}{#1}}\\fi',
    '\\providecommand{\\DIFaddbegin}{}', '\\providecommand{\\DIFaddend}{}',
    '\\providecommand{\\DIFdelbegin}{}', '\\providecommand{\\DIFdelend}{}',
    '\\providecommand{\\DIFaddFL}[1]{\\DIFadd{#1}}', '\\providecommand{\\DIFdelFL}[1]{\\DIFdel{#1}}',
    '\\providecommand{\\DIFaddbeginFL}{}', '\\providecommand{\\DIFaddendFL}{}',
    '\\providecommand{\\DIFdelbeginFL}{}', '\\providecommand{\\DIFdelendFL}{}',
    '\\def\\currfilebase{' + name + '}',
    ''
  ].join('\n');
}

// "abc123\tsubject\t2 days ago" lines of `git log --format=%h%x09%s%x09%cr`
function parseGitLog(out) {
  return String(out).split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash, subject, when] = l.split('\t');
    return { hash, subject: subject || '', when: when || '' };
  }).filter((x) => x.hash);
}

/* ------------------------------ pgf layers ------------------------------- */
// adds the layer to \pgfsetlayers{...} and declares it in the same file; null when there is nothing to change
function layerFix(text, layer) {
  const m = /^([ \t]*)\\pgfsetlayers\{([^}]*)\}/m.exec(text);
  if (!m) return null;
  const items = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  let changed = false;
  if (!items.includes(layer)) {
    const k = items.indexOf('main');
    if (k >= 0) items.splice(k, 0, layer); else items.push(layer);
    changed = true;
  }
  const declared = new RegExp('\\\\pgfdeclarelayer\\{' + escapeRe(layer) + '\\}').test(text);
  let line = m[1] + '\\pgfsetlayers{' + items.join(', ') + '}';
  if (!declared) { line = m[1] + '\\pgfdeclarelayer{' + layer + '}\n' + line; changed = true; }
  if (!changed) return null;
  return { text: text.slice(0, m.index) + line + text.slice(m.index + m[0].length), start: m.index, end: m.index + m[0].length, replacement: line };
}

/* ---------------------------- stale references --------------------------- */
// the last saved source is newer than <job>.aux (2 s tolerance for file system clocks)
function isStale(auxMtimeMs, lastSaveMs) {
  return !!lastSaveMs && !!auxMtimeMs && lastSaveMs > auxMtimeMs + 2000;
}

module.exports = {
  fillTemplate, DEFAULT_FIGURE_TEMPLATE, DEFAULT_CHAPTER_TEMPLATE, stemLabel, insideFigure, uniqueStem, pasteName,
  addIncludeLine, IF_OPEN, IF_CLOSE, ifBalance, toggleIffalse,
  UMAP, mathSpans, unicodeToLatex,
  normalizeDoi, splitTopLevel, formatBibtex, bibKeys, bibKeyOf, uniqueKey, setBibKey,
  latexdiffHeader, parseGitLog, layerFix, isStale
};
