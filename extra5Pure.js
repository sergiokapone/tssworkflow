'use strict';
/* TSS Workflow 0.7.0, logic without VS Code:
 *   fileMacros      table "macro -> folder" for Ctrl+click, completion and the "file not found" check (\input, \include, \subfile,
 *                   \localinput, \includegraphics ...); root-relative check of \input in chapters built from the project root
 *   renameRefs      new paths of references after a file or folder was renamed / moved
 *   missing files   "File 'x.sty' not found" in the log -> tlmgr command
 *   labels          \label / \ref index for the "Мітки" panel
 *   countWords      words of a .tex text without commands, comments and formulas
 *   bib             parse / format / duplicates / key normalisation of .bib
 *   table           CSV / TSV / XLSX -> tblr
 *   packages        \usepackage whose commands never occur
 *   equations       numbered formulas with labels
 * Nothing here touches the disk except readXlsx (zlib on a Buffer given by the caller). */

const path = require('path');
const zlib = require('zlib');

const PIC_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif', '.tif', '.tiff'];
const TEX_EXTS = ['.tex', '.tikz'];
const posix = (p) => String(p).split(path.sep).join('/');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the part of a line before an unescaped %
function codePart(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

/* ================================ 1. file macros =============================== */
const DEFAULT_FILE_MACROS = {
  '\\localinput': 'tikz',
  '\\includegraphics': 'Pictures',
  '\\input': '.',
  '\\include': '.',
  '\\subfile': '.'
};
// macros the older code (extension.js, features.js, pure.js) already handles; extra5 does the others
const LEGACY_MACROS = new Set(['\\localinput', '\\includegraphics']);
const DEFAULT_ROOT_MACROS = ['\\input', '\\include'];

// [{ macro: '\\input', name: 'input', sub: '.', exts: [...], graphics: false }] from the user's object
// (keys with or without a backslash; "" / null / non-string value switches a macro off)
function fileMacroTable(user) {
  const merged = Object.assign({}, DEFAULT_FILE_MACROS);
  if (user && typeof user === 'object') {
    for (const k of Object.keys(user)) {
      const key = (k.startsWith('\\') ? k : '\\' + k).trim();
      merged[key] = user[k];
    }
  }
  const out = [];
  for (const macro of Object.keys(merged)) {
    const v = merged[macro];
    if (!/^\\[A-Za-z@]+$/.test(macro)) continue;
    if (typeof v !== 'string' || !v.trim()) continue;
    const sub = posix(path.normalize(v.trim())).replace(/\/+$/, '') || '.';
    const graphics = macro === '\\includegraphics';
    out.push({ macro, name: macro.slice(1), sub, exts: graphics ? PIC_EXTS : TEX_EXTS, graphics });
  }
  return out;
}

function macroRe(entry) {
  return new RegExp('\\\\' + escRe(entry.name) + '(?![A-Za-z@])\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}', 'g');
}

// every use of the table's macros in one line: [{ entry, name, start, len }], start = column of the first character of the name
function findFileRefs(line, table, only) {
  const code = codePart(line);
  const out = [];
  for (const entry of table) {
    if (only && !only(entry)) continue;
    const re = macroRe(entry);
    let m;
    while ((m = re.exec(code)) !== null) {
      const raw = m[1];
      const name = raw.trim();
      if (!name) continue;
      const lead = raw.length - raw.trimStart().length;
      const start = m.index + m[0].lastIndexOf('{') + 1 + lead;
      out.push({ entry, name, start, len: name.length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// absolute candidates for `name` under `base`: as written, then with each extension when the name has none of them
function candidates(base, name, exts) {
  const b = path.resolve(base, name);
  const list = [b];
  if (!exts.includes(path.extname(name).toLowerCase())) for (const e of exts) list.push(b + e);
  return list;
}

// bases a reference may be relative to, in the order they are tried.
// inputRoot: 'workspace' (TeX resolves from the folder of the build: the project root), 'file' (relative to the file), 'off'
function basesFor(entry, ctx) {
  const dirBase = path.resolve(ctx.dir, entry.sub);
  const rootBase = ctx.root ? path.resolve(ctx.root, entry.sub) : null;
  const rootFirst = ctx.inputRoot !== 'file' && (ctx.rootMacros || DEFAULT_ROOT_MACROS).includes(entry.macro);
  const list = [];
  if (rootFirst && rootBase) list.push({ base: rootBase, via: 'root' });
  list.push({ base: dirBase, via: 'file' });
  // \subfile and the like: the root as a second chance only for the "." macros
  if (!rootFirst && rootBase && entry.sub === '.' && rootBase !== dirBase) list.push({ base: rootBase, via: 'root' });
  return list;
}

// { found, abs, via } for a reference; `abs` is the first candidate when nothing exists
function resolveRef(entry, name, ctx) {
  const bases = basesFor(entry, ctx);
  for (const b of bases) {
    for (const c of candidates(b.base, name, entry.exts)) if (ctx.exists(c)) return { found: true, abs: c, via: b.via };
  }
  return { found: false, abs: candidates(bases[0].base, name, entry.exts)[0], via: bases[0].via };
}

// diagnostics for the macros of the table (not the two legacy ones): file not found, and the root-relative \input trap.
// ctx: { dir, root, inputRoot, rootMacros, exists(abs) }
function checkFileRefs(lines, table, ctx) {
  const out = [];
  const rootMacros = ctx.rootMacros || DEFAULT_ROOT_MACROS;
  lines.forEach((line, i) => {
    for (const r of findFileRefs(line, table, (e) => !LEGACY_MACROS.has(e.macro))) {
      const rooted = ctx.root && ctx.inputRoot !== 'file' && ctx.inputRoot !== 'off' && rootMacros.includes(r.entry.macro);
      if (rooted) {
        const viaRoot = candidates(path.resolve(ctx.root, r.entry.sub), r.name, r.entry.exts).find((c) => ctx.exists(c));
        if (viaRoot) continue;
        const viaFile = candidates(path.resolve(ctx.dir, r.entry.sub), r.name, r.entry.exts).find((c) => ctx.exists(c));
        if (viaFile) {
          const hadExt = r.entry.exts.includes(path.extname(r.name).toLowerCase());
          let fix = posix(path.relative(path.resolve(ctx.root, r.entry.sub), viaFile));
          if (!hadExt) { const e = path.extname(fix).toLowerCase(); if (r.entry.exts.includes(e)) fix = fix.slice(0, fix.length - e.length); }
          out.push({
            line: i, col: r.start, len: r.len, severity: 'warning', code: 'input-root-path', fix,
            message: r.entry.macro + '{' + r.name + '}: шлях рахується від кореня проєкту (так збирають alone.tex і main.tex), а файл лежить відносно цього файла. Правильно: ' + fix
          });
          continue;
        }
        out.push({ line: i, col: r.start, len: r.len, severity: 'warning', code: 'file-missing-input', message: 'Файл не знайдено (шлях від кореня проєкту): ' + r.name });
        continue;
      }
      if (!resolveRef(r.entry, r.name, Object.assign({}, ctx, { inputRoot: ctx.inputRoot === 'off' ? 'file' : ctx.inputRoot })).found) {
        out.push({ line: i, col: r.start, len: r.len, severity: 'warning', code: 'file-missing-input', message: 'Файл не знайдено: ' + posix(path.join(r.entry.sub, r.name)) });
      }
    }
  });
  return out;
}

/* ============================== 2. rename / move ============================== */
// edits for one file's text after oldAbs -> newAbs (a file or, with isDir, a folder).
// ctx: { dir, root, inputRoot, rootMacros }. Returns [{ line, col, len, newText }]
function renameRefs(lines, table, ctx, oldAbs, newAbs, isDir) {
  const edits = [];
  const inside = (p) => p === oldAbs || (isDir && p.startsWith(oldAbs + path.sep));
  lines.forEach((line, i) => {
    for (const r of findFileRefs(line, table)) {
      let hit = null;
      for (const b of basesFor(r.entry, ctx)) {
        const c = candidates(b.base, r.name, r.entry.exts).find(inside);
        if (c) { hit = { b, c }; break; }
      }
      if (!hit) continue;
      const moved = hit.c === oldAbs ? newAbs : path.join(newAbs, path.relative(oldAbs, hit.c));
      const hadExt = r.entry.exts.includes(path.extname(r.name).toLowerCase()) || (!path.extname(hit.c) && !!path.extname(r.name));
      let rel = posix(path.relative(hit.b.base, moved));
      if (!hadExt && hit.c !== path.resolve(hit.b.base, r.name)) {
        // the name was written without the extension
        const e = path.extname(rel).toLowerCase();
        if (r.entry.exts.includes(e)) rel = rel.slice(0, rel.length - e.length);
      }
      if (rel !== r.name) edits.push({ line: i, col: r.start, len: r.len, newText: rel });
    }
  });
  return edits;
}

// a .tex file moved to another folder: references that were relative to its old folder (\\localinput, \\includegraphics ...)
// get the path relative to the new folder. oldCtx has dir = the old folder; newDir = the new one.
function renameSelfRefs(lines, table, oldCtx, newDir) {
  const edits = [];
  lines.forEach((line, i) => {
    for (const r of findFileRefs(line, table)) {
      const hit = resolveRef(r.entry, r.name, oldCtx);
      if (!hit.found || hit.via !== 'file') continue;
      const base = path.resolve(newDir, r.entry.sub);
      let rel = posix(path.relative(base, hit.abs));
      const hadExt = r.entry.exts.includes(path.extname(r.name).toLowerCase());
      if (!hadExt && hit.abs !== path.resolve(path.resolve(oldCtx.dir, r.entry.sub), r.name)) {
        const e = path.extname(rel).toLowerCase();
        if (r.entry.exts.includes(e)) rel = rel.slice(0, rel.length - e.length);
      }
      if (rel !== r.name) edits.push({ line: i, col: r.start, len: r.len, newText: rel });
    }
  });
  return edits;
}

/* ============================ 3. missing files in a log ======================= */
// TeX Live package that ships a file when the package name differs from the file name
const TL_MAP = {
  tikz: 'pgf', pgf: 'pgf', pgfplots: 'pgfplots', pgfplotstable: 'pgfplots', pgfmath: 'pgf', pgfcore: 'pgf',
  graphicx: 'graphics', color: 'graphics', graphics: 'graphics', epsfig: 'graphics', trig: 'graphics',
  amssymb: 'amsfonts', amsfonts: 'amsfonts', amsmath: 'amsmath', amsthm: 'amscls', amsbsy: 'amsmath',
  ifthen: 'latex', inputenc: 'latex', fontenc: 'latex', textcomp: 'latex', babel: 'babel',
  type1ec: 'cm-super', lmodern: 'lm', mathrsfs: 'jknapltx', 'ulem': 'ulem', xcolor: 'xcolor',
  ucs: 'unicode-math', 'unicode-math': 'unicode-math', 'lualatex-math': 'lualatex-math', luatex85: 'luatex85',
  'tikz-cd': 'tikz-cd', 'babel-ukrainian': 'babel-ukrainian', ukrainian: 'babel-ukrainian', russianb: 'babel-russian',
  tcolorbox: 'tcolorbox', 'ltxcmds': 'ltxcmds', 'kvoptions': 'oberdiek', 'etoolbox': 'etoolbox'
};
const SEARCH_ONLY_EXT = new Set(['.bbx', '.cbx', '.lbx', '.bst', '.def', '.cfg', '.clo', '.fd', '.tfm', '.pfb', '.otf', '.ttf', '.map']);

// [{ file: 'x.sty', pkg: 'x'|null, ext, count }] in the order of the first appearance
function missingFilesFromLog(log) {
  const seen = new Map();
  const re = /File\s+[`'‘]([^'’`\s]+?\.[A-Za-z0-9]+)['’]\s+not\s+found/g;
  let m;
  while ((m = re.exec(String(log))) !== null) {
    const file = m[1];
    if (seen.has(file)) { seen.get(file).count++; continue; }
    const ext = path.extname(file).toLowerCase();
    const stem = file.slice(0, file.length - ext.length);
    const pkg = (ext === '.sty' || ext === '.cls') ? (TL_MAP[stem] || stem) : null;
    seen.set(file, { file, pkg, ext, count: 1 });
  }
  return [...seen.values()];
}

// { install: 'tlmgr install a b' | '', search: ['tlmgr search --global --file "/x.bbx"'] }
function tlmgrCommands(missing, installCmd) {
  const base = String(installCmd || 'tlmgr install').trim() || 'tlmgr install';
  const pkgs = [];
  const search = [];
  const tool = /^(.*?tlmgr)\b/.exec(base);
  const searchBase = (tool ? tool[1] : 'tlmgr') + ' search --global --file';
  for (const x of missing) {
    if (x.pkg && !pkgs.includes(x.pkg)) pkgs.push(x.pkg);
    if (!x.pkg || SEARCH_ONLY_EXT.has(x.ext) || true) search.push(searchBase + ' "/' + x.file + '"');
  }
  return { install: pkgs.length ? base + ' ' + pkgs.join(' ') : '', search };
}

/* ================================== 4. labels ================================= */
const REF_MACROS = 'ref|eqref|pageref|autoref|Autoref|cref|Cref|crefrange|Crefrange|cpageref|Cpageref|vref|Vref|vrefrange|nameref|Nameref|labelcref|labelcpageref|subref|fref|Fref|thref|prettyref|refeq';

// [{ name, line, col, len }] (0-based line, column of the first character of the name)
function scanLabels(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const code = codePart(line);
    const re = /\\label\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const name = m[1].trim();
      if (name) out.push({ name, line: i, col: m.index + m[0].lastIndexOf('{') + 1 + (m[1].length - m[1].trimStart().length), len: name.length });
    }
  });
  return out;
}

// Map name -> number of uses (\ref{a,b} counts both, \hyperref[a] too)
function scanRefs(lines, into) {
  const map = into || new Map();
  const add = (n) => { n = n.trim(); if (n) map.set(n, (map.get(n) || 0) + 1); };
  const reRef = new RegExp('\\\\(?:' + REF_MACROS + ')\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}', 'g');
  const reHyper = /\\hyperref\s*\[([^\]]*)\]/g;
  for (const line of lines) {
    const code = codePart(line);
    let m;
    reRef.lastIndex = 0;
    while ((m = reRef.exec(code)) !== null) m[1].split(',').forEach(add);
    reHyper.lastIndex = 0;
    while ((m = reHyper.exec(code)) !== null) add(m[1]);
  }
  return map;
}

// a few words that tell what a label stands for: the caption, the section title or the start of the formula
function labelContext(lines, line) {
  const strip = (t) => t.replace(/\\label\s*\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
  const grab = (s, re) => { const m = re.exec(s); return m ? strip(m[1]) : ''; };
  for (let k = line; k >= Math.max(0, line - 14); k--) {
    const c = codePart(lines[k]);
    let t;
    if ((t = grab(c, /\\(?:chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/))) return t.slice(0, 70);
    if (k !== line && /\\end\{(figure|table|equation|align|gather|multline|tikzpicture)/.test(c)) break;
    if ((t = grab(c, /\\caption\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)/))) return t.slice(0, 70);
    const b = /\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray|theorem|lemma|definition|proposition|corollary|example|remark)\*?\}/.exec(c);
    if (b) {
      const first = strip(c.slice(b.index + b[0].length)) || strip(codePart(lines[k + 1] || ''));
      return (/^(equation|align|gather|multline|flalign|alignat|eqnarray)$/.test(b[1]) ? first : b[1] + ' ' + first).slice(0, 70);
    }
  }
  // after the label (a caption often follows it)
  for (let k = line; k <= Math.min(lines.length - 1, line + 3); k++) {
    const t = grab(codePart(lines[k]), /\\caption\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)/);
    if (t) return t.slice(0, 70);
  }
  return '';
}

// edits that rename a label: \label{old}, every \ref-like use (also in a list \cref{a,old}) and \hyperref[old]
function renameLabelEdits(lines, oldName, newName) {
  const edits = [];
  const reRef = new RegExp('\\\\(?:' + REF_MACROS + '|label)\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}', 'g');
  const reHyper = /\\hyperref\s*\[([^\]]*)\]/g;
  lines.forEach((line, i) => {
    const code = codePart(line);
    let m;
    reRef.lastIndex = 0;
    while ((m = reRef.exec(code)) !== null) {
      const open = m.index + m[0].lastIndexOf('{') + 1;
      let off = 0;
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (t === oldName) edits.push({ line: i, col: open + off + (part.length - part.trimStart().length), len: t.length, newText: newName });
        off += part.length + 1;
      }
    }
    reHyper.lastIndex = 0;
    while ((m = reHyper.exec(code)) !== null) {
      if (m[1].trim() === oldName) edits.push({ line: i, col: m.index + m[0].indexOf('[') + 1 + (m[1].length - m[1].trimStart().length), len: oldName.length, newText: newName });
    }
  });
  return edits;
}

const labelKind = (n) => { const m = /^([A-Za-z]+)[:.\-_]/.exec(n); return m ? m[1].toLowerCase() : ''; };

// files: [{ path, lines }]. -> { groups: [{ path, labels: [{ name, line, col, uses, kind }] }], total, unused }
function buildLabelIndex(files) {
  const refs = new Map();
  for (const f of files) scanRefs(f.lines, refs);
  const groups = [];
  let total = 0;
  let unused = 0;
  for (const f of files) {
    const labels = scanLabels(f.lines).map((l) => Object.assign(l, { uses: refs.get(l.name) || 0, kind: labelKind(l.name) }));
    if (!labels.length) continue;
    total += labels.length;
    unused += labels.filter((l) => !l.uses).length;
    groups.push({ path: f.path, labels });
  }
  return { groups, total, unused };
}

// \eqref for formula labels, \ref for the rest
function refText(name, eqPrefixes) {
  const eq = (eqPrefixes || ['eq', 'eqn', 'equation', 'formula']).includes(labelKind(name));
  return (eq ? '\\eqref{' : '\\ref{') + name + '}';
}

/* ================================= 5. word count ============================== */
function countWords(text) {
  let s = String(text).replace(/\r\n?/g, '\n');
  s = s.split('\n').map(codePart).join('\n');
  s = s.replace(/\\begin\{(verbatim|lstlisting|minted|comment|tikzpicture|circuitikz|axis|filecontents\*?)\}[\s\S]*?\\end\{\1\}/g, ' ');
  s = s.replace(/\\begin\{(equation|align|gather|multline|flalign|eqnarray|displaymath|math|split|alignat)(\*?)\}[\s\S]*?\\end\{\1\2\}/g, ' ');
  s = s.replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\$[^$\n]*\$/g, ' ');
  // commands whose argument is not prose
  s = s.replace(/\\(?:label|ref|eqref|cref|Cref|autoref|pageref|cite[a-z]*|parencite|textcite|autocite|usepackage|RequirePackage|documentclass|input|include|localinput|includegraphics|includechapter|bibliography|bibliographystyle|addbibresource|url|href|graphicspath|newcommand|renewcommand|providecommand|def|setlength|vspace|hspace|color|definecolor|pagestyle|thispagestyle|subfile|multiinclude|begin|end)(?![A-Za-z@])\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})*/g, ' ');
  s = s.replace(/\\[A-Za-z@]+\*?/g, ' ').replace(/\\./g, ' ');
  const words = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu);
  return words ? words.length : 0;
}

/* ================================== 6. .bib =================================== */
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '' };
function toAscii(s) {
  let out = '';
  for (const ch of String(s).toLowerCase()) out += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch;
  return out.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ł/g, 'l');
}

// entries: [{ type, key, fields: [{ name, value, delim }], start, end, raw }], and `raw` pieces between entries are kept by formatBib
function parseBib(text) {
  const entries = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    // an entry starts at "@" that is at the beginning of a line (comments between entries may contain "@")
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    if (text.slice(lineStart, at).trim()) { i = at + 1; continue; }
    const head = /^@([A-Za-z]+)\s*([{(])/.exec(text.slice(at, at + 60));
    if (!head) { i = at + 1; continue; }
    const open = at + head[0].length - 1;
    const closeCh = head[2] === '{' ? '}' : ')';
    let depth = 0;
    let k = open;
    for (; k < n; k++) {
      const c = text[k];
      if (c === '\\') { k++; continue; }
      if (c === '{' || c === '(' && head[2] === '(') depth++;
      else if (c === '}' || c === ')' && head[2] === '(') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) { i = at + 1; continue; }
    const type = head[1].toLowerCase();
    const body = text.slice(open + 1, k);
    const e = { type, key: '', fields: [], start: at, end: k + 1, raw: text.slice(at, k + 1), special: ['string', 'comment', 'preamble'].includes(type) };
    if (!e.special) {
      const km = /^\s*([^,\s]+)\s*,/.exec(body);
      if (km) {
        e.key = km[1];
        e.fields = parseFields(body.slice(km[0].length));
      } else e.special = true;
    }
    entries.push(e);
    i = k + 1;
    void closeCh;
  }
  return entries;
}

function parseFields(s) {
  const fields = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const m = /^[\s,]*([A-Za-z][A-Za-z0-9_\-:.]*)\s*=\s*/.exec(s.slice(i));
    if (!m) break;
    const name = m[1];
    i += m[0].length;
    let j = i;
    let depth = 0;
    let inQ = false;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (inQ) { if (c === '"' && depth === 0) inQ = false; else if (c === '{') depth++; else if (c === '}') depth--; continue; }
      if (c === '"' && depth === 0) { inQ = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',' && depth === 0) break;
    }
    const value = s.slice(i, j).trim();
    fields.push({ name, value });
    i = j + 1;
  }
  return fields;
}

const bareValue = (v) => /^(\d+|[A-Za-z][A-Za-z0-9_\-]*(\s*#\s*[^#]+)*)$/.test(v) && !/^\{/.test(v) && !/^"/.test(v);
// "text" with no "#" and no inner quotes becomes {text}
function normValue(v) {
  const m = /^"([^"#{}]*)"$/.exec(v);
  return m ? '{' + m[1] + '}' : v;
}

const FIELD_ORDER = ['author', 'editor', 'title', 'booktitle', 'journal', 'journaltitle', 'series', 'volume', 'number', 'pages', 'year', 'date', 'month', 'publisher', 'address', 'location', 'edition', 'institution', 'school', 'howpublished', 'doi', 'isbn', 'issn', 'url', 'urldate', 'note', 'abstract', 'keywords'];

function fieldValue(e, name) {
  const f = e.fields.find((x) => x.name.toLowerCase() === name);
  if (!f) return '';
  return f.value.replace(/^\{([\s\S]*)\}$/, '$1').replace(/^"([\s\S]*)"$/, '$1').replace(/\s+/g, ' ').trim();
}

function formatEntry(e, o) {
  const fields = e.fields.map((f) => ({ name: f.name.toLowerCase(), value: normValue(f.value) }));
  if (o.sortFields) {
    const rank = (n) => { const k = FIELD_ORDER.indexOf(n); return k < 0 ? FIELD_ORDER.length : k; };
    fields.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const w = Math.max(0, ...fields.map((f) => f.name.length));
  const unit = o.unit || '  ';
  const lines = fields.map((f) => unit + f.name.padEnd(w) + ' = ' + f.value + ',');
  return '@' + e.type + '{' + (o.key || e.key) + ',\n' + lines.join('\n') + (lines.length ? '\n' : '') + '}';
}

// opts: { sortBy: 'none'|'key'|'year'|'author', sortFields, unit, keyMap: Map(old -> new) }.  Text between entries stays where it is
// only when nothing is sorted; with sorting, the entries are written one after another separated by a blank line.
function formatBib(text, opts) {
  const o = opts || {};
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const src = text.replace(/\r\n/g, '\n');
  const entries = parseBib(src);
  if (!entries.length) return { text, count: 0 };
  const rendered = entries.map((e) => ({ e, out: e.special ? e.raw : formatEntry(e, { key: o.keyMap && o.keyMap.get(e.key), sortFields: o.sortFields, unit: o.unit }) }));
  let body;
  if (o.sortBy && o.sortBy !== 'none') {
    const specials = rendered.filter((r) => r.e.special);
    const real = rendered.filter((r) => !r.e.special);
    const keyOf = (r) => {
      if (o.sortBy === 'year') return (fieldValue(r.e, 'year') || fieldValue(r.e, 'date')).slice(0, 4) + '|' + r.e.key.toLowerCase();
      if (o.sortBy === 'author') return toAscii(fieldValue(r.e, 'author') || fieldValue(r.e, 'editor') || r.e.key) + '|' + (fieldValue(r.e, 'year') || '');
      return r.e.key.toLowerCase();
    };
    real.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    body = specials.concat(real).map((r) => r.out).join('\n\n') + '\n';
  } else {
    let out = '';
    let pos = 0;
    for (const r of rendered) { out += src.slice(pos, r.e.start) + r.out; pos = r.e.end; }
    body = out + src.slice(pos);
  }
  return { text: body.replace(/\n/g, eol), count: entries.filter((e) => !e.special).length };
}

const normDoi = (d) => String(d || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '').replace(/[{}\s]/g, '');
const normTitle = (t) => toAscii(String(t || '').replace(/[{}\\]/g, '')).replace(/[^a-z0-9]+/g, '');

// groups of entries that look like the same work: [{ by: 'doi'|'title', value, entries: [e, ...] }]
function bibDuplicates(entries) {
  const groups = [];
  for (const by of ['doi', 'title']) {
    const map = new Map();
    for (const e of entries) {
      if (e.special) continue;
      const v = by === 'doi' ? normDoi(fieldValue(e, 'doi')) : normTitle(fieldValue(e, 'title'));
      if (!v || (by === 'title' && v.length < 8)) continue;
      if (!map.has(v)) map.set(v, []);
      map.get(v).push(e);
    }
    for (const [value, list] of map) if (list.length > 1) groups.push({ by, value, entries: list });
  }
  // an entry pair found by DOI is not reported again by title
  const seen = new Set();
  return groups.filter((g) => {
    const id = g.entries.map((e) => e.key).sort().join('|');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// surname + year (+ a, b, c ...) in ASCII lower case; keys that are already fine are kept
function bibKeyMap(entries, o) {
  const used = new Set();
  const map = new Map();
  const wanted = [];
  for (const e of entries) {
    if (e.special) continue;
    const author = fieldValue(e, 'author') || fieldValue(e, 'editor');
    const first = author.split(/\s+and\s+/i)[0] || '';
    let sur = first.includes(',') ? first.split(',')[0] : first.trim().split(/\s+/).pop() || '';
    sur = toAscii(sur.replace(/[{}\\'"`^~]/g, '')).replace(/[^a-z0-9]/g, '');
    const year = (fieldValue(e, 'year') || fieldValue(e, 'date')).replace(/\D/g, '').slice(0, 4);
    const fallback = toAscii(e.key).replace(/[^a-z0-9:_\-]+/g, '');
    const base = sur && year ? sur + year : fallback || e.key;
    wanted.push({ e, base });
  }
  const count = new Map();
  for (const w of wanted) count.set(w.base, (count.get(w.base) || 0) + 1);
  const next = new Map();
  for (const w of wanted) {
    let key = w.base;
    if (count.get(w.base) > 1) {
      const i = next.get(w.base) || 0;
      next.set(w.base, i + 1);
      key = w.base + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
    }
    while (used.has(key)) key += '_';
    used.add(key);
    if (key !== w.e.key) map.set(w.e.key, key);
  }
  void o;
  return map;
}

// one group of duplicates (entries of parseBib with the same work) -> the .bib text without the others and the key map { other -> kept }.
// The kept entry gets the fields it lacks from the others.
function mergeBibGroup(text, group, keepKey) {
  const keep = group.find((e) => e.key === keepKey) || group[0];
  const others = group.filter((e) => e !== keep);
  const have = new Set(keep.fields.map((f) => f.name.toLowerCase()));
  const merged = { type: keep.type, key: keep.key, fields: keep.fields.slice() };
  let added = 0;
  for (const o of others) for (const f of o.fields) if (!have.has(f.name.toLowerCase())) { have.add(f.name.toLowerCase()); merged.fields.push(f); added++; }
  const edits = others.map((o) => ({ start: o.start, end: o.end, text: '' }));
  edits.push({ start: keep.start, end: keep.end, text: added ? formatEntry(merged, { sortFields: false }) : keep.raw });
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) {
    let end = e.end;
    let start = e.start;
    if (e.text === '') { while (out[end] === '\n' && (out[end + 1] === '\n' || end + 1 >= out.length)) end++; if (out[end] === '\n' && start === 0) end++; else if (out[end] === '\n' && out[start - 1] === '\n') end++; }
    out = out.slice(0, start) + e.text + out.slice(end);
  }
  const keyMap = new Map(others.map((o) => [o.key, keep.key]));
  return { text: out, keyMap, added };
}

const CITE_MACROS = 'cite[a-zA-Z]*|parencite[s]?|textcite[s]?|autocite[s]?|footcite[s]?|smartcite[s]?|supercite|citeauthor|citeyear|citetitle|nocite|fullcite|footfullcite|citep|citet|citealp|citealt';
// renames keys in \cite{a,b}-like macros; returns { text, count }
function renameCiteKeys(text, keyMap) {
  let count = 0;
  const re = new RegExp('(\\\\(?:' + CITE_MACROS + ')\\*?(?:\\[[^\\]]*\\]){0,2}\\s*\\{)([^}]*)(\\})', 'g');
  const lines = text.split('\n').map((line) => {
    const code = codePart(line);
    if (!/\\/.test(code)) return line;
    const rest = line.slice(code.length);
    return code.replace(re, (all, a, keys, c) => {
      const out = keys.split(',').map((k) => {
        const t = k.trim();
        if (keyMap.has(t)) { count++; return k.replace(t, keyMap.get(t)); }
        return k;
      }).join(',');
      return a + out + c;
    }) + rest;
  });
  return { text: lines.join('\n'), count };
}

/* ============================ 7. CSV / TSV / XLSX -> tblr ===================== */
function detectDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const score = (d) => (head.match(new RegExp(d === '\t' ? '\t' : '\\' + d, 'g')) || []).length;
  const c = { '\t': score('\t'), ';': score(';'), ',': score(','), '|': score('|') };
  return Object.keys(c).sort((a, b) => c[b] - c[a])[0] && c[Object.keys(c).sort((a, b) => c[b] - c[a])[0]] > 0 ? Object.keys(c).sort((a, b) => c[b] - c[a])[0] : ',';
}

function parseCsv(text, delim) {
  const d = delim || detectDelimiter(text);
  const s = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
  const w = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => { while (r.length < w) r.push(''); return r; });
}

const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

// a .zip as a Buffer -> Map(name -> Buffer) of the entries (stored or deflated)
function unzip(buf) {
  const files = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('не схоже на .xlsx (немає кінця zip)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    files.set(name, method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

// the first sheet of an .xlsx: array of rows of strings (formulas give their cached values, dates stay serial numbers)
function readXlsx(buf) {
  const z = unzip(buf);
  const get = (n) => (z.get(n) ? z.get(n).toString('utf8') : '');
  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  const reSi = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = reSi.exec(sst)) !== null) {
    const parts = [];
    const reT = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = reT.exec(m[1])) !== null) parts.push(xmlUnescape(t[1]));
    shared.push(parts.join(''));
  }
  let sheetName = 'xl/worksheets/sheet1.xml';
  if (!z.has(sheetName)) sheetName = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw new Error('в .xlsx немає аркуша');
  const xml = get(sheetName);
  const rows = [];
  const reRow = /<row\b[^>]*?(?:\sr="(\d+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let r;
  let auto = 0;
  while ((r = reRow.exec(xml)) !== null) {
    const idx = r[1] ? +r[1] - 1 : auto;
    auto = idx + 1;
    const cells = [];
    const reC = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = reC.exec(r[2] || '')) !== null) {
      const attrs = c[1];
      const ref = /\sr="([A-Z]+\d+)"/.exec(' ' + attrs);
      const type = /\st="(\w+)"/.exec(' ' + attrs);
      const inner = c[2] || '';
      let val = '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (type && type[1] === 's' && v) val = shared[+v[1]] || '';
      else if (type && type[1] === 'inlineStr') val = xmlUnescape((/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner) || [, ''])[1]);
      else if (v) val = xmlUnescape(v[1]);
      const col = ref ? colIndex(ref[1]) : cells.length;
      while (cells.length <= col) cells.push('');
      cells[col] = val;
    }
    while (rows.length < idx) rows.push([]);
    rows.push(cells);
  }
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
  const w = Math.max(0, ...rows.map((x) => x.length));
  return rows.map((x) => { while (x.length < w) x.push(''); return x; });
}

function texEscape(s) {
  return String(s).trim().replace(/[\\&%$#_{}~^]/g, (c) => ({ '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }[c]));
}

// rows -> table with tblr. o: { caption, label, headerColor, header (bool), unit, floatEnv (bool), oddColor }
function buildTblr(rows, o) {
  const opt = Object.assign({ header: true, headerColor: 'themecolorlight', oddColor: 'gray!10', unit: '\t', floatEnv: true, align: 'auto', num: 'none' }, o);
  const u = opt.unit;
  const w = rows.length ? rows[0].length : 0;
  const numeric = (j) => rows.slice(opt.header ? 1 : 0).every((r) => r[j] === '' || /^[-+−]?\d+([.,]\d+)?$/.test(String(r[j]).trim()));
  const col = [];
  for (let j = 0; j < w; j++) col.push('X[' + (opt.align === 'auto' ? (j === 0 && !numeric(0) ? 'l' : 'c') : opt.align) + ',m]');
  const ind = opt.floatEnv ? u : '';
  const out = [];
  if (opt.floatEnv) {
    out.push('\\begin{table}[h!]');
    out.push(u + '\\caption{' + texEscape(opt.caption || '') + (opt.label ? '\\label{' + opt.label + '}' : '') + '}');
  }
  out.push(ind + '\\begin{tblr}{');
  out.push(ind + u + 'colspec={' + col.join('') + '},');
  out.push(ind + u + 'row{odd} = {' + opt.oddColor + '},');
  if (opt.header) out.push(ind + u + 'row{1} = {c, m, fg=white, bg=' + opt.headerColor + ', font=\\bfseries},');
  out.push(ind + u + 'hlines,');
  out.push(ind + u + 'vlines');
  out.push(ind + '}');
  const isNum = (v) => /^[-+−]?\d+([.,]\d+)?$/.test(String(v).trim());
  const cell = (v, ri) => {
    if ((!opt.header || ri > 0) && isNum(v)) {
      const t = String(v).trim().replace('−', '-');
      if (opt.num === 'num') return '\\num{' + t.replace(',', '.') + '}';
      if (opt.num === 'comma') return t.replace(/[.,]/, '{,}');
    }
    return texEscape(v);
  };
  rows.forEach((r, ri) => out.push(ind + u + r.map((v) => cell(v, ri)).join(' & ') + ' \\\\'));
  out.push(ind + '\\end{tblr}');
  if (opt.floatEnv) out.push('\\end{table}');
  return out.join('\n') + '\n';
}

/* ============================== 8. unused packages ============================ */
// package -> regex of what only that package provides. A package that is not in the table is never reported.
const PKG_USAGE = {
  tikz: /\\begin\{tikzpicture\}|\\tikz\b|\\tikzset|\\usetikzlibrary|\\localinput|\\draw\b|\\node\b|\\pgf[a-z]*/,
  pgfplots: /\\begin\{axis\}|\\addplot|\\pgfplotsset|\\begin\{(semilog|loglog)[xy]*axis\}/,
  circuitikz: /\\begin\{circuitikz\}|\\ctikzset/,
  tabularray: /\\begin\{(tblr|longtblr|talltblr)\}|\\SetCell|\\SetRow|\\SetColumn|\\SetHline|\\SetVline|\\NewTblrEnviron|\\DefTblrTemplate|\\UseTblrTemplate/,
  booktabs: /\\(toprule|midrule|bottomrule|cmidrule|addlinespace|specialrule)\b/,
  multirow: /\\multirow\b/,
  multicol: /\\begin\{multicols\*?\}|\\columnbreak/,
  graphicx: /\\(includegraphics|scalebox|resizebox|rotatebox|reflectbox|graphicspath|DeclareGraphicsExtensions)\b/,
  xcolor: /\\(color|textcolor|colorbox|fcolorbox|definecolor|colorlet|rowcolor|cellcolor|columncolor|pagecolor|ProvideColor)\b|!\s*\d+\b/,
  enumitem: /\\(setlist|newlist|setenumerate|setitemize)\b|\\begin\{(enumerate|itemize|description)\}\s*\[/,
  siunitx: /\\(SI|si|num|qty|unit|ang|SIrange|numrange|qtyrange|sisetup|DeclareSIUnit|numlist|SIlist|complexnum|tablenum)\b/,
  cancel: /\\(cancel|bcancel|xcancel|cancelto)\b/,
  mhchem: /\\(ce|cee|cesplit)\b/,
  listings: /\\begin\{lstlisting\}|\\lstinline|\\lstset|\\lstinputlisting|\\lstdefinelanguage/,
  minted: /\\begin\{minted\}|\\mint(inline)?\b|\\inputminted|\\setminted/,
  subcaption: /\\(subcaption|subcaptionbox|subref)\b|\\begin\{(subfigure|subtable)\}/,
  wrapfig: /\\begin\{(wrapfigure|wraptable)\}/,
  float: /\\(floatstyle|restylefloat|newfloat|floatname)\b|\\begin\{(figure|table)\*?\}\s*\[[^\]]*H/,
  soul: /\\(hl|ul|st|so|caps|soulaccent|setulcolor|setstcolor|sethlcolor)\b/,
  ulem: /\\(uline|uuline|uwave|sout|xout|dashuline|dotuline)\b/,
  algorithm2e: /\\begin\{algorithm\}|\\(SetAlgoLined|KwIn|KwOut|KwResult|uIf|eIf|If|ForEach|While)\b/,
  tcolorbox: /\\(tcbset|tcbuselibrary|newtcolorbox|tcbox|DeclareTColorBox|tcolorboxenvironment)\b|\\begin\{tcolorbox\}/,
  pdfpages: /\\includepdf\b/,
  longtable: /\\begin\{longtable\}|\\endhead|\\endfoot|\\endlastfoot|\\endfirsthead/,
  makecell: /\\(makecell|thead|Xhline|diagbox|multirowcell|Gape)\b/,
  threeparttable: /\\begin\{threeparttable\}|\\tnote\b/,
  adjustbox: /\\adjustbox\b|\\begin\{adjustbox\}|\\adjincludegraphics/,
  epigraph: /\\epigraph\b/,
  lipsum: /\\lipsum\b/,
  blindtext: /\\(blindtext|Blindtext|blindmathtrue|blindlistlist)\b/,
  comment: /\\begin\{comment\}|\\(includecomment|excludecomment|specialcomment)\b/,
  verbatim: /\\begin\{verbatim\*?\}|\\verbatiminput\b/,
  physics: /\\(dd|dv|pdv|qty|abs|norm|bra|ket|braket|ketbra|expval|ev|comm|acomm|grad|curl|laplacian|mqty|pmqty|bmqty|vb|vu|va|vqty|var|cov|mel|ip|op|matrixel|innerproduct|outerproduct|expectationvalue|commutator|poissonbracket|identitymatrix|imat|xmat|Det|rank|trace|Tr|tr|order|eval|fdv|Re|Im|principalvalue|PV|flatfrac|real|imaginary)\b/,
  bm: /\\(bm|boldsymbol|bmdefine|hm)\b/,
  mathtools: /\\(coloneqq|eqqcolon|DeclarePairedDelimiter|mathllap|mathrlap|mathclap|prescript|xrightarrow|xleftarrow|smashoperator|mathtoolsset|DeclarePairedDelimiterX|lparen|rparen|shortintertext|cramped)\b|\\begin\{(dcases|rcases|drcases|matrix\*|pmatrix\*|bmatrix\*|vmatrix\*|multlined|lgathered|rgathered|spreadlines)\}/,
  esint: /\\(oiint|oiiint|ointctrclockwise|varoiint|sqcap|iiiint|fint)\b/,
  hyperref: /\\(url|href|nolinkurl|hypersetup|hyperref|autoref|nameref|hypertarget|hyperlink|texorpdfstring|pdfbookmark|phantomsection)\b/,
  fancyhdr: /\\(fancyhead|fancyfoot|fancyhf|fancypagestyle|lhead|chead|rhead|lfoot|cfoot|rfoot|headrulewidth|footrulewidth)\b/,
  titlesec: /\\(titleformat|titlespacing|titleclass|assignpagestyle)\b/,
  tocloft: /\\(cftsetindents|cftpagenumbersoff|cftdot|cftsecfont|cftchapfont|setlength\{\\cft)/,
  csquotes: /\\(enquote|textquote|blockquote|foreignquote|MakeOuterQuote|DeclareQuoteStyle)\b/,
  amsthm: /\\(newtheorem|theoremstyle|swapnumbers|qedhere|qedsymbol)\b|\\begin\{(proof|theorem|lemma|definition|proposition|corollary|remark|example)\*?\}/,
  mathrsfs: /\\mathscr\b/,
  bbm: /\\mathbbm\b/,
  dsfont: /\\mathds\b/,
  upgreek: /\\up(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\b/,
  braket: /\\(bra|ket|braket|Bra|Ket|Braket|set|Set)\b/,
  empheq: /\\begin\{empheq\}|\\empheqset/,
  cleveref: /\\(cref|Cref|crefrange|Crefrange|cpageref|crefname|Crefname|creflabelformat|labelcref)\b/,
  xspace: /\\xspace\b/,
  ifthen: /\\(ifthenelse|newboolean|setboolean|boolean|whiledo|equal|isodd|lengthtest)\b/,
  fancyvrb: /\\begin\{(Verbatim|BVerbatim|LVerbatim)\*?\}|\\(VerbatimInput|fvset|DefineVerbatimEnvironment)\b/,
  rotating: /\\begin\{(sidewaystable|sidewaysfigure|turn|rotate)\*?\}|\\turnbox\b/,
  pdflscape: /\\begin\{landscape\}/,
  lscape: /\\begin\{landscape\}/,
  'tikz-cd': /\\begin\{tikzcd\}/,
  chemfig: /\\(chemfig|schemestart|chemname)\b/,
  chemformula: /\\(ch|setchemformula)\b/,
  xfrac: /\\sfrac\b/,
  nicefrac: /\\nicefrac\b/,
  units: /\\(unit|unitfrac)\b/,
  numprint: /\\(numprint|nprounddigits|npdecimalsign|npthousandsep)\b/,
  pgfplotstable: /\\(pgfplotstable|pgfplotstabletypeset|pgfplotstableread)\b/,
  glossaries: /\\(newglossaryentry|newacronym|gls|Gls|glspl|printglossar(y|ies)|makeglossaries|glsaddall)\b/,
  makeidx: /\\(makeindex|printindex|index)\b/,
  imakeidx: /\\(makeindex|printindex|index)\b/,
  enumerate: /\\begin\{enumerate\}\s*\[/,
  paralist: /\\begin\{(compactitem|compactenum|compactdesc|inparaenum|inparaitem|asparaenum|asparaitem)\}/,
  mdframed: /\\begin\{mdframed\}|\\(mdfsetup|newmdenv|surroundwithmdframed)\b/,
  framed: /\\begin\{(framed|shaded|leftbar|snugshade|oframed)\*?\}/,
  colortbl: /\\(columncolor|rowcolor|cellcolor|arrayrulecolor|doublerulesepcolor|rowcolors)\b/,
  arydshln: /\\(hdashline|cdashline|firsthdashline|lasthdashline)\b/,
  diagbox: /\\diagbox\b/,
  setspace: /\\(onehalfspacing|doublespacing|singlespacing|setstretch|spacing|SetSinglespace)\b|\\begin\{(spacing|singlespace|doublespace|onehalfspace)\}/,
  lastpage: /\\pageref\{LastPage\}|\\lastpage\b/,
  biblatex: /\\(printbibliography|addbibresource|autocite|parencite|textcite|footcite|DeclareBibliographyCategory|printbibheading)\b/
};

// [{ pkg, line, col, len, file }] from \usepackage[...]{a,b} / \RequirePackage
function findPackages(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const code = codePart(line);
    const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      let off = m.index + m[0].lastIndexOf('{') + 1;
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (t) out.push({ pkg: t, line: i, col: off + (part.length - part.trimStart().length), len: t.length });
        off += part.length + 1;
      }
    }
  });
  return out;
}

// the edit that removes package `pkg` from a line with \usepackage / \RequirePackage:
// { kind: 'line' } (the line held only this package: delete it), { kind: 'text', col, len, newText } or null
function removePackageEdit(line, pkg) {
  const code = codePart(line);
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const parts = m[1].split(',').map((p) => p.trim()).filter(Boolean);
    if (!parts.includes(pkg)) continue;
    const rest = parts.filter((p) => p !== pkg);
    if (!rest.length) {
      const before = line.slice(0, m.index).trim();
      const after = line.slice(m.index + m[0].length).trim();
      if (!before && (!after || after.startsWith('%'))) return { kind: 'line' };
      return { kind: 'text', col: m.index, len: m[0].length, newText: '' };
    }
    const open = m.index + m[0].lastIndexOf('{') + 1;
    return { kind: 'text', col: open, len: m[1].length, newText: rest.join(',') };
  }
  return null;
}

// files: [{ path, lines }]. -> { unused: [{ pkg, path, line, col }], checked, skipped }
function unusedPackages(files) {
  const bodies = files.map((f) => f.lines.map((l) => (/\\(?:usepackage|RequirePackage)\b/.test(l) ? '' : codePart(l))).join('\n')).join('\n');
  const unused = [];
  let checked = 0;
  let skipped = 0;
  const seen = new Set();
  for (const f of files) {
    for (const p of findPackages(f.lines)) {
      const rule = PKG_USAGE[p.pkg];
      if (!rule) { if (!seen.has(p.pkg)) skipped++; seen.add(p.pkg); continue; }
      if (!seen.has(p.pkg)) checked++;
      seen.add(p.pkg);
      if (!rule.test(bodies)) unused.push({ pkg: p.pkg, path: f.path, line: p.line, col: p.col });
    }
  }
  return { unused, checked, skipped };
}

/* ================================= 9. equations =============================== */
const EQ_ENVS = ['equation', 'align', 'gather', 'multline', 'flalign', 'alignat', 'eqnarray', 'displaymath'];

// numbered display formulas: [{ env, starred, line, endLine, labels: [name], rows, snippet }]
function scanEquations(lines) {
  const out = [];
  const reBegin = new RegExp('\\\\begin\\{(' + EQ_ENVS.join('|') + ')(\\*?)\\}');
  for (let i = 0; i < lines.length; i++) {
    const code = codePart(lines[i]);
    const m = reBegin.exec(code);
    if (!m) continue;
    const env = m[1];
    const starred = m[2] === '*';
    let j = i;
    const body = [];
    const tail = code.slice(m.index + m[0].length);
    body.push(tail);
    let closed = new RegExp('\\\\end\\{' + env + escRe(m[2]) + '\\}').test(tail);
    while (!closed && j + 1 < lines.length) {
      j++;
      const c = codePart(lines[j]);
      body.push(c);
      if (new RegExp('\\\\end\\{' + env + escRe(m[2]) + '\\}').test(c)) closed = true;
    }
    const text = body.join('\n').replace(new RegExp('\\\\end\\{' + env + escRe(m[2]) + '\\}[\\s\\S]*$'), '');
    const labels = [];
    const re = /\\label\s*\{([^}]*)\}/g;
    let l;
    while ((l = re.exec(text)) !== null) labels.push(l[1].trim());
    const rowParts = text.split(/\\\\(?:\[[^\]]*\])?/);
    const real = rowParts.filter((r) => r.replace(/\\(label|nonumber|notag|tag\*?)\s*(\{[^}]*\})?/g, '').trim());
    const rows = real.length;
    // numbered rows: not \nonumber / \notag / \tag; the row index of each label among them
    let numbered = 0;
    const labelRows = [];
    rowParts.forEach((r) => {
      if (!r.replace(/\\(label|nonumber|notag|tag\*?)\s*(\{[^}]*\})?/g, '').trim()) return;
      const skip = /\\(nonumber|notag)\b|\\tag\*?\s*\{/.test(r);
      const idx = skip ? -1 : numbered;
      const re2 = /\\label\s*\{([^}]*)\}/g;
      let l2;
      while ((l2 = re2.exec(r)) !== null) labelRows.push({ name: l2[1].trim(), row: idx });
      if (!skip) numbered++;
    });
    const snippet = text.replace(/\\label\s*\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
    out.push({ env, starred, line: i, endLine: j, labels, rows: Math.max(1, rows), numbered: env === 'equation' ? (/\\(nonumber|notag)\b/.test(text) ? 0 : 1) : numbered, labelRows, snippet });
    i = j;
  }
  return out;
}

// numbers of the formulas of one file in order. aux(name) -> '2.3' | null. Unlabelled formulas count from the nearest labelled one:
// [{ start, end, approx }] (start / end = '2.3' or null)
function eqNumbers(eqs, aux) {
  const split = (n) => { const m = /^(.*?)(\d+)$/.exec(String(n)); return m ? { pre: m[1], n: +m[2] } : null; };
  const anchor = eqs.map((q) => {
    for (const l of q.labelRows || []) {
      if (l.row < 0) continue;
      const p = split(aux(l.name) || '');
      if (p) return { pre: p.pre, start: p.n - l.row };
    }
    return null;
  });
  return eqs.map((q, i) => {
    if (!q.numbered) return { start: null, end: null, approx: false, none: true };
    let a = anchor[i];
    let approx = false;
    if (!a) {
      approx = true;
      let sum = 0;
      for (let k = i - 1; k >= 0; k--) { sum += eqs[k].numbered; if (anchor[k]) { a = { pre: anchor[k].pre, start: anchor[k].start + sum }; break; } }
      if (!a) {
        sum = 0;
        for (let k = i; k < eqs.length; k++) { if (k > i) sum += eqs[k - 1].numbered; if (k > i && anchor[k]) { a = { pre: anchor[k].pre, start: anchor[k].start - sum }; break; } }
        if (a && a.start < 1) a = null;
      }
    }
    if (!a) return { start: null, end: null, approx: true };
    return { start: a.pre + a.start, end: a.pre + (a.start + q.numbered - 1), approx };
  });
}

/* =============================== 10. dated PDF name =========================== */
const pad2 = (n) => String(n).padStart(2, '0');
function datedName(base, d, withTime) {
  const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  return base + '_' + date + (withTime ? '_' + pad2(d.getHours()) + pad2(d.getMinutes()) : '') + '.pdf';
}

module.exports = {
  renameSelfRefs, labelContext, renameLabelEdits, removePackageEdit, eqNumbers, mergeBibGroup,
  DEFAULT_FILE_MACROS, LEGACY_MACROS, DEFAULT_ROOT_MACROS, fileMacroTable, findFileRefs, resolveRef, checkFileRefs, basesFor, candidates,
  renameRefs, missingFilesFromLog, tlmgrCommands, TL_MAP,
  scanLabels, scanRefs, buildLabelIndex, refText, labelKind,
  countWords,
  parseBib, formatBib, bibDuplicates, bibKeyMap, renameCiteKeys, fieldValue, toAscii,
  parseCsv, detectDelimiter, readXlsx, unzip, buildTblr, texEscape,
  PKG_USAGE, findPackages, unusedPackages,
  scanEquations, datedName, codePart, posix
};
