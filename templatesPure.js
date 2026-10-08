'use strict';
/* Pure helpers of TSS Workflow 0.4.0 (no VS Code API): document templates in the style of TeXstudio
 * ("New from template", "Make template", "Manage templates"). A template is one .tex or .tikz file;
 * its name is the file name, an optional description and kind (document | fragment) are kept in leading
 * `% !TSS description: ...` / `% !TSS kind: ...` lines. A folder with a main file is a template of several files. */
const X = require('./authoringPure');

const TEMPLATE_EXT = ['.tex', '.tikz'];
const META_RE = /^\s*%\s*!TSS\s+([A-Za-z]+)\s*:\s*(.*?)\s*$/;

/* ------------------------------ read / write ------------------------------ */
// splits a file into meta lines (`% !TSS name: ...`, `% !TSS description: ...`) and the body
function parseTemplate(text, fileName) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const meta = {};
  let i = 0;
  while (i < lines.length) {
    const m = META_RE.exec(lines[i]);
    if (!m) break;
    meta[m[1].toLowerCase()] = m[2];
    i++;
  }
  const base = String(fileName || '').replace(/\.[^.\\/]+$/, '');
  return {
    name: (meta.name || '').trim() || base,
    description: (meta.description || '').trim(),
    kind: /^fragment$/i.test((meta.kind || '').trim()) ? 'fragment' : 'document',
    body: lines.slice(i).join('\n')
  };
}

// text of a template file: a description line (if any) + body without the old meta lines
function buildTemplate(text, description, kind) {
  const body = parseTemplate(text, '').body;
  const d = String(description || '').replace(/\s+/g, ' ').trim();
  return (d ? '% !TSS description: ' + d + '\n' : '') + (kind === 'fragment' ? '% !TSS kind: fragment\n' : '') + body;
}

/* --------------------------------- names ---------------------------------- */
// a file name without characters Windows/macOS/Linux reject; '' when nothing usable is left
function sanitizeName(s) {
  let n = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(n)) n = '';
  return n;
}

// a free name `base` among `existing` (names without extension, case-insensitive like Windows)
function uniqueName(existing, base) {
  const have = new Set(existing.map((x) => String(x).toLowerCase()));
  let n = base;
  let i = 1;
  while (have.has(n.toLowerCase())) { i++; n = base + ' ' + i; }
  return n;
}

function isTemplateFile(fileName) {
  const m = /\.[^.]+$/.exec(String(fileName));
  return !!m && TEMPLATE_EXT.includes(m[0].toLowerCase());
}

/* ------------------------------ placeholders ------------------------------ */
const pad = (x) => String(x).padStart(2, '0');

// ${date} 2026-10-05, ${year}, ${time} 14:30, ${author}; ${title} is asked by the command
function builtinVars(now, author) {
  return {
    date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
    year: String(now.getFullYear()),
    time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    author: author || ''
  };
}

function usesVar(body, name) {
  return new RegExp('\\$\\{' + String(name).replace(/[^\w]/g, '') + '\\}').test(String(body));
}

// fills the placeholders; the first ${cursor} gives the caret position, the others vanish.
// Unknown placeholders stay as they are.
function applyTemplate(body, vars) {
  const v = Object.assign({}, vars, { cursor: '' });
  const parts = String(body).split('${cursor}');
  const before = X.fillTemplate(parts[0], v);
  const text = before + (parts.length > 1 ? X.fillTemplate(parts.slice(1).join(''), v) : '');
  if (parts.length < 2) return { text, cursor: null };
  const head = before.split('\n');
  return { text, cursor: { line: head.length - 1, character: head[head.length - 1].length } };
}

/* ----------------------- variables asked from the user ---------------------- */
// ${ask:group} or ${ask:group:default value}: the user is asked once per name; later ${group} uses the answer
const ASK_RE = /\$\{ask:([A-Za-z_]\w*)(?::([^}]*))?\}/g;

function askSpecs(body) {
  const out = [];
  const seen = new Set();
  String(body).replace(ASK_RE, (m, name, def) => {
    if (!seen.has(name)) { seen.add(name); out.push({ name, def: def === undefined ? '' : def }); }
    return m;
  });
  return out;
}

// every ${ask:name...} becomes ${name}
function resolveAsks(body) {
  return String(body).replace(ASK_RE, (m, name) => '${' + name + '}');
}

/* ------------------------------ insert a fragment --------------------------- */
// the text and the caret of a fragment inserted at `start` ({line, character}); the lines after the first get the
// indent of the line where it is inserted. `cursor` is the {line, character} inside the fragment (or null).
function insertResult(text, cursor, start, indent) {
  const ind = indent || '';
  const lines = String(text).split('\n');
  const out = lines.map((l, i) => (i > 0 && l.length ? ind + l : l)).join('\n');
  let c = null;
  if (cursor) {
    const lineLen = (i) => (i > 0 && lines[i].length ? ind.length : 0);
    c = cursor.line === 0
      ? { line: start.line, character: start.character + cursor.character }
      : { line: start.line + cursor.line, character: cursor.character + lineLen(cursor.line) };
  }
  return { text: out, cursor: c };
}

/* ------------------------- templates of several files ----------------------- */
const TEXT_EXT = ['.tex', '.tikz', '.bib', '.cls', '.sty', '.bst', '.txt', '.md', '.json', '.cfg', '.def'];
const isTextFile = (f) => TEXT_EXT.includes((/\.[^.\\/]+$/.exec(String(f)) || [''])[0].toLowerCase());

// the main file of a template folder: <folder>.tex, then main.tex, template.tex, else the only .tex file
function pickMainFile(files, dirName) {
  const tex = files.filter((f) => /\.tex$/i.test(f));
  const at = (name) => tex.find((f) => f.toLowerCase() === name.toLowerCase());
  return at(dirName + '.tex') || at('main.tex') || at('template.tex') || (tex.length === 1 ? tex[0] : null);
}

// what is created from a folder template: the main file becomes <newStem>.tex, the rest keeps its relative path
function planCopy(files, mainFile, newStem) {
  return files.map((f) => {
    const isMain = f === mainFile;
    const ext = (/\.[^.\\/]+$/.exec(f) || [''])[0];
    return { from: f, to: isMain ? newStem + ext : f, main: isMain, text: isTextFile(f) };
  });
}

/* -------------------------------- listing --------------------------------- */
const SOURCE_ORDER = { project: 0, user: 1, builtin: 2 };

// project templates first, then the user's, then the built-in ones; by name inside each group
function sortTemplates(list) {
  return list.slice().sort((a, b) =>
    (SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]) || a.name.localeCompare(b.name, 'uk'));
}

module.exports = {
  TEMPLATE_EXT, parseTemplate, buildTemplate, sanitizeName, uniqueName, isTemplateFile,
  builtinVars, usesVar, applyTemplate, sortTemplates,
  askSpecs, resolveAsks, insertResult, isTextFile, pickMainFile, planCopy
};
